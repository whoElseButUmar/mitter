import type { Worker } from '../../../../../packages/protocol/src/index.js';
import { buildCompletion } from './reports.js';

const stableStates = new Set<Worker['state']>([
  'idle',
  'paused',
  'review',
  'blocked',
  'complete',
  'cancelled',
]);

export const shutdownRecoveryMessage =
  'Interrupted by host shutdown. Inspect the report before resuming. ' +
  'In-flight commands are never blindly replayed.';

export const drainedHandoffRecoveryMessage =
  'Recovered a consumed handoff batch after its review transition failed. ' +
  'Its report is ready; no actions were rerun.';

export function recoverDrainedHandoff(worker: Worker): Worker {
  if (
    worker.mode !== 'handoff' ||
    !['paused', 'blocked'].includes(worker.state) ||
    worker.error !== 'Invalid transition queued → review.' ||
    worker.queue.length !== 0 ||
    worker.cursor !== 0 ||
    worker.pending ||
    worker.completion ||
    worker.humanAcceptanceReady ||
    worker.control?.mode === 'stopped'
  ) {
    return worker;
  }

  return {
    ...worker,
    state: 'review',
    error: undefined,
    autoCommands: false,
    approvedFingerprint: undefined,
  };
}

export function recoverInterruptedWorker(worker: Worker): Worker {
  if (stableStates.has(worker.state)) {
    return worker;
  }

  return {
    ...worker,
    state: 'paused',
    pending: undefined,
    approvedFingerprint: undefined,
    error: shutdownRecoveryMessage,
  };
}

export function recoverStoppedWorker(worker: Worker): Worker {
  if (worker.control?.mode !== 'stopped') {
    return worker;
  }

  return {
    ...worker,
    queue: [],
    cursor: 0,
    pending: undefined,
    approvedFingerprint: undefined,
    state: 'paused',
    humanAcceptanceReady: false,
    completion: undefined,
  };
}

export function migrateLegacyCompletion(worker: Worker, at: number): Worker {
  // Only a previously verified explicit finish loses the old acceptance gate.
  // Intermediate review states, errors, approvals, and stopped tasks stay unfinished.
  if (
    worker.state !== 'review' ||
    worker.humanAcceptanceReady !== true ||
    worker.queue.length > 0 ||
    worker.pending ||
    worker.error ||
    worker.control?.mode === 'stopped'
  ) {
    return worker;
  }

  let verification: 'passed' | 'not-run' = 'not-run';

  if (worker.checks.length > 0) {
    verification = 'passed';
  }

  return {
    ...worker,
    state: 'complete',
    humanAcceptanceReady: false,
    completion: buildCompletion(
      worker,
      verification,
      'Finished before this update; acceptance click is no longer required.',
      worker.checks.length,
      at,
    ),
  };
}
