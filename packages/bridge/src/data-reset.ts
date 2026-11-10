import { z } from 'zod';

/** Two-store reset transaction. There is deliberately no rollback of deletion:
 * a failed stage leaves both coordinators locked for explicit, idempotent retry. */
export const DATA_RESET_KEY = 'miter.reset.pending.v1';
const browserResetLockSchema = z
  .object({
    [DATA_RESET_KEY]: z
      .literal(true)
      .optional()
      .describe('An unfinished reset lock; only absence means unlocked.'),
  })
  .describe('Browser storage for the reset barrier; malformed markers keep writers locked.');
export const dataResetPhaseSchema = z
  .enum(['idle', 'stopping', 'clearing', 'failed', 'complete'])
  .describe('How far the data reset has reached.');
export type DataResetPhase = z.infer<typeof dataResetPhaseSchema>;

export const dataResetStateSchema = z
  .object({
    phase: dataResetPhaseSchema,
    error: z.string().optional().describe('Why the reset could not finish.'),
    preserved: z.array(z.string()).optional().describe('Files kept after deleting Miter data.'),
    step: z.enum(['native', 'browser', 'commit']).optional().describe('Which cleanup stage is running.'),
  })
  .describe('The current reset status shown to the user.');
export type DataResetState = z.infer<typeof dataResetStateSchema>;

export const resetPreparationSchema = z
  .object({
    prepared: z.boolean().describe('Whether the native host is ready to delete Miter data.'),
  })
  .describe('The native host reply before deletion begins.');
export type ResetPreparation = z.infer<typeof resetPreparationSchema>;

export const resetCleanupFailureSchema = z
  .object({
    path: z.string().describe('The file or folder that could not be removed.'),
    error: z.string().describe('Why this file or folder could not be removed.'),
  })
  .describe('A file or folder left behind by a failed cleanup.');
export type ResetCleanupFailure = z.infer<typeof resetCleanupFailureSchema>;

export const resetCleanupResultSchema = z
  .object({
    cleared: z.boolean().describe('Whether all native Miter data was deleted.'),
    failures: z.array(resetCleanupFailureSchema).describe('Files or folders that could not be removed.'),
    preserved: z.array(z.string()).describe('Files deliberately kept during cleanup.'),
  })
  .describe('The native host reply after deleting Miter data.');
export type ResetCleanupResult = z.infer<typeof resetCleanupResultSchema>;

export const resetCompletionSchema = z
  .object({
    cleared: z.boolean().describe('Whether the native host confirmed the reset is complete.'),
  })
  .describe('The native host reply after the final reset check.');
export type ResetCompletion = z.infer<typeof resetCompletionSchema>;

export type DataResetDependencies = {
  storage: {
    get(key: string): Promise<unknown>;
    set(data: Record<string, unknown>): Promise<unknown>;
    remove(key: string): Promise<unknown>;
  };
  quiesceViews(): Promise<void>;
  stop(): Promise<void>;
  hostPrepare(): Promise<unknown>;
  hostClear(): Promise<unknown>;
  clearBrowser(): Promise<void>;
  hostComplete(): Promise<unknown>;
  publish(state: DataResetState): void;
  restart(): void;
};

export class DataResetCoordinator {
  readonly ready: Promise<void>;
  blocked = false;
  busy = false;
  state: DataResetState = { phase: 'idle' };

  constructor(private deps: DataResetDependencies) {
    this.ready = this.loadResetLock();
  }

  private async loadResetLock(): Promise<void> {
    try {
      const lock = browserResetLockSchema.safeParse(await this.deps.storage.get(DATA_RESET_KEY));
      if (!lock.success) {
        throw new Error('The browser reset lock is invalid. Type CLEAR to retry the reset.', {
          cause: lock.error,
        });
      }
      if (lock.data[DATA_RESET_KEY] === true) {
        this.recover('A previous data reset did not finish. Type CLEAR to retry.');
      }
    } catch (error) {
      this.recover('Could not check the reset lock: ' + String(error));
    }
  }

  recover(error: string) {
    this.blocked = true;

    if (!this.busy) {
      this.publish({ phase: 'failed', error });
    }
  }

  private publish(state: DataResetState) {
    this.state = state;
    this.deps.publish(state);
  }

