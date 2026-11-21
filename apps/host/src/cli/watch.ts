import { setTimeout as delay } from 'node:timers/promises';
import type { TerminalStatus } from '../../../../packages/protocol/src/terminal-control.js';
import type { TerminalClient } from '../core/terminal-control/client.js';
import { printStatus, readable, type TerminalOutput } from './output.js';

export type TaskDependencies = TerminalOutput & {
  client: TerminalClient;
  signal: AbortSignal;
  wait?: () => Promise<void>;
  now?: () => number;
};

export type ResumeWatch = {
  requestId: string;
  previousProgress: TerminalStatus['progress'];
  previousWorker: Pick<TerminalStatus['worker'], 'state' | 'error'>;
};

type ResumeObservation = {
  waitingForCheckpoint: boolean;
  checkpointObserved: boolean;
  previousWorker: ResumeWatch['previousWorker'];
};

function resumeGuidance(workerId: string): string {
  return (
    'Run miter resume ' +
    workerId +
    ' --watch to reconnect its saved chat. If you stopped the plan, use Continue fresh in Miter; Resume cannot revive a stopped plan.'
  );
}

export function watchOutcome(
  status: TerminalStatus,
  now = Date.now(),
  resumeObservation?: ResumeObservation,
): { code: number; message: string } | undefined {
  const worker = status.worker;
  let operation = status.operation;
  if (
    operation?.expectedRun?.runId !== worker.expectedRun.runId ||
    operation?.expectedRun?.epoch !== worker.expectedRun.epoch
  ) {
    operation = undefined;
  }
  const dispatchPending =
    operation?.state === 'queued' || operation?.state === 'preparing' || operation?.state === 'claimed';
  const resumePending = operation?.kind === 'resume' && dispatchPending;
  let resume = resumeObservation;
  if (operation?.kind !== 'resume') {
    resume = undefined;
  }
  const resuming = resumePending || resume?.waitingForCheckpoint === true;
  const unchangedWorker =
    resume === undefined ||
    (worker.state === resume.previousWorker.state && worker.error === resume.previousWorker.error);
  const activeResumeCheckpoint =
    resume?.checkpointObserved === true &&
    [
      'connecting',
      'sending',
      'waiting_reply',
      'running',
      'reconnecting',
      'repairing',
      'waiting_team',
    ].includes(status.progress?.phase ?? '');
  const continuingSavedWorker = unchangedWorker && (resuming || activeResumeCheckpoint);
  if (worker.state === 'complete') {
    if (worker.completion?.verification === 'passed') {
      return { code: 0, message: 'Task completed with recorded verification.' };
    }
    return {
      code: 2,
      message:
        'Task is marked complete, but passing verification is not recorded. Review its checks in Miter.',
    };
  }
  if (
    worker.pendingApproval ||
    worker.state === 'awaiting_approval' ||
    status.progress?.phase === 'waiting_approval'
  ) {
    return {
      code: 2,
      message:
        'Task needs command approval. Open the task in Miter to review it; terminal monitoring has stopped.',
    };
  }
  if (operation?.state === 'failed' || operation?.state === 'interrupted') {
    return {
      code: 1,
      message:
        operation.error ??
        'Task dispatch failed or was interrupted. Inspect its saved operation before starting another task.',
    };
  }
  if (worker.state === 'cancelled' || (worker.state === 'blocked' && !continuingSavedWorker)) {
    if (worker.state === 'blocked' && resume?.checkpointObserved && status.progress?.phase === 'error') {
      return { code: 1, message: status.progress.reason };
    }
    return { code: 1, message: worker.error ?? status.progress?.reason ?? 'Task could not continue.' };
  }
  if (worker.state === 'paused' && !continuingSavedWorker && !resume?.checkpointObserved) {
    return { code: 2, message: 'Task is paused. ' + resumeGuidance(worker.id) };
  }
  if (!status.browserConnected) {
    return {
      code: 3,
      message:
        'The Chrome connection is unavailable. Open Miter in Chrome, then run miter watch ' +
        worker.id +
        ' again. This command did not stop the task.',
    };
  }
  if (resuming && (!['paused', 'blocked'].includes(worker.state) || continuingSavedWorker)) {
    return undefined;
  }
  if (status.progress?.monitoring === true && status.progress.watchUntil !== undefined) {
    if (status.progress.watchUntil > now) {
      return undefined;
    }
    return {
      code: 2,
      message: 'Automatic late-reply monitoring has ended. ' + resumeGuidance(worker.id),
    };
  }
  if (status.progress?.phase === 'error') {
    if (resume?.checkpointObserved) {
      return { code: 1, message: status.progress.reason };
    }
    return { code: 1, message: worker.error ?? status.progress.reason ?? 'Task could not continue.' };
  }
  if (worker.state === 'paused' && !continuingSavedWorker) {
    return { code: 2, message: 'Task is paused. ' + resumeGuidance(worker.id) };
  }
  if (!dispatchPending && status.progress?.phase === 'stopped') {
    return { code: 2, message: status.progress.reason + ' ' + resumeGuidance(worker.id) };
  }
  if (!dispatchPending && status.progress?.phase === 'review') {
    return { code: 2, message: status.progress.reason + ' Open the task in Miter to continue.' };
  }
  if (!dispatchPending && worker.state === 'review' && !status.progress) {
    return { code: 2, message: 'Task needs attention in Miter before it can continue.' };
  }
  return undefined;
}

