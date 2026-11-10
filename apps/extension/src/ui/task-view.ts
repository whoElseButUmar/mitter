import type { Approval, Check, Project, Worker } from '../../../../packages/protocol/src/index';

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

export function approvalDescription(approval: Approval): string {
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

export function welcomeCopy(project: Project | undefined, taskCount: number, projectCount: number) {
  if (project) {
    if (taskCount > 0) {
      return {
        title: 'No open task tabs.',
        text: 'Your tasks are saved. Open one from the task list, or start another.',
      };
    }
    return {
      title: 'No tasks yet.',
      text: 'Give ' + project.name + ' its first task.',
    };
  }
  if (projectCount > 0) {
    return {
      title: 'No open project tabs.',
      text: 'Your projects are saved. Open a project from the list, or choose another folder.',
    };
  }
  return {
    title: 'Open a project.',
    text: 'Choose a folder, then give Miter a task.',
  };
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
