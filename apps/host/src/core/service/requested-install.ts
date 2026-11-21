import type { Action, Project, Worker } from '../../../../../packages/protocol/src/index.js';
import type { Store } from '../database.js';

export const requestedInstall: Extract<Action, { type: 'setupCommand' }> = {
  type: 'setupCommand',
  command: ['pnpm', 'install'],
  purpose: 'Install the project dependencies you requested.',
  effects:
    'Reads package.json, downloads dependencies, and writes node_modules and pnpm-lock.yaml in this project. Package scripts may run under your account.',
};

// Only affirmative, first-person instructions about the exact command authorize
// a setup request. Quoted examples and project/file contents are not requests.
export function wantsProjectInstall(instruction: string): boolean {
  const prose = instruction
    .replace(/```[\s\S]*?(?:```|$)|"[^"\n]*"|“[^”]*”|‘[^‘\n]*?’(?=\s|[.,;!?]|$)/g, ' ')
    .replace(/[’]/g, "'")
    .replace(/`(pnpm[ \t]+(?:install|i))`/gi, '$1')
    .replace(/`[^`\n]*`/g, ' ');
  const request =
    /(?:^|[.!?;,\n]|\band)\s*(?:then\s+)?(?:please\s+)?(?:i(?:'ll| will| am going to| want to| would like to)|let me)\s+(?:manually\s+)?(?:run|type|enter|execute)\s+pnpm[ \t]+(?:install|i)\b/gi;
  const continuation =
    /^(?:\s*(?:[.!?](?=\s|$)|\n|$)|\s*[,;]\s*(?:then\b|(?:and\s+)?(?:you|we|miter)\b)|\s+and\s+(?:then|you|we|miter)\b|\s+(?:myself|manually|in (?:the |my |miter\b)|from (?:the |my )|before\b|after\b|once\b|when\b))/i;
  let requestedAt = -1;
  for (const match of prose.matchAll(request)) {
    const end = match.index + match[0].length;
    if (continuation.test(prose.slice(end))) {
      requestedAt = end;
    }
  }
  if (requestedAt < 0) {
    return false;
  }
  // A later instruction can withdraw the install. Asking Miter not to run it
  // on the user's behalf still leaves the project-terminal option available.
  const cancellation =
    /(?:^|[.!?;,\n]|\bbut)\s*(?:(?:actually|instead|please)[, ]+)*(?:(?:skip|cancel|omit|forget)\s+(?:(?:the|that|this|my)\s+)?(?:pnpm\s+install|(?:dependency\s+)?install(?:ation)?)|i\s+(?:won't|will not)\s+(?:run|type|enter)\s+pnpm\s+install|(?:don't|do not)\s+(?:ask|prompt)\s+me\s+to\s+run\s+pnpm\s+install)\b(?=\s*(?:[.!?;,\n]|$))/i;
  return !cancellation.test(prose.slice(requestedAt));
}

export function requestedInstallId(batchId: string) {
  return batchId + '_requested_pnpm_install';
}

export function installDecisionKey(worker: Worker, project: Project) {
  return (
    'miter.requestedInstall.' + JSON.stringify([worker.runId, worker.activeFollowupId ?? null, project.root])
  );
}

export function recordInstallDecision(store: Store, worker: Worker, project: Project, ok: boolean) {
  if (store.get(installDecisionKey(worker, project)) === 'waived') {
    return;
  }
  let decision = 'failed';
  if (ok) {
    decision = 'resolved';
  }
  store.set(installDecisionKey(worker, project), decision);
}
