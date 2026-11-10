import { PageBridgeError } from '../page-transport.js';
import type { TaskProgress } from '../progress.js';
import { parseRpcParams, parseRpcResult } from '../../../protocol/src/rpc.js';
import { bridgeRpcRegistry } from './rpc-results.js';

/** Elapsed time and revisions are heartbeat data, not changed task content. */
export function checkpointShape(progress: TaskProgress): string {
  const { revision, activeMs, updatedAt, ...meaningful } = progress;
  return JSON.stringify(meaningful);
}

/** Serialized persistence only: no task stages, receipts or execution authority.
 * Build and apply inside the queue so each write sees the preceding host revision. */
export class CheckpointWriter {
  private pendingWrites: Promise<void> = Promise.resolve();
  private saveError: unknown;
  private lastSavedShape = '';
  private lastSavedAt = 0;

  constructor(
    private readonly saveProgress: (progress: TaskProgress, epoch: number) => Promise<unknown> | undefined,
    private readonly now: () => number,
  ) {}

  async write(
    build: () => TaskProgress,
    apply: (progress: TaskProgress, durable: boolean) => void,
    epoch: number,
    force = true,
  ): Promise<void> {
    this.pendingWrites = this.pendingWrites
      .then(async () => {
        const outgoing = build();
        const checkpoint = parseRpcParams(
          bridgeRpcRegistry,
          'worker.bridgeSave',
          { workerId: outgoing.workerId, progress: outgoing, epoch },
          'The task checkpoint is invalid. No progress was written.',
        );
        const value = checkpoint.progress;
        const shape = checkpointShape(value);
        // Mutation boundaries are always forced. Unchanged polling needs only a
        // five-second heartbeat; skipped writes still refresh displayed active time.
        if (!force && shape === this.lastSavedShape && this.now() - this.lastSavedAt < 5000) {
          apply(value, false);
          return;
        }
        const pendingSave = this.saveProgress(outgoing, epoch);
        let saved = value;
        if (pendingSave !== undefined) {
          saved = parseRpcResult(bridgeRpcRegistry, 'worker.bridgeSave', await pendingSave);
          if (
            checkpointShape(saved) !== shape ||
            saved.revision < value.revision ||
            saved.activeMs < value.activeMs
          ) {
            throw new Error(
              'The saved progress acknowledgement does not match this task checkpoint. No further action will run.',
            );
          }
        }
        this.lastSavedShape = shape;
        this.lastSavedAt = this.now();
        apply(saved, true);
        this.saveError = undefined;
      })
      .catch((error) => {
        // Keep the tail drainable, but do not authorize another mutation merely
        // because this queue recovered. Only a successful save clears the error.
        this.saveError = error;
      });
    await this.pendingWrites;
    if (this.saveError) {
      if (this.saveError instanceof PageBridgeError && this.saveError.code === 'RUN_SUPERSEDED') {
        throw this.saveError;
      }

      let reason: string;
      if (this.saveError instanceof Error) {
        reason = this.saveError.message;
      } else {
        reason = String(this.saveError);
      }
      throw new PageBridgeError(
        'PROGRESS_SAVE_FAILED',
        'Task progress could not be saved. No further action will run. ' + reason,
        false,
        { cause: this.saveError },
      );
    }
  }

  async flushed(): Promise<void> {
    await this.pendingWrites;
  }
}
