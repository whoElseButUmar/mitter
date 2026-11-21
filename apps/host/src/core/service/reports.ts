import { completionEvidenceSchema } from '../../../../../packages/protocol/src/index.js';
import type {
  Action,
  CompletionRecord,
  Project,
  Worker,
} from '../../../../../packages/protocol/src/index.js';
import { backendJourneyEvidenceSchema } from '../quality/browser-contract.js';
import type { Store } from '../database.js';
import { escapeChatJSON, renderObservations } from '../model-observations.js';
import { repairFindingText } from '../redaction.js';
import type { CheckResult } from './schemas.js';

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

function checkedPreview(results: readonly CheckResult[]) {
  const result = results.find(
    (item) =>
      item.ok &&
      item.check.type === 'quality' &&
      (item.check.name === 'browser' || item.check.name === 'dev-server'),
  );
  if (typeof result?.detail !== 'string') {
    return;
  }
  try {
    const detail: unknown = JSON.parse(result.detail);
    if (
      detail &&
      typeof detail === 'object' &&
      'staticPreview' in detail &&
      result.check.type === 'quality' &&
      result.check.name === 'browser'
    ) {
      const parsed = completionEvidenceSchema.shape.staticPreview.unwrap().safeParse(detail.staticPreview);
      if (parsed.success) {
        return { staticPreview: parsed.data };
      }
    }
    if (
      detail &&
      typeof detail === 'object' &&
      'devServer' in detail &&
      'devServerFingerprint' in detail &&
      (detail.devServer === 'vite' || detail.devServer === 'next') &&
      typeof detail.devServerFingerprint === 'string' &&
      /^[0-9a-f]{64}$/.test(detail.devServerFingerprint)
    ) {
      return { devServer: detail.devServer, devServerFingerprint: detail.devServerFingerprint } as const;
    }
  } catch {
    /* Historical browser checks can store plain text. */
  }
  return;
}

function coversBackend(result: CheckResult): boolean {
  if (
    result.check.type !== 'quality' ||
    result.check.name !== 'browser' ||
    !result.ok ||
    typeof result.detail !== 'string'
  ) {
    return false;
  }
  try {
    const detail: unknown = JSON.parse(result.detail);
    if (typeof detail === 'object' && detail && 'backend' in detail) {
      const evidence = backendJourneyEvidenceSchema.safeParse(detail.backend);
      return (
        evidence.success &&
        ['desktop', 'mobile'].every((device) => evidence.data.some((item) => item.device === device))
      );
    }
  } catch {
    // Historical checks can store plain text.
  }
  return false;
}

export function buildCompletion(
  worker: Worker,
  verification: CompletionRecord['verification'],
  summary: string,
  checked: number,
  at: number,
  results: readonly CheckResult[] = [],
): CompletionRecord {
  const completion: CompletionRecord = { version: 1, verification, summary, checked, at };

  if (worker.activeFollowupId) {
    completion.followupId = worker.activeFollowupId;
  }

  const quality = results.filter((result) => result.check.type === 'quality');

  if (quality.length > 0) {
    const passed = (name: string) => {
      const matching = quality.filter(
        (result) => result.check.type === 'quality' && result.check.name === name,
      );
      return verification === 'passed' && matching.length > 0 && matching.every((result) => result.ok);
    };
    let source: 'passed' | 'not-run' = 'not-run';
    let domain: 'passed' | 'not-run' = 'not-run';

    if (['components', 'syntax', 'snapshot'].every(passed)) {
      source = 'passed';
    }

    if (passed('tests') && passed('snapshot')) {
      domain = 'passed';
    }

    let browser: 'passed' | 'not-run' = 'not-run';
    let lighthouse: 'passed' | 'not-run' = 'not-run';
    let detail =
      'Source checks and declared domain tests do not verify rendered UI, accessibility or live HTTP behavior. Browser checks did not run.';
    if (passed('browser') && passed('snapshot')) {
      browser = 'passed';
    }
    if (passed('lighthouse') && passed('snapshot')) {
      lighthouse = 'passed';
    }
    if (domain === 'passed' && source === 'not-run') {
      detail = 'Domain tests passed in an isolated copy of the current project files.';
    }
    if (browser === 'passed' && lighthouse === 'passed') {
      detail =
        'Chrome user journeys and automated accessibility checks passed. All scored Lighthouse categories reached 100 on desktop and mobile for this snapshot. This does not establish WCAG conformance or deployed performance.';
      if (quality.some(coversBackend)) {
        detail +=
          ' Both devices submitted a new record and read it back from the running backend after browser storage was cleared.';
      }
    }
    const verifiedServer = passed('dev-server');
    if (verifiedServer && browser !== 'passed') {
      detail =
        'Miter installed the project dependencies and confirmed its development server answered a local HTTP request.';
    }
    completion.evidence = {
      source,
      domain,
      browser,
      lighthouse,
      detail,
      ...((verifiedServer || (browser === 'passed' && lighthouse === 'passed')) && checkedPreview(quality)),
    };
  }

  return completion;
}

