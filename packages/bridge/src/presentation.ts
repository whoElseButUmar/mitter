import type { Worker } from '../../protocol/src/index.js';
import type { BridgeStatus } from './runner/types.js';

export function taskPresentation(worker: Worker, bridge?: BridgeStatus) {
  if (worker.state === 'complete') {
    let detail: string;
    switch (worker.completion?.verification) {
      case 'legacy-accepted':
        detail = 'Finished. Previously accepted by you.';
        break;
      case 'passed':
        detail = 'Finished. Configured checks passed.';
        break;
      case 'not-run':
        detail = 'Finished. No automated checks configured.';
        break;
      default:
        if (worker.checks.length) {
          detail = 'Finished. Configured checks passed.';
        } else {
          detail = 'Finished. Verification not recorded.';
        }
    }

    return {
      status: 'complete',
      detail,
      start: 'Run with ChatGPT',
      tone: 'success',
    };
  }

  if (worker.humanAcceptanceReady) {
    return {
      status: 'review',
      detail: 'Ready for your review.',
      start: 'Run with ChatGPT',
      tone: 'normal',
    };
  }

  if (worker.control?.mode === 'stopped') {
    return {
      status: 'stopped',
      detail: 'Stopped. Completed work is kept; Continue fresh replans from the current files.',
      start: 'Continue fresh',
      tone: 'normal',
    };
  }

  if (worker.control?.mode === 'fresh' && !bridge?.active) {
    return {
      status: 'paused',
      detail: worker.error || 'Ready to continue from the current files with a fresh plan.',
      start: 'Continue fresh',
      tone: 'normal',
    };
  }

  if (bridge?.monitoring && bridge.receiving) {
    return {
      status: 'working',
      detail: bridge.reason,
      start: 'Resume task',
      tone: 'working',
    };
  }

  if (bridge?.monitoring) {
    return {
      status: 'needs_attention',
      detail: bridge.reason,
      start: 'Resume task',
      tone: 'error',
    };
  }

  if (bridge?.active) {
    let status = 'working';
    if (bridge.phase === 'waiting_approval') {
      status = 'needs_approval';
    } else if (bridge.phase === 'reconnecting') {
      status = 'reconnecting';
    } else if (bridge.phase === 'connecting') {
      status = 'connecting';
    }

    return {
      status,
      detail: bridge.reason,
      start: 'Resume task',
      tone: 'working',
    };
  }

  if (bridge?.phase === 'error') {
    return {
      status: 'paused',
      detail: bridge.reason,
      start: 'Resume task',
      tone: 'error',
    };
  }

  if (bridge?.phase === 'stopped') {
    return {
      status: 'paused',
      detail: bridge.reason,
      start: 'Resume task',
      tone: 'normal',
    };
  }

  let detail: string;
  if (worker.state === 'idle') {
    detail = 'Ready when you are.';
  } else if (worker.state === 'review') {
    detail = worker.error || 'Ready for the next step.';
  } else {
    detail = worker.error || '';
  }

  let start = 'Resume task';
  if (worker.state === 'idle') {
    start = 'Run with ChatGPT';
  }

  return {
    status: worker.state,
    detail,
    start,
    tone: 'normal',
  };
}

/** The counter is per TASK, not per Resume session. Legacy releases did not
 * save every send; expose a minimum rather than inventing an exact total. */
export function turnLabel(bridge: BridgeStatus): string {
  let label = `${bridge.turns}/${bridge.maxTurns} turns`;
  if (bridge.lowerBound) {
    label = '≥' + label;
  }

  return label;
}

export function budgetExhausted(bridge: BridgeStatus | undefined): boolean {
  if (!bridge || bridge.active) {
    return false;
  }

  if (bridge.errorCode === 'TIME_LIMIT' || bridge.errorCode === 'TURN_LIMIT') {
    return true;
  }
  return (
    typeof bridge.activeMs === 'number' &&
    typeof bridge.maxMinutes === 'number' &&
    bridge.activeMs >= bridge.maxMinutes * 60000
  );
}
