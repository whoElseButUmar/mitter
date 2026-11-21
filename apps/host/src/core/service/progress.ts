import { integer, type Worker } from '../../../../../packages/protocol/src/index.js';
import {
  parseTaskProgress,
  progressKey,
  progressSummary,
  taskProgressSchema,
  type TaskProgress,
  type TaskProgressSummary,
} from '../../../../../packages/bridge/src/progress.js';
import type { BridgeProgressLoad } from '../../../../../packages/bridge/src/runner/progress-load.js';
import type { Store } from '../database.js';
import { redact } from '../redaction.js';
import { digest } from '../workspace.js';
import { advanceCounter } from './counters.js';
import { exchangeKey, setupResultKey } from '../handoff-delivery.js';

export function parseProgressUpdate(value: unknown): TaskProgress {
  const parsed = taskProgressSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error(
      'The task progress update exceeds supported limits or has invalid bindings. Nothing was saved.',
      {
        cause: parsed.error,
      },
    );
  }

  return parsed.data;
}

export function prepareFollowupProgress(progress: TaskProgress, reason: string): TaskProgress {
  return parseProgressUpdate({
    ...progress,
    revision: advanceCounter(progress.revision, 'Task progress revision'),
    stage: 'report_due',
    approvedReply: undefined,
    phase: 'stopped',
    reason,
    errorCode: undefined,
    formatRepairs: 0,
    repeats: 0,
    maxTurns: Math.min(
      taskProgressSchema.shape.maxTurns.maxValue ?? Number.MAX_SAFE_INTEGER,
      Math.max(progress.maxTurns, progress.turns + 15),
    ),
    maxMinutes: Math.min(
      taskProgressSchema.shape.maxMinutes.maxValue ?? Number.MAX_SAFE_INTEGER,
      Math.max(progress.maxMinutes, Math.ceil(progress.activeMs / 60000) + 30),
    ),
  });
}

export function goalHash(worker: Worker): string {
  return digest(
    worker.goal
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .trim(),
  );
}

function belongsToTask(progress: TaskProgress, worker: Worker): boolean {
  return (
    progress.workerId === worker.id &&
    progress.projectId === worker.projectId &&
    progress.goalHash === goalHash(worker)
  );
}

