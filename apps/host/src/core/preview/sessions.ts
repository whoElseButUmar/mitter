import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import {
  previewStartResultSchema,
  type PreviewStartResult,
  type PreviewElement,
} from '../../../../../packages/protocol/src/rpc.js';
import type { TaskBoundary } from '../../../../../packages/protocol/src/index.js';
import { snapshotApp, staticPreviewFingerprint } from './snapshot.js';
import { serveSnapshot, type PreviewServer } from './server.js';
import { detectDevProject, devProjectFingerprint, startDevServer } from '../dev-server/index.js';
import { serveDevPreview } from './dev-proxy.js';
import { Locks } from '../locks.js';
import { errorMessage } from '../types.js';
import { ensurePrivateDirectory } from '../private-directory.js';
import { AppRuns, type AppRun } from './app-runs.js';
import { pickPreviewElement } from './element-picker.js';

const IDLE_TIMEOUT_MS = 1_800_000;
const MAX_SESSIONS = 4;
const MAX_PENDING = 2;
type StartOptions = {
  attach?: boolean;
  restart?: boolean;
  replacePreviewId?: string;
  fingerprint?: string;
  staticEntry?: string;
  staticFingerprint?: string;
  signal?: AbortSignal;
  withProjectLock?: (
    signal: AbortSignal,
    open: () => Promise<PreviewStartResult>,
  ) => Promise<PreviewStartResult>;
};
type Pending = { run: AppRun; controller: AbortController; result: Promise<PreviewStartResult> };

type Session = {
  run: AppRun;
  closing?: Promise<void>;
  picker?: { controller: AbortController; done: Promise<PreviewElement> };
  server: PreviewServer;
  result: PreviewStartResult;
  fingerprint?: string;
};

