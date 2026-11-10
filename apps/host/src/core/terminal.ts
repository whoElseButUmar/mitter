import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadPtyRuntime } from './pty-runtime.js';
import type { Snapshot } from '../../../../packages/protocol/src/index.js';
import type { TerminalInfo } from '../../../../packages/terminal/src/protocol.js';
import { terminalRequestSchema } from './terminal/requests.js';
import { terminalLaunch } from './terminal/launch.js';
import { appendTerminalOutput, readTerminalOutput } from './terminal/session-buffer.js';
import type { TerminalSession } from './terminal/session-buffer.js';
import type { PtyFactory, PtySubscription } from './terminal/pty-adapter.js';
import { errorMessage } from './types.js';

export type { PtyProcess, PtyFactory } from './terminal/pty-adapter.js';

type ManagedTerminalSession = TerminalSession & {
  cleanupFailures: unknown[];
  cleanupInProgress: boolean;
};

function terminalCleanupError(message: string, failures: unknown[]): AggregateError {
  const causes = [...new Set(failures)];
  const details = causes.map(errorMessage).join('; ');

  return new AggregateError(causes, message + ': ' + details);
}

/** Real PTYs live only in this host. Their bounded buffers never enter worker
 * snapshots, reports, logs or SQLite. The model has no terminal capability. */

export class TerminalManager {
  private sessions = new Map<string, ManagedTerminalSession>();
  private loading: Promise<PtyFactory> | undefined = undefined;
  private disposed = false;
  private creating = 0;

  constructor(
    private snapshot: () => Snapshot,
    private load: () => Promise<PtyFactory> = loadPtyRuntime,
  ) {}

  async dispatch(method: string, raw: unknown): Promise<unknown> {
    if (this.disposed) {
      throw new Error('The terminal host is closed.');
    }

    const request = terminalRequestSchema.parse({
      method,
      params: raw,
    });
    const clientId = request.params.clientId;

    switch (request.method) {
      case 'terminal.list': {
        return this.list(clientId, request.params.projectId);
      }
      case 'terminal.create': {
        const params = request.params;

        return this.create(clientId, params.projectId, params.workerId, params.cols, params.rows);
      }
      case 'terminal.attach': {
        return this.attach(clientId, request.params.sessionId);
      }
      case 'terminal.read': {
        const session = this.owned(clientId, request.params.sessionId);

        return readTerminalOutput(session, request.params.after);
      }
      case 'terminal.write': {
        const session = this.owned(clientId, request.params.sessionId);

        if (session.info.exited) {
          throw new Error('This shell has exited. Open a new terminal.');
        }

        // Raw human input, including controls, goes directly to the PTY.
        session.pty.write(request.params.data);

        return {
          written: true,
        };
      }
      case 'terminal.resize': {
        const params = request.params;
        const session = this.owned(clientId, params.sessionId);

        if (!session.info.exited) {
          session.pty.resize(params.cols, params.rows);
        }
        session.info.cols = params.cols;
        session.info.rows = params.rows;

        return {
          resized: true,
        };
      }
      case 'terminal.close': {
        const session = this.owned(clientId, request.params.sessionId);
        const failures = this.closeSession(session);

        if (failures.length) {
          throw terminalCleanupError(
            `Terminal ${session.info.id} (PID ${session.info.pid}) could not close cleanly`,
            failures,
          );
        }

        return {
          closed: true,
        };
      }
      case 'terminal.release': {
        this.owned(clientId, request.params.sessionId).owner = undefined;

        return {
          released: true,
        };
      }
      case 'terminal.disconnect': {
        for (const session of this.sessions.values()) {
          if (session.owner === clientId) {
            session.owner = undefined;
          }
        }

        return {
          released: true,
        };
      }
    }
  }

  private list(clientId: string, projectId?: string): TerminalInfo[] {
    return [...this.sessions.values()]
      .filter((session) => !session.closed && (!projectId || session.info.projectId === projectId))
      .map((session) => ({
        ...session.info,
        owned: session.owner === clientId,
        occupied: !!session.owner && session.owner !== clientId,
      }));
  }

  private owned(clientId: string, id: string): ManagedTerminalSession {
    const session = this.sessions.get(id);

    if (!session || session.closed) {
      throw new Error('This terminal no longer exists.');
    }

    if (session.owner !== clientId) {
      throw new Error('This terminal is attached to another view. Close or release that view first.');
    }

    return session;
  }

  private async create(
    clientId: string,
    projectId: string,
    workerId: string | undefined,
    cols: number,
    rows: number,
  ): Promise<TerminalInfo> {
    if (this.sessions.size + this.creating >= 8) {
      throw new Error('Close a terminal before opening another (maximum 8).');
    }
    this.creating++;

    try {
      const launch = await terminalLaunch(this.snapshot(), projectId, workerId, cols, rows);
      const factory = await (this.loading ??= this.load().catch((error) => {
        this.loading = undefined;

        throw error;
      }));

      if (this.disposed) {
        throw new Error('The terminal host closed while starting.');
      }

      const pty = factory.spawn(launch.shell, launch.args, launch.options);
      const id = randomUUID();
      const session: ManagedTerminalSession = {
        info: {
          id,
          projectId,
          workerId,
          title: path.basename(launch.shell),
          cwd: launch.options.cwd,
          shell: launch.shell,
          pid: pty.pid,
          cols,
          rows,
          createdAt: Date.now(),
          exited: false,
          paused: false,
        },
        pty,
        owner: clientId,
        frames: [],
        next: 0,
        ack: 0,
        delivered: 0,
        bytes: 0,
        subscriptions: [],
        cleanupFailures: [],
        cleanupInProgress: false,
        outputStopped: false,
        closed: false,
      };
      this.sessions.set(id, session);

      try {
        session.subscriptions.push(pty.onData((data) => appendTerminalOutput(session, data)));
        session.subscriptions.push(
          pty.onExit((event) => {
            session.info.exited = true;
            session.info.exitCode = event.exitCode;
            session.info.paused = false;

            // A kill/dispose call may emit exit synchronously; its batch owns the subscriptions.
            if (session.closed && !session.cleanupInProgress) {
              this.closeSession(session);
            }
          }),
        );
      } catch (error) {
        const failures: unknown[] = [error];
        session.closed = true;
        session.cleanupInProgress = true;

        try {
          failures.push(...this.disposeSubscriptions(session));
          failures.push(...this.closeSession(session));
        } finally {
          session.cleanupInProgress = false;
        }

        throw terminalCleanupError(
          `Terminal event setup failed (PID ${session.info.pid}). No shell was retried`,
          failures,
        );
      }

      return {
        ...session.info,
        owned: true,
        occupied: false,
      };
    } finally {
      this.creating--;
    }
  }

