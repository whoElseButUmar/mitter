import { formatSetupCommand } from '../../../../packages/protocol/src/setup-command';
import type { Approval, Check, Worker } from '../../../../packages/protocol/src/index';

export const runningStates = new Set([
  'queued',
  'planning',
  'waiting_model',
  'waiting_lock',
  'executing',
  'verifying',
]);

export function isFreshContinuation(task: Worker | undefined): boolean {
  return task?.control?.mode === 'stopped' || task?.control?.mode === 'fresh';
}

export function approvalDescription(approval: Approval, platform = globalThis.navigator?.platform): string {
  if (approval.action.type === 'setupCommand') {
    if (platform?.startsWith('Win')) {
      return formatSetupCommand(approval.action.command, 'powershell');
    }
    return formatSetupCommand(approval.action.command);
  }
  const profile = approval.profile;
  if (profile) {
    return JSON.stringify([profile.program, ...profile.args], null, 2);
  }
  return JSON.stringify(approval.action, null, 2);
}

export function checkDescription(check: Check): string {
  switch (check.type) {
    case 'command': {
      return 'Pass: ' + check.profileId;
    }
    case 'exists': {
      return 'Exists: ' + check.path;
    }
    case 'contains': {
      return check.path + ' contains “' + check.text + '”';
    }
  }
}

export function chatStartLabel(task: Worker, preferReply: boolean, busy: boolean, start: string): string {
  if (isFreshContinuation(task)) {
    return 'Continue fresh';
  }
  if (preferReply) {
    return 'Use reply…';
  }
  if (busy) {
    return 'Connecting…';
  }
  return start;
}