export class PreviewSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Pending>();
  readonly runs = new AppRuns();
  private readonly controller = new AbortController();
  private readonly publication = new Locks();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly dataRoot?: string,
    private readonly picker = pickPreviewElement,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private current(workerId: string, boundary: TaskBoundary) {
    return [...this.sessions.values()].find(
      (item) =>
        item.run.workerId === workerId &&
        item.run.expectedRun.runId === boundary.runId &&
        item.run.expectedRun.epoch === boundary.epoch,
    );
  }

  status(workerId: string, boundary: TaskBoundary) {
    return { preview: this.current(workerId, boundary)?.result ?? null };
  }

  assertRunning(workerId: string, boundary: TaskBoundary, previewId: string) {
    const session = this.sessions.get(previewId);
    if (
      !session ||
      session.closing ||
      session.run.state !== 'running' ||
      session.run.workerId !== workerId ||
      session.run.expectedRun.runId !== boundary.runId ||
      session.run.expectedRun.epoch !== boundary.epoch
    ) {
      throw new Error('That app session has stopped or changed. Open the current running app.');
    }
    this.signal.throwIfAborted();
    return session;
  }

  pickElement(workerId: string, boundary: TaskBoundary, previewId: string) {
    const session = this.assertRunning(workerId, boundary, previewId);
    if (session.picker) {
      throw new Error('An element picker is already open for this app.');
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([this.signal, controller.signal]);
    const done = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return this.picker(session.result.url, signal);
      })
      .then((element) => {
        signal.throwIfAborted();
        return element;
      })
      .finally(() => {
        delete session.picker;
      });
    session.picker = { controller, done };
    return done;
  }

  cancelPick(workerId: string, boundary: TaskBoundary, previewId: string) {
    return this.closePicker(this.assertRunning(workerId, boundary, previewId));
  }

  stopPicking(workerId: string, boundary: TaskBoundary) {
    return this.closePicker(this.current(workerId, boundary));
  }

  private async closePicker(session: Session | undefined) {
    const active = session?.picker;
    if (!active) {
      return { cancelled: false };
    }
    active.controller.abort(new Error('Element selection cancelled.'));
    await active.done.catch(() => {});
    return { cancelled: true };
  }

  start(
    workerId: string,
    boundary: TaskBoundary,
    root: string,
    assertCurrent: () => void,
    options: StartOptions = {},
  ): Promise<PreviewStartResult> {
    this.signal.throwIfAborted();
    options.signal?.throwIfAborted();
    assertCurrent();
    const verifiedFingerprint = options.staticFingerprint ?? options.fingerprint;
    const active = this.pending.get(workerId);
    if (active) {
      if (
        (options.attach || verifiedFingerprint) &&
        !active.controller.signal.aborted &&
        active.run.expectedRun.runId === boundary.runId &&
        active.run.expectedRun.epoch === boundary.epoch
      ) {
        return active.result.then((result) => {
          assertCurrent();
          const session = this.sessions.get(result.previewId);
          if (
            verifiedFingerprint &&
            (!session || session.closing || session.fingerprint !== verifiedFingerprint)
          ) {
            throw new Error('The running app differs from the verified project. Select the current session.');
          }
          return result;
        });
      }
      return Promise.reject(new Error('This preview is already opening. Wait for that request to finish.'));
    }
    const previous = this.current(workerId, boundary);
    if (
      options.replacePreviewId &&
      (!previous || previous.run.previewId !== options.replacePreviewId || previous.closing)
    ) {
      return Promise.reject(
        new Error('That app session has stopped or been replaced. Select the current session.'),
      );
    }
    if (options.attach && previous && !previous.closing) {
      return Promise.resolve(previous.result);
    }
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(new Error('Two previews are being prepared. Wait for one to finish.'));
    }
    const run = this.runs.begin(randomBytes(16).toString('hex'), workerId, boundary);
    const preparation = new AbortController();
    const cancelled = () => preparation.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', cancelled, { once: true });
    // A published app belongs to the host, even after the task that opened it finishes.
    const signal = AbortSignal.any([this.signal, preparation.signal]);
    const open = () => this.open(run, root, assertCurrent, signal, options);
    const result = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        if (options.withProjectLock) {
          return options.withProjectLock(signal, open);
        }
        return open();
      })
      .catch((error: unknown) => {
        if (signal.aborted) {
          this.runs.finish(run, 'stopped', 'App startup stopped.');
        } else {
          this.runs.finish(run, 'failed', errorMessage(error));
        }
        throw error;
      })
      .finally(() => {
        options.signal?.removeEventListener('abort', cancelled);
        if (this.pending.get(workerId)?.run === run) {
          this.pending.delete(workerId);
        }
        this.releaseIdleTimer();
      });
    this.pending.set(workerId, { run, controller: preparation, result });
    return result;
  }

  private async open(
    run: AppRun,
    root: string,
    assertCurrent: () => void,
    signal: AbortSignal,
    options: StartOptions,
  ): Promise<PreviewStartResult> {
    assertCurrent();
    const { workerId, expectedRun: boundary, previewId } = run;
    const log = (line: string) => this.runs.write(run, line);
    const { fingerprint } = options;
    const previous = this.current(workerId, boundary);
    if (!options.staticFingerprint && previous?.result.framework && !previous.closing && !options.restart) {
      const desired = fingerprint ?? (await devProjectFingerprint(root, signal));
      signal.throwIfAborted();
      assertCurrent();
      if (
        !previous.closing &&
        previous.fingerprint === desired &&
        this.current(workerId, boundary) === previous
      ) {
        this.runs.discard(run);
        return previous.result;
      }
    }
    const framework = await detectDevProject(root);
    signal.throwIfAborted();
    assertCurrent();
    const hostname = 'miter-' + randomBytes(16).toString('hex') + '.localhost';
    let server: PreviewServer;
    let files: number;
    let bytes: number;
    let captured: string | undefined;
    let detail: string;
    const projectStore = path.join('preview-data', createHash('sha256').update(root).digest('hex'));
    if (framework) {
      if (options.staticFingerprint) {
        throw new Error('The verified static app has changed. Choose Run to start the current project.');
      }
      let projectDataDir: string | undefined;
      if (this.dataRoot) {
        projectDataDir = path.join(await fs.realpath(this.dataRoot), projectStore);
        await ensurePrivateDirectory(path.dirname(projectDataDir));
      }
      const runtime = await startDevServer(root, signal, 'development', log, projectDataDir);
      try {
        signal.throwIfAborted();
        assertCurrent();
        if (fingerprint && fingerprint !== runtime.fingerprint) {
          throw new Error('The project changed after verification. Choose Run to start the current project.');
        }
        server = await serveDevPreview(runtime, hostname, previewId, async (stop) => {
          const lifetime = AbortSignal.any([this.signal, stop]);
          log('The dev server exited. Restarting it once.\n');
          const retry = await startDevServer(root, lifetime, 'development', log, projectDataDir).catch(
            (error: unknown) => {
              if (!lifetime.aborted) {
                log('Restart failed: ' + errorMessage(error) + '\n');
              }
              throw error;
            },
          );
          try {
            assertCurrent();
            lifetime.throwIfAborted();
            if (retry.framework !== runtime.framework || retry.fingerprint !== runtime.fingerprint) {
              throw new Error('The project changed. Reopen its preview to run the new source.');
            }
          } catch (error) {
            await retry.close();
            throw error;
          }
          log('Dev server restarted.\n');
          return retry;
        });
      } catch (error) {
        await runtime.close();
        throw error;
      }
      files = runtime.files;
      bytes = runtime.bytes;
      captured = runtime.fingerprint;
      detail =
        'The project’s pnpm dev server is running on this Mac. Restart to pick up project changes. Miter stops the server after 30 idle minutes or when the helper closes.';
      if (runtime.portableCompilers?.length) {
        detail += ' macOS blocked a native compiler, so Miter used its portable implementation.';
      }
    } else {
      if (fingerprint) {
        throw new Error('The verified framework project has changed. Open the current project to review it.');
      }
      const snapshot = await snapshotApp(root, signal, options.staticEntry);
      captured = staticPreviewFingerprint(snapshot);
      if (options.staticFingerprint && options.staticFingerprint !== captured) {
        throw new Error('The project changed after verification. Choose Run to start the current project.');
      }
      if (
        options.staticFingerprint &&
        previous &&
        !previous.closing &&
        previous.fingerprint === captured &&
        !previous.result.framework
      ) {
        signal.throwIfAborted();
        assertCurrent();
        this.runs.discard(run);
        return previous.result;
      }
      signal.throwIfAborted();
      assertCurrent();
      let backendOptions;
      if (snapshot.backend && this.dataRoot) {
        backendOptions = { dataDir: path.join(this.dataRoot, projectStore) };
      }
      if (snapshot.backend) {
        log('Starting the project’s Node backend.\n');
      }
      server = await serveSnapshot(
        snapshot,
        hostname,
        previewId,
        backendOptions,
        (method, resource, status) => {
          log(method + ' ' + resource + ' ' + status + '\n');
        },
      );
      files = snapshot.assets.size;
      bytes = snapshot.bytes;
      let mode = 'Static assets only.';
      if (snapshot.backend) {
        mode = 'The app backend is running. Server data is saved for this project.';
      }
      detail =
        'Temporary local preview. A new preview has separate browser data; the server closes after 30 minutes without asset requests or when Miter closes. The latest four previews are retained. ' +
        mode;
    }
    try {
      signal.throwIfAborted();
      assertCurrent();
      const result = previewStartResultSchema.parse({
        previewId,
        url: server.url,
        files,
        bytes,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        detail,
        ...(framework && { framework }),
      });
      await this.publication.using('previews', signal, async () => {
        assertCurrent();
        let previous = [...this.sessions].find(([, session]) => session.run.workerId === workerId);
        if (options.replacePreviewId && previous?.[0] !== options.replacePreviewId) {
          throw new Error('That app session stopped while its replacement was starting.');
        }
        if (!previous && this.sessions.size >= MAX_SESSIONS) {
          previous = this.sessions.entries().next().value;
        }
        if (previous) {
          let reason = 'App stopped to make room for another session.';
          if (previous[1].run.workerId === workerId) {
            reason = 'App replaced by a new session.';
          }
          await this.terminate(previous[1], 'stopped', reason);
        }
        signal.throwIfAborted();
        assertCurrent();
        log('Serving ' + files + ' project files. Choose Open app in this session.\n');
        run.state = 'running';
        run.url = server.url;
        const session: Session = {
          run,
          server,
          result,
          ...(captured && { fingerprint: captured }),
        };
        this.sessions.set(previewId, session);
        if (server.exited) {
          const release = () => this.terminate(session, 'failed', 'The app server exited.').catch(() => {});
          void server.exited.then(release, release);
        }
        if (!this.timer) {
          this.timer = setInterval(() => {
            void this.expire().catch(() => {
              // Failed closes retain their session for the next expiry pass and shutdown.
            });
          }, 60_000);
          this.timer.unref();
        }
      });
      return result;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  async stop(workerId: string, previewId: string, expectedRun?: TaskBoundary): Promise<{ stopped: boolean }> {
    const pending = this.pending.get(workerId);
    const session = this.sessions.get(previewId);
    let run = session?.run;
    if (pending?.run.previewId === previewId) {
      run = pending.run;
    }
    if (!run || run.workerId !== workerId) {
      return { stopped: false };
    }
    if (
      expectedRun &&
      (expectedRun.runId !== run.expectedRun.runId || expectedRun.epoch !== run.expectedRun.epoch)
    ) {
      throw new Error('This preview belongs to a different task run.');
    }
    if (session) {
      await this.terminate(session, 'stopped', 'App stopped.');
    } else if (pending && pending.run === run) {
      pending.controller.abort(new Error('App startup stopped.'));
      await pending.result.catch(() => {});
    }
    return { stopped: true };
  }

  private terminate(session: Session, state: 'stopped' | 'failed', reason: string): Promise<void> {
    if (!session.closing) {
      session.closing = this.closePicker(session)
        .then(() => session.server.close())
        .then(() => {
          this.runs.finish(session.run, state, reason);
          this.sessions.delete(session.run.previewId);
          this.releaseIdleTimer();
        })
        .catch((error: unknown) => {
          delete session.closing;
          throw error;
        });
    }
    return session.closing;
  }

  async expire(now = Date.now()): Promise<void> {
    for (const session of this.sessions.values()) {
      if (now - session.server.lastRequest() >= IDLE_TIMEOUT_MS) {
        await this.terminate(session, 'stopped', 'App stopped after 30 minutes of inactivity.');
      }
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.controller.abort(new Error('Miter is closing its static previews.'));
      clearInterval(this.timer);
      this.timer = undefined;
      this.closing = this.drain();
    }
    return this.closing;
  }

  private releaseIdleTimer(): void {
    if (this.sessions.size === 0 && this.pending.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async drain(): Promise<void> {
    await Promise.allSettled([...this.pending.values()].map((pending) => pending.result));
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((session) =>
        this.terminate(session, 'stopped', 'Local helper stopped.'),
      ),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      this.closing = undefined;
      throw failure.reason;
    }
  }
}
