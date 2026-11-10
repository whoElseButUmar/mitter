import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Settings } from '../../../../packages/protocol/src/index.js';
import { modelRequestSchema, modelResponseSchema } from '../../../inference/src/protocol.js';
import type { Models } from '../core/types.js';
import { errorMessage } from '../core/types.js';

export type ModelSpawner = (worker: string, args: string[], options: ForkOptions) => ChildProcess;

export type ModelPending = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** Model crashes and large native allocations are isolated from the filesystem/SQLite host process. */

export class ModelProcess implements Models {
  private child: ChildProcess | undefined = undefined;
  private retiring = new Set<ChildProcess>();
  private pending = new Map<string, ModelPending>();

  constructor(
    private getSettings: () => Settings,
    private spawn: ModelSpawner = fork,
  ) {}

  private ensure(): ChildProcess {
    if (this.child) {
      return this.child;
    }

    const worker = fileURLToPath(new URL('../../../inference/src/worker.js', import.meta.url));
    const child = this.spawn(worker, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        SystemRoot: process.env.SystemRoot,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
      },
    });

    // All diagnostics go to stderr, never to Chrome's framed stdout channel.
    const onDiagnostics = (chunk: Buffer) => process.stderr.write(chunk);
    const onMessage = (message: unknown) => {
      if (this.child !== child) {
        return;
      }

      const parsed = modelResponseSchema.safeParse(message);

      if (!parsed.success) {
        this.close(
          new Error('Local model sent an invalid IPC response. No filesystem action was repeated.', {
            cause: parsed.error,
          }),
        );
        return;
      }

      const response = parsed.data;
      const pending = this.pending.get(response.id);

      if (!pending) {
        return;
      }
      this.pending.delete(response.id);
      pending.cleanup();

      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error(response.error));
      }
    };
    const onError = (error: Error) => {
      if (this.child === child) {
        this.close(
          new Error(
            `Local model process failed: ${error.message}. No filesystem action was automatically repeated.`,
            { cause: error },
          ),
        );
      }
    };
    const onExit = () => {
      if (this.child === child) {
        this.child = undefined;
        this.rejectAll(
          new Error('Local model process exited. No filesystem action was automatically repeated.'),
        );
      }
    };

    child.stderr?.on('data', onDiagnostics);
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
    child.once('close', () => {
      this.retiring.delete(child);
      child.stderr?.off('data', onDiagnostics);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    });
    this.child = child;

    return child;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  propose(input: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const id = randomUUID();
    const request = modelRequestSchema.parse({
      id,
      method: 'propose',
      input,
      settings: this.getSettings(),
    });
    signal.throwIfAborted();
    const child = this.ensure();

    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.pending.has(id) && this.child === child) {
          this.close();
        }
      };
      const timer = setTimeout(() => this.close(), 300000);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      this.pending.set(id, {
        resolve,
        reject,
        cleanup,
      });
      signal.addEventListener('abort', abort, {
        once: true,
      });

      // A late send callback must not reject a completed request or clear another worker's timer.
      const failed = (error: Error) => {
        const pending = this.pending.get(id);

        if (!pending) {
          return;
        }
        this.pending.delete(id);
        pending.cleanup();
        pending.reject(error);
      };

      if (signal.aborted) {
        abort();
        return;
      }

      try {
        child.send(request, (error) => {
          if (error) {
            failed(error);
          }
        });
      } catch (error) {
        failed(new Error(errorMessage(error)));
      }

      if (signal.aborted) {
        abort();
      }
    });
  }

  close(error = new Error('Local model stopped or timed out.')): void {
    const child = this.child;
    this.child = undefined;

    if (child && child.exitCode === null && child.signalCode === null) {
      this.retiring.add(child);

      try {
        child.kill('SIGKILL');
      } catch (terminationError) {
        error = new AggregateError(
          [error, terminationError],
          'Local model termination failed; reset remains blocked: ' + errorMessage(terminationError),
        );
      }
    }
    this.rejectAll(error);
  }

  async settled(): Promise<void> {
    const deadline = Date.now() + 5000;

    while (this.retiring.size) {
      if (Date.now() > deadline) {
        throw new Error('Local model process has not exited; reset refused.');
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
