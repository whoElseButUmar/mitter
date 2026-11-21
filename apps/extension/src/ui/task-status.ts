import type { Worker } from '../../../../packages/protocol/src/index';
import type { BridgeStatus } from '../../../../packages/bridge/src/runner/types';
import { isAppReady } from '../../../../packages/bridge/src/presentation';

export type TaskStatus = {
  heading: string;
  detail: string;
  tone: 'working' | 'attention' | 'success' | 'neutral';
  requiresAttention: boolean;
};

function status(heading: string, detail: string, tone: TaskStatus['tone']): TaskStatus {
  return { heading, detail, tone, requiresAttention: tone === 'attention' };
}

function completedStatus(worker: Worker): TaskStatus {
  const completion = worker.completion;
  const evidence = completion?.evidence;
  if (isAppReady(worker)) {
    return status('App ready', 'Browser checks passed.', 'success');
  }

  let detail = 'Verification was not recorded.';
  if (completion?.verification === 'legacy-accepted') {
    detail = 'Previously accepted. Browser verification was not recorded.';
  } else if (completion?.verification === 'not-run') {
    detail = 'Completion checks did not run.';
  } else if (completion?.verification === 'passed') {
    detail = 'Checks passed.';
    if (evidence?.browser === 'passed') {
      detail = 'Browser checks passed. Lighthouse results were not recorded.';
      if (evidence.lighthouse === 'not-run') {
        detail = 'Browser checks passed. Lighthouse checks did not run.';
      }
    }
  }

  return status('Task complete', detail, 'neutral');
}

/** Compact UI status; detailed active transport reasons remain in task diagnostics. */
export function taskStatus(worker: Worker, bridge?: BridgeStatus): TaskStatus {
  if (bridge?.workerId !== worker.id) {
    bridge = undefined;
  }

  if (worker.pending?.action.type === 'setupCommand') {
    if (worker.pending.manualSessionId) {
      return status(
        'Waiting for your command',
        'Enter your command in the project setup terminal.',
        'attention',
      );
    }
    return status('Setup needs approval', worker.pending.action.purpose, 'attention');
  }

  if (worker.pending) {
    return status('Approval needed', worker.pending.reason, 'attention');
  }

  // Terminal task evidence takes precedence over the bridge's last published step.
  if (worker.state === 'complete') {
    return completedStatus(worker);
  }

  if (worker.humanAcceptanceReady) {
    return status('Ready for review', worker.error || 'Review the result before accepting it.', 'attention');
  }

  if (worker.control?.mode === 'stopped') {
    return status(
      'Stopped',
      'Completed work is kept. Continue fresh starts from the current files.',
      'neutral',
    );
  }

  if (worker.state === 'cancelled') {
    return status('Stopped', worker.error || 'Completed work is kept.', 'neutral');
  }

  if (worker.control?.mode === 'fresh' && !bridge?.active) {
    if (worker.error) {
      return status('Ready to continue', worker.error, 'attention');
    }
    return status('Ready to continue', 'Continue fresh starts from the current files.', 'neutral');
  }

  if (worker.state === 'awaiting_approval' || (bridge?.active && bridge.phase === 'waiting_approval')) {
    return status('Approval needed', worker.error || 'Review the command before it runs.', 'attention');
  }

  if (bridge?.monitoring && bridge.receiving) {
    return status('Reading reply', bridge.reason, 'working');
  }

  if (bridge?.monitoring && bridge.phase === 'waiting_reply') {
    return status('Checking chat reply', bridge.reason, 'working');
  }

  if (bridge?.monitoring) {
    return status('Needs attention', bridge.reason, 'attention');
  }

  if (bridge?.active) {
    switch (bridge.phase) {
      case 'connecting':
        return status(
          'Connecting to ChatGPT',
          'Check that the chat has loaded; sign in if needed.',
          'working',
        );
      case 'sending':
        return status('Sending request', 'Sending the next step to ChatGPT.', 'working');
      case 'waiting_reply':
        return status('Waiting for ChatGPT', 'The task will continue when its reply is ready.', 'working');
      case 'reconnecting':
        return status('Reconnecting', 'Restoring the connection. Saved work is kept.', 'working');
      case 'repairing':
        return status('Repairing reply', 'Requesting a corrected reply from ChatGPT.', 'working');
      case 'waiting_team':
        return status('Waiting for another task', 'Waiting for shared work to finish.', 'working');
      case 'running':
        if (worker.state === 'verifying') {
          return status('Checking results', 'Running the task’s quality checks.', 'working');
        }
        if (worker.state === 'waiting_lock') {
          return status('Waiting for files', 'Another task is using these files.', 'working');
        }
        return status('Updating project', 'Working on the next steps.', 'working');
      default:
        return status('Working', 'Continuing the task.', 'working');
    }
  }

  if (bridge?.phase === 'error' || bridge?.errorCode) {
    return status(
      'Needs attention',
      bridge.reason || worker.error || 'Open chat to review what happened.',
      'attention',
    );
  }

  if (worker.state === 'blocked' || (worker.error && ['review', 'paused'].includes(worker.state))) {
    return status('Needs attention', worker.error || 'Review the task before continuing.', 'attention');
  }

  if (bridge?.phase === 'stopped') {
    return status('Paused', bridge.reason || worker.error || 'Continue when you’re ready.', 'neutral');
  }

  switch (worker.state) {
    case 'idle':
      return status('Ready to start', 'Start when you’re ready.', 'neutral');
    case 'queued':
      return status('Getting started', 'Preparing the next steps.', 'working');
    case 'planning':
      return status('Planning', 'Preparing the next steps.', 'working');
    case 'waiting_model':
      return status('Waiting for model', 'The task will continue when its reply is ready.', 'working');
    case 'waiting_lock':
      return status('Waiting for files', 'Another task is using these files.', 'working');
    case 'executing':
      return status('Updating project', 'Working on the next steps.', 'working');
    case 'verifying':
      return status('Checking results', 'Running the task’s quality checks.', 'working');
    case 'review':
      return status(
        'Ready to continue',
        'The current steps are done. Continue with the next step.',
        'neutral',
      );
    case 'paused':
      return status('Paused', 'Continue when you’re ready.', 'neutral');
  }
}