function failedCheckFinding(result: CheckResult): string {
  const { check, detail } = result;
  if (check.type === 'exists') {
    return 'Missing required file ' + check.path;
  }
  if (check.type === 'contains') {
    if (detail) {
      return 'Could not read ' + check.path;
    }
    return check.path + ' must contain ' + JSON.stringify(check.text);
  }
  if (check.type === 'command') {
    let reason = 'no output';
    if (detail && typeof detail !== 'string') {
      reason = detail.stderr.trim() || detail.stdout.trim() || 'exit code ' + detail.code;
    }
    return check.profileId + ': ' + reason;
  }
  const labels = {
    skills: 'Skills',
    components: 'UI components',
    syntax: 'JavaScript',
    tests: 'Domain tests',
    browser: 'Chrome',
    lighthouse: 'Lighthouse',
    snapshot: 'Project files',
    'dev-server': 'App server',
  };
  const label = labels[check.name];
  if (result.finding) {
    return label + ': ' + result.finding;
  }
  if (typeof detail !== 'string' || !detail || detail.startsWith('{')) {
    return label + ' check failed';
  }
  if (check.name === 'tests') {
    const failedTest = /^\s*not ok\s+\d+ - (.+)$/m.exec(detail);
    if (failedTest) {
      return label + ': ' + failedTest[1];
    }
  }
  return label + ': ' + detail;
}

export function completionFailureMessage(results: readonly CheckResult[]): string {
  const failed = results.filter((result) => !result.ok);
  const messages = failed.slice(0, 3).map((result) => {
    const finding = repairFindingText(failedCheckFinding(result));
    if (finding.length > 480) {
      return finding.slice(0, 479) + '…';
    }
    return finding;
  });
  if (failed.length > messages.length) {
    messages.push('Additional failed checks: ' + (failed.length - messages.length));
  }
  return messages.join('\n');
}

export function completionEventMessage(completion: CompletionRecord): string {
  if (completion.verification === 'not-run') {
    return 'Finished. No completion checks were configured.';
  }

  if (completion.verification !== 'passed') {
    return 'Finished. Passing verification was not recorded.';
  }

  const evidence = completion.evidence;
  if (!evidence) {
    return 'Finished. Applicable completion checks passed.';
  }

  const passed: string[] = [];
  const notRun: string[] = [];
  const notRecorded: string[] = [];
  for (const check of [
    { name: 'source', status: evidence.source },
    { name: 'domain', status: evidence.domain },
    { name: 'browser', status: evidence.browser },
    { name: 'Lighthouse', status: evidence.lighthouse },
  ]) {
    if (check.status === 'passed') {
      passed.push(check.name);
    } else if (check.status === 'not-run') {
      notRun.push(check.name);
    } else {
      notRecorded.push(check.name);
    }
  }

  let message = 'Finished.';
  if (passed.length > 0) {
    message += ' Checks passed: ' + passed.join(', ') + '.';
  }
  if (notRun.length > 0) {
    message += ' Not run: ' + notRun.join(', ') + '.';
  }
  if (notRecorded.length > 0) {
    message += ' Not recorded: ' + notRecorded.join(', ') + '.';
  }
  return message;
}

export function buildReport(
  worker: Worker,
  project: Project,
  followupPrompt: string,
  changedFiles: ReturnType<Store['changedFiles']>,
  setupNote = '',
): string {
  const files = changedFiles
    .slice(0, 64)
    .map((edit) => `${edit.path}: ${edit.status}`)
    .join('\n');
  let error = 'none';
  if (worker.error !== undefined) {
    error = escapeChatJSON(JSON.stringify(worker.error));
  }

  return (
    'MITTER REPORT — local project results\n' +
    `Project: ${project.name}\n` +
    `Worker: ${worker.name} (${worker.id})\n` +
    `Goal: ${worker.goal}\n` +
    `State: ${worker.state}\n` +
    `Checks: ${escapeChatJSON(JSON.stringify(worker.checks))}\n` +
    `Completion: ${escapeChatJSON(JSON.stringify(worker.completion ?? null))}\n` +
    `Error: ${error}\n\n` +
    setupNote +
    `${followupPrompt}\n${renderObservations(worker.observations)}\n\n` +
    `Files journaled in this run:\n${files}\n` +
    '(Recent journal entries only; full history remains available locally.)\n\n' +
    'This report may contain proprietary code. Review it before pasting into an online chat. ' +
    'Redaction is best effort, not a guarantee.\n'
  );
}
