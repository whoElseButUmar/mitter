import { APP_VERSION } from '../../../../packages/protocol/src/index.js';
import {
  terminalClaimResultSchema,
  terminalCompleteResultSchema,
  type TerminalCommand,
  type TerminalCompleteParams,
} from '../../../../packages/protocol/src/terminal-control.js';
import { runResultSchema, stopResultSchema } from '../../../../packages/protocol/src/rpc.js';
import { bridgeStartResultSchema, resumeResultSchema } from '../schemas/local-results.js';
import { errorMessage } from '../schemas/primitives.js';

type Receipt = { command: TerminalCommand; completion: TerminalCompleteParams };
type TerminalControlDependencies = {
  native(method: string, params: Record<string, unknown>): Promise<unknown>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  ready(): Promise<void>;
  blocked(): boolean;
  log(kind: string, message: string): void;
};

/** Native-only terminal commands use the same admission and permission checks as the workspace. */
export class TerminalControl {
  private readonly sessionId = crypto.randomUUID();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private started = false;
  private closed = false;
  private connection = Symbol('terminal connection');
  private active: TerminalCommand | undefined;
  private pending: Receipt | undefined;
  private acknowledged: Receipt | undefined;
  private lastError: string | undefined;

  constructor(private readonly dependencies: TerminalControlDependencies) {}

  start(): void {
    if (this.closed || this.started) {
      return;
    }

    this.started = true;
    this.schedule();
  }

  disconnected(): void {
    this.connection = Symbol('terminal connection');
  }

  dispose(): void {
    this.closed = true;
    this.disconnected();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active = undefined;
    this.pending = undefined;
    this.acknowledged = undefined;
  }

  private schedule(): void {
    if (this.closed) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, 1000);
  }

  private available(connection: symbol): boolean {
    return !this.closed && !this.dependencies.blocked() && this.connection === connection;
  }

  private async poll(): Promise<void> {
    if (this.closed || this.polling) {
      return;
    }

    this.polling = true;
    const connection = this.connection;

    try {
      await this.dependencies.ready();

      if (!this.available(connection)) {
        return;
      }

      // An acknowledgement is safe to retry verbatim. The command itself is never retried here.
      const pending = this.pending;

      if (pending) {
        const response = await this.dependencies.native('terminal.complete', pending.completion);
        const result = terminalCompleteResultSchema.safeParse(response);

        if (!result.success) {
          throw new Error(
            'The terminal receipt was not acknowledged. Only the same receipt will be retried.',
            { cause: result.error },
          );
        }

        if (this.available(connection) && this.pending === pending) {
          this.acknowledged = pending;
          this.pending = undefined;
        }

        return;
      }

      const acceptCommand = this.active === undefined;
      const response = await this.dependencies.native('terminal.claim', {
        sessionId: this.sessionId,
        version: APP_VERSION,
        available: acceptCommand,
      });
      const parsed = terminalClaimResultSchema.safeParse(response);

      if (!parsed.success) {
        throw new Error('The terminal command was invalid. No task was dispatched.', { cause: parsed.error });
      }

      const command = parsed.data.command;

      if (!command || this.closed) {
        return;
      }

      if (!acceptCommand) {
        throw new Error('The host returned work while the terminal relay was busy. No task was dispatched.');
      }

      if (!this.available(connection)) {
        this.pending = this.failure(command, 'The browser connection changed before this task could start.');
        return;
      }

      // The host owns durable deduplication. Retain the last receipt for a repeated transport response.
      if (this.acknowledged?.command.requestId === command.requestId) {
        if (JSON.stringify(this.acknowledged.command) !== JSON.stringify(command)) {
          throw new Error(
            'The host reused a terminal operation with different parameters. No task was dispatched.',
          );
        }

        this.pending = this.acknowledged;
        return;
      }

      this.active = command;
      this.lastError = undefined;
      void this.dispatch(command);
    } catch (error) {
      if (!this.closed) {
        const message = errorMessage(error);

        if (message !== this.lastError) {
          this.lastError = message;
          this.dependencies.log('terminal.control.error', message);
        }
      }
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  private failure(command: TerminalCommand, error: string): Receipt {
    return {
      command,
      completion: {
        sessionId: this.sessionId,
        requestId: command.requestId,
        claimToken: command.claimToken,
        ok: false,
        error: error.slice(0, 2000),
      },
    };
  }

  private async dispatch(command: TerminalCommand): Promise<void> {
    let receipt: Receipt;

    try {
      if (command.kind === 'start' && command.localPreview) {
        const result = runResultSchema.parse(
          await this.dependencies.request('worker.run', {
            workerId: command.workerId,
            expectedRun: command.expectedRun,
          }),
        );
        if (!('started' in result) || !result.started) {
          throw new Error('Miter did not acknowledge starting the local project preview.');
        }
      } else if (command.kind === 'start') {
        const response = await this.dependencies.request('bridge.start', {
          workerId: command.workerId,
          expectedRun: command.expectedRun,
          consent: command.consent,
          newChat: true,
          maxTurns: command.maxTurns,
          maxMinutes: command.maxMinutes,
        });
        const result = bridgeStartResultSchema.safeParse(response);

        if (
          !result.success ||
          result.data.workerId !== command.workerId ||
          result.data.expectedRun.runId !== command.expectedRun.runId ||
          result.data.expectedRun.epoch !== command.expectedRun.epoch
        ) {
          throw new Error(
            'The task start acknowledgement could not be verified. The task may have started; it was not replayed.',
          );
        }
      } else if (command.kind === 'resume') {
        const response = await this.dependencies.request('bridge.resume', {
          workerId: command.workerId,
          expectedRun: command.expectedRun,
        });
        const result = resumeResultSchema.safeParse(response);

        if (!result.success || !result.data.resumed || result.data.status?.workerId !== command.workerId) {
          throw new Error(
            'The task resume acknowledgement could not be verified. It may have resumed; it was not replayed. Check the saved task and chat.',
          );
        }
      } else {
        const response = await this.dependencies.request('bridge.halt', {
          id: command.requestId,
          workerId: command.workerId,
          expectedRun: command.expectedRun,
        });
        const result = stopResultSchema.safeParse(response);

        if (!result.success || result.data.operationId !== command.requestId) {
          throw new Error(
            'The task stop acknowledgement could not be verified. The task may have stopped; it was not replayed.',
          );
        }
      }

      receipt = {
        command,
        completion: {
          sessionId: this.sessionId,
          requestId: command.requestId,
          claimToken: command.claimToken,
          ok: true,
        },
      };
    } catch (error) {
      receipt = this.failure(command, errorMessage(error));
    }

    if (!this.closed && this.active === command) {
      this.pending = receipt;
      this.active = undefined;
    }
  }
}