export async function watchTask(
  workerId: string,
  json: boolean,
  dependencies: TaskDependencies,
  initialRun?: TerminalStatus['worker']['expectedRun'],
  resume?: ResumeWatch,
): Promise<number> {
  let previous = '';
  let lastEvent = -1;
  let expectedRun = initialRun;
  let resumeCheckpointObserved = resume === undefined;
  let resumeAcknowledgedAt: number | undefined;
  while (!dependencies.signal.aborted) {
    const status = await dependencies.client.status(workerId);
    const now = dependencies.now?.() ?? Date.now();
    if (expectedRun === undefined) {
      expectedRun = { ...status.worker.expectedRun };
    }
    if (
      status.worker.expectedRun.runId !== expectedRun.runId ||
      status.worker.expectedRun.epoch !== expectedRun.epoch
    ) {
      dependencies.err(
        'The task run changed. Monitoring stopped; run miter watch ' +
          workerId +
          ' to monitor its current run.',
      );
      return 2;
    }
    if (resume && !resumeCheckpointObserved) {
      const previousRevision = resume.previousProgress?.revision;
      const revision = status.progress?.revision;
      if (previousRevision !== undefined && revision !== undefined) {
        resumeCheckpointObserved = revision > previousRevision;
      } else if (status.progress !== undefined) {
        resumeCheckpointObserved =
          JSON.stringify(status.progress) !== JSON.stringify(resume.previousProgress);
      }
    }
    const operation = status.operation;
    const sameResume =
      resume !== undefined &&
      operation?.kind === 'resume' &&
      operation.requestId === resume.requestId &&
      operation.expectedRun?.runId === expectedRun.runId &&
      operation.expectedRun.epoch === expectedRun.epoch;
    if (sameResume && operation.state === 'succeeded' && resumeAcknowledgedAt === undefined) {
      resumeAcknowledgedAt = now;
    }
    const waitingForResumeCheckpoint =
      sameResume && operation.state === 'succeeded' && !resumeCheckpointObserved;
    let resumeObservation: ResumeObservation | undefined;
    if (sameResume) {
      resumeObservation = {
        waitingForCheckpoint: waitingForResumeCheckpoint,
        checkpointObserved: resumeCheckpointObserved,
        previousWorker: resume.previousWorker,
      };
    }
    const fingerprint = JSON.stringify({
      worker: status.worker,
      browserConnected: status.browserConnected,
      phase: status.progress?.phase,
      turns: status.progress?.turns,
      reason: status.progress?.reason,
      monitoring: status.progress?.monitoring,
      watchUntil: status.progress?.watchUntil,
      readerDiagnostic: json && status.progress?.readerDiagnostic,
      operation: status.operation,
      events: status.events,
    });
    if (fingerprint !== previous) {
      printStatus(status, json, dependencies);
      if (!json) {
        for (const event of status.events) {
          if (event.id > lastEvent) {
            dependencies.out('  ' + readable(event.message));
            lastEvent = event.id;
          }
        }
      }
      previous = fingerprint;
    }
    const outcome = watchOutcome(status, now, resumeObservation);
    if (outcome) {
      dependencies.err(readable(outcome.message));
      return outcome.code;
    }
    const staleTerminalDisplay =
      ['paused', 'blocked'].includes(status.worker.state) ||
      ['error', 'stopped', 'review'].includes(status.progress?.phase ?? '');
    if (
      waitingForResumeCheckpoint &&
      staleTerminalDisplay &&
      resumeAcknowledgedAt !== undefined &&
      now - resumeAcknowledgedAt >= 30000
    ) {
      dependencies.err(
        'Resume was acknowledged, but no newer task checkpoint arrived within 30 seconds. Check miter status ' +
          workerId +
          ' before trying again.',
      );
      return 2;
    }
    if (dependencies.wait) {
      await dependencies.wait();
    } else {
      await delay(1000, undefined, { signal: dependencies.signal });
    }
  }
  dependencies.err('Monitoring stopped. The task was not cancelled; use miter stop TASK_ID to stop it.');
  return 130;
}