  async clear(confirmation: unknown): Promise<void> {
    if (confirmation !== 'CLEAR') {
      throw new Error('Type exactly CLEAR to delete all Miter application data.');
    }

    await this.ready;
    if (this.busy) {
      throw new Error('A reset is already running.');
    }

    this.busy = true;
    this.blocked = true;
    this.publish({ phase: 'stopping' });

    try {
      await this.deps.storage.set({ [DATA_RESET_KEY]: true });

      // First STOP every writer. A refused document barrier must not delete the
      // native database in parallel. Preparation gates native RPC, drains workers
      // and writes its recovery marker, but does not remove application records.
      const barrierResults = await Promise.allSettled([
        this.deps.quiesceViews(),
        this.deps.stop(),
        this.deps.hostPrepare(),
      ]);
      const barrierNames = ['Open views', 'Background workers', 'Native preparation'];
      const failures = barrierResults.flatMap((result, index) => {
        if (result.status !== 'rejected') {
          return [];
        }
        return [barrierNames[index] + ': ' + String(result.reason)];
      });
      if (failures.length) {
        throw new Error(failures.join('\n'));
      }

      const preparationResult = barrierResults[2];
      let preparationConfirmed = false;
      let preparationError: unknown;
      if (preparationResult?.status === 'fulfilled') {
        const preparation = resetPreparationSchema.safeParse(preparationResult.value);
        preparationConfirmed = preparation.success && preparation.data.prepared === true;
        if (!preparation.success) {
          preparationError = preparation.error;
        }
      }

      if (!preparationConfirmed) {
        throw new Error(
          'The native host did not confirm reset preparation. No native cleanup was authorized.',
          { cause: preparationError },
        );
      }

      this.publish({ phase: 'clearing', step: 'native' });
      const cleanupResponse: unknown = await this.deps.hostClear();
      const nativeCleanup = resetCleanupResultSchema.safeParse(cleanupResponse);
      if (
        !nativeCleanup.success ||
        nativeCleanup.data.cleared !== true ||
        nativeCleanup.data.failures.length !== 0
      ) {
        let failureDetails = '';
        // Keep file-specific errors even if a failed reply omitted unrelated cleanup fields.
        if (cleanupResponse && typeof cleanupResponse === 'object' && 'failures' in cleanupResponse) {
          const failures = resetCleanupResultSchema.shape.failures.safeParse(cleanupResponse.failures);
          if (failures.success) {
            failureDetails = failures.data.map((failure) => `${failure.path}: ${failure.error}`).join('\n');
          }
        }

        throw new Error(failureDetails || 'Native state could not be fully deleted.', {
          cause: nativeCleanup.error,
        });
      }

      this.publish({ phase: 'clearing', step: 'browser' });
      await this.deps.clearBrowser();

      this.publish({ phase: 'clearing', step: 'commit' });
      const completion = resetCompletionSchema.safeParse(await this.deps.hostComplete());
      if (!completion.success || completion.data.cleared !== true) {
        throw new Error('The native host did not confirm final reset verification. Reset remains locked.', {
          cause: completion.error,
        });
      }

      await this.deps.storage.remove(DATA_RESET_KEY);
      const browserState = browserResetLockSchema.safeParse(await this.deps.storage.get(DATA_RESET_KEY));
      if (!browserState.success) {
        throw new Error('The browser reset lock could not be verified. Reset remains locked.', {
          cause: browserState.error,
        });
      }
      if (browserState.data[DATA_RESET_KEY] === true) {
        throw new Error('The browser reset lock could not be removed.');
      }

      this.publish({
        phase: 'complete',
        preserved: nativeCleanup.data.preserved,
      });
      this.deps.restart();
    } catch (error) {
      let detail: string;
      if (error instanceof Error) {
        detail = error.message;
      } else {
        detail = String(error);
      }

      // Native marker remains until browser cleanup completes. Re-create the
      // browser lock as well when a failure happens after storage.clear().
      let lockError = '';
      try {
        await this.deps.storage.set({ [DATA_RESET_KEY]: true });
      } catch (error) {
        lockError = '\nBrowser reset lock: ' + String(error);
      }

      this.publish({ phase: 'failed', error: detail + lockError });
      throw new Error(detail + lockError, { cause: error });
    } finally {
      this.busy = false;
    }
  }
}