// This component owns only the bridge progress record. Epoch changes and worker
// lifecycle remain in Service, including the stop transaction that fences saves.
export class TaskProgressStore {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'transaction' | 'envelopeCount'>) {}

  summaries(workers: Iterable<Worker>): TaskProgressSummary[] {
    const summaries: TaskProgressSummary[] = [];

    for (const worker of workers) {
      const progress = parseTaskProgress(this.store.get(progressKey(worker.id)));

      if (progress && belongsToTask(progress, worker)) {
        summaries.push(progressSummary(progress));
      }
    }

    return summaries;
  }

  load(worker: Worker): BridgeProgressLoad {
    const raw = this.store.get(progressKey(worker.id));
    const progress = parseTaskProgress(raw);

    if (raw !== undefined && !progress) {
      throw new Error(
        'Saved task progress uses an unsupported or damaged format. It was not overwritten. ' +
          'Restore a compatible version or review diagnostics.',
      );
    }

    if (progress && !belongsToTask(progress, worker)) {
      throw new Error('Saved progress belongs to a different task goal. Nothing was reset.');
    }

    const result: BridgeProgressLoad = {
      progress: progress ?? null,
      importedCount: this.store.envelopeCount(worker.id),
    };
    if (
      worker.state === 'review' &&
      worker.control?.mode !== 'stopped' &&
      worker.queue.length === 0 &&
      (progress?.stage === 'local_batch' || progress?.stage === 'report_due') &&
      progress.lastImportedId &&
      progress.lastReceipt?.exchangeId &&
      this.store.get(setupResultKey(worker, progress.lastReceipt.exchangeId)) === progress.lastImportedId
    ) {
      result.setupResultBatchId = progress.lastImportedId;
    }
    return result;
  }

  assertSaveEpoch(worker: Worker, epoch: unknown): void {
    if (worker.control && (worker.control.mode === 'stopped' || (epoch ?? 0) !== worker.control.epoch)) {
      throw new Error('This progress update belongs to a stopped or earlier run. It was not saved.');
    }

    if (epoch !== undefined) {
      integer(epoch, 'epoch', 0, Number.MAX_SAFE_INTEGER);
    }
  }

  save(worker: Worker, value: unknown, epoch: unknown): TaskProgress {
    this.assertSaveEpoch(worker, epoch);
    const next = parseTaskProgress(value);

    if (!next || !belongsToTask(next, worker)) {
      throw new Error('Invalid task progress binding.');
    }

    return this.store.transaction(() => {
      const raw = this.store.get(progressKey(worker.id));
      const prior = parseTaskProgress(raw);

      if (raw !== undefined && !prior) {
        throw new Error('Unsupported saved progress format; refusing to overwrite it.');
      }

      if (prior && !belongsToTask(prior, worker)) {
        throw new Error('Saved progress belongs to a different task goal. Nothing was reset.');
      }

      if (next.revision !== (prior?.revision ?? 0)) {
        throw new Error('Task progress changed in another session. Resume to reload it.');
      }

      if (
        prior &&
        (next.turns < prior.turns ||
          next.maxTurns !== prior.maxTurns ||
          next.maxMinutes !== prior.maxMinutes ||
          next.activeMs < prior.activeMs ||
          next.startedAt !== prior.startedAt)
      ) {
        throw new Error('Task counters and budgets cannot be reset by Resume.');
      }

      let reason = redact(next.reason);
      const reasonLimit = taskProgressSchema.shape.reason.maxLength;

      if (reasonLimit !== null) {
        reason = reason.slice(0, reasonLimit);
      }

      const saved = parseProgressUpdate({
        ...next,
        revision: advanceCounter(next.revision, 'Task progress revision'),
        reason,
      });
      const previousId = prior?.lastReceipt?.exchangeId;
      if (
        previousId &&
        prior?.lastReceipt?.expectsReplyTo &&
        ['commit_intent', 'waiting_reply'].includes(prior.stage) &&
        saved.stage === 'prepared' &&
        saved.lastReceipt?.expectsReplyTo &&
        saved.lastReceipt.exchangeId !== previousId
      ) {
        const key = exchangeKey(worker.id, previousId);
        if (this.store.get(key) === 'admitted') {
          throw new Error('The pending reply has already been imported. No replacement was sent.');
        }
        this.store.set(key, 'retired');
      }
      this.store.set(progressKey(worker.id), saved);

      return saved;
    });
  }

  extend(worker: Worker, confirm: unknown): TaskProgress {
    if (confirm !== true) {
      throw new Error('Explicit authorization is required to extend the task budget.');
    }

    const progress = parseTaskProgress(this.store.get(progressKey(worker.id)));

    if (!progress || !belongsToTask(progress, worker)) {
      throw new Error('No compatible saved progress for this task.');
    }

    if (!['idle', 'review', 'paused', 'blocked'].includes(worker.state) || worker.humanAcceptanceReady) {
      throw new Error('Review this task before extending its budget.');
    }

    const next = parseProgressUpdate({
      ...progress,
      maxTurns: Math.min(
        taskProgressSchema.shape.maxTurns.maxValue ?? Number.MAX_SAFE_INTEGER,
        Math.max(progress.maxTurns, progress.turns) + 15,
      ),
      maxMinutes: Math.min(
        taskProgressSchema.shape.maxMinutes.maxValue ?? Number.MAX_SAFE_INTEGER,
        Math.max(progress.maxMinutes, Math.ceil(progress.activeMs / 60000)) + 30,
      ),
      revision: advanceCounter(progress.revision, 'Task progress revision'),
    });
    this.store.set(progressKey(worker.id), next);

    return next;
  }
}