  private attach(clientId: string, id: string): TerminalInfo {
    const session = this.sessions.get(id);

    if (!session || session.closed) {
      throw new Error('This terminal no longer exists.');
    }

    if (session.owner && session.owner !== clientId) {
      throw new Error(
        'This terminal is open in another Miter view. Close its view first, or ' + 'open another shell.',
      );
    }
    session.owner = clientId;
    session.delivered = session.ack;

    return {
      ...session.info,
      owned: true,
      occupied: false,
    };
  }

  private disposeSubscriptions(session: ManagedTerminalSession): unknown[] {
    const failures: unknown[] = [];
    const retained: PtySubscription[] = [];

    for (const subscription of session.subscriptions) {
      try {
        subscription.dispose();
      } catch (error) {
        failures.push(error);
        retained.push(subscription);
      }
    }
    session.subscriptions = retained;
    session.cleanupFailures = failures;

    return failures;
  }

  private closeSession(session: ManagedTerminalSession, requestKill = true): unknown[] {
    const wasCleaning = session.cleanupInProgress;
    session.cleanupInProgress = true;
    session.closed = true;
    session.frames = [];
    session.bytes = 0;

    try {
      const failures: unknown[] = [];

      if (requestKill && !session.info.exited) {
        try {
          session.pty.kill();
        } catch (error) {
          failures.push(error);
        }
      }

      if (session.info.exited) {
        failures.push(...this.disposeSubscriptions(session));

        if (!session.subscriptions.length) {
          this.sessions.delete(session.info.id);
        }
      } else {
        // Keep the exit listener and failed resources until termination is confirmed.
        failures.push(...session.cleanupFailures);
      }

      return failures;
    } finally {
      session.cleanupInProgress = wasCleaning;
    }
  }

  async reset(): Promise<void> {
    this.disposed = true;
    const failures: unknown[] = [];
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        const errors: unknown[] = [];
        const wasCleaning = session.cleanupInProgress;
        let failedSubscription: PtySubscription | undefined;
        let subscriptionFailure: unknown;
        session.cleanupInProgress = true;
        session.closed = true;
        session.frames = [];
        session.bytes = 0;

        try {
          if (!session.info.exited) {
            try {
              await new Promise<void>((resolve, reject) => {
                let done = false;
                let starting = true;
                let subscription: PtySubscription | undefined;
                const finish = (causes: unknown[] = []) => {
                  if (done) {
                    return;
                  }
                  done = true;
                  clearTimeout(timer);

                  try {
                    subscription?.dispose();
                  } catch (error) {
                    failedSubscription = subscription;
                    subscriptionFailure = error;
                    causes.push(
                      new Error('Shell exit listener cleanup failed: ' + errorMessage(error), {
                        cause: error,
                      }),
                    );
                  }

                  if (causes.length) {
                    reject(terminalCleanupError('Shell stop failed', causes));
                  } else {
                    resolve();
                  }
                };
                const timer = setTimeout(() => finish([new Error('Shell did not confirm exit')]), 5000);
                const startupFailures: unknown[] = [];

                try {
                  subscription = session.pty.onExit(() => {
                    session.info.exited = true;

                    if (!starting) {
                      finish();
                    }
                  });
                } catch (error) {
                  startupFailures.push(error);
                }

                if (!session.info.exited) {
                  try {
                    session.pty.kill('SIGKILL');
                  } catch (error) {
                    startupFailures.push(error);
                  }
                }
                starting = false;

                if (startupFailures.length || session.info.exited) {
                  finish(startupFailures);
                }
              });
            } catch (error) {
              errors.push(error);
            }
          }
          errors.push(...this.closeSession(session, false));
        } finally {
          if (failedSubscription !== undefined) {
            // Retain the failed waiter without retrying it twice in this reset attempt.
            session.subscriptions.push(failedSubscription);
            session.cleanupFailures.push(subscriptionFailure);
            this.sessions.set(session.info.id, session);
          }
          session.cleanupInProgress = wasCleaning;
        }

        if (errors.length) {
          failures.push(
            terminalCleanupError(`Terminal ${session.info.id} (PID ${session.info.pid})`, errors),
          );
        }
      }),
    );

    if (failures.length) {
      throw terminalCleanupError('Terminal reset incomplete; reset remains locked', failures);
    }
  }

  close(): void {
    this.disposed = true;
    const failures: unknown[] = [];

    for (const session of [...this.sessions.values()]) {
      const errors = this.closeSession(session);

      if (errors.length) {
        failures.push(terminalCleanupError(`Terminal ${session.info.id} (PID ${session.info.pid})`, errors));
      }
    }

    if (failures.length) {
      throw terminalCleanupError('Terminal shutdown incomplete', failures);
    }
  }
}
