import type { Snapshot, TaskBoundary, Worker } from '../../../../packages/protocol/src/index.js';
import { previewStartResultSchema } from '../../../../packages/protocol/src/rpc.js';
import type { NativeRPC } from '../transport/native-host.js';
import { errorMessage } from '../schemas/primitives.js';

type ObservedRun = { runId: string; epoch: number; complete: boolean };

/** Observe host transitions, including tasks started through the terminal. Mounting
 * a workspace or reconnecting to an already-complete task does not open a tab. */
export class CompletedPreviews {
  private readonly feedback = new Set<Promise<void>>();
  private readonly observed = new Map<string, ObservedRun>();

  constructor(
    private readonly native: NativeRPC,
    private readonly blocked: () => boolean,
    private readonly open: (url: string) => Promise<unknown>,
    private readonly failed: (
      workerId: string,
      expectedRun: TaskBoundary,
      message: string,
    ) => Promise<void> | void,
  ) {}

  // The native host coalesces state broadcasts. Use the actual task read during
  // admission so even a first broadcast that already says "complete" can open.
  arm(task: Worker): void {
    if (task.state === 'complete' || task.state === 'cancelled') {
      return;
    }
    const epoch = task.control?.epoch ?? 0;
    const previous = this.observed.get(task.id);
    if (previous?.runId === task.runId && previous.epoch === epoch) {
      return;
    }
    this.observed.set(task.id, { runId: task.runId, epoch, complete: false });
  }

  update(snapshot: Snapshot): void {
    for (const task of snapshot.workers) {
      const next = {
        runId: task.runId,
        epoch: task.control?.epoch ?? 0,
        complete: task.state === 'complete',
      };
      const previous = this.observed.get(task.id);
      if (
        previous?.runId === next.runId &&
        previous.epoch === next.epoch &&
        previous.complete === next.complete
      ) {
        continue;
      }
      this.observed.set(task.id, next);
      if (
        previous &&
        previous.runId === next.runId &&
        previous.epoch === next.epoch &&
        !previous.complete &&
        next.complete &&
        task.completion?.verification === 'passed' &&
        (task.completion.evidence?.staticPreview ||
          (task.completion.evidence?.devServerFingerprint && task.completion.evidence.devServer))
      ) {
        void this.launch(task, next);
      }
    }
    for (const id of this.observed.keys()) {
      if (!snapshot.workers.some((task) => task.id === id)) {
        this.observed.delete(id);
      }
    }
  }

  private async launch(task: Worker, run: ObservedRun): Promise<void> {
    const current = () => !this.blocked() && this.observed.get(task.id) === run;
    const expectedRun: TaskBoundary = { runId: run.runId, epoch: run.epoch };
    const params = { workerId: task.id, expectedRun };
    try {
      if (!current()) {
        return;
      }
      const result = await this.native(
        'worker.previewStart',
        { ...params, mode: 'verified' },
        previewStartResultSchema,
      );
      if (!current()) {
        return;
      }
      if (result.framework !== task.completion?.evidence?.devServer) {
        throw new Error('The running preview does not match the verified framework.');
      }
      await this.open(result.url);
    } catch (error) {
      if (current()) {
        const write = Promise.resolve(
          this.failed(
            task.id,
            expectedRun,
            'Could not open the app automatically. Choose Run to retry in Terminal. ' + errorMessage(error),
          ),
        );
        this.feedback.add(write);
        await write.finally(() => this.feedback.delete(write));
      }
    }
  }

  async quiesce(): Promise<void> {
    await Promise.allSettled(this.feedback);
  }

  clear(): void {
    this.observed.clear();
  }
}
