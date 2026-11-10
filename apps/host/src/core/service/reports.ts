import type {
  Action,
  CompletionRecord,
  Project,
  Worker,
} from '../../../../../packages/protocol/src/index.js';
import type { Store } from '../database.js';
import { renderObservations } from '../model-observations.js';

export function summarizeAction(action: Action): Action {
  switch (action.type) {
    case 'write': {
      return { ...action, content: `[${action.content.length} characters; omitted from status]` };
    }
    case 'replace': {
      return { ...action, before: action.before.slice(0, 180), after: action.after.slice(0, 180) };
    }
    default: {
      return action;
    }
  }
}

export function buildCompletion(
  worker: Worker,
  verification: CompletionRecord['verification'],
  summary: string,
  checked: number,
  at: number,
): CompletionRecord {
  const completion: CompletionRecord = { version: 1, verification, summary, checked, at };

  if (worker.activeFollowupId) {
    completion.followupId = worker.activeFollowupId;
  }

  return completion;
}

export function buildReport(
  worker: Worker,
  project: Project,
  followupPrompt: string,
  changedFiles: ReturnType<Store['changedFiles']>,
): string {
  const files = changedFiles
    .slice(0, 64)
    .map((edit) => `${edit.path}: ${edit.status}`)
    .join('\n');

  return (
    'MITTER REPORT — local project results\n' +
    `Project: ${project.name}\n` +
    `Worker: ${worker.name} (${worker.id})\n` +
    `Goal: ${worker.goal}\n` +
    `State: ${worker.state}\n` +
    `Checks: ${JSON.stringify(worker.checks)}\n` +
    `Completion: ${JSON.stringify(worker.completion ?? null)}\n` +
    `Error: ${worker.error ?? 'none'}\n\n` +
    `${followupPrompt}\n${renderObservations(worker.observations)}\n\n` +
    `Files journaled in this run:\n${files}\n` +
    '(Recent journal entries only; full history remains available locally.)\n\n' +
    'This report may contain proprietary code. Review it before pasting into an online chat. ' +
    'Redaction is best effort, not a guarantee.\n'
  );
}
