/** Body-free model feedback; a validation failure never authorizes an action. */
import type { ReplyIssue } from './schemas/issues.js';
export { replyIssueSchema, type ReplyIssue } from './schemas/issues.js';

export class ReplyValidationError extends Error {
  readonly issue: ReplyIssue;

  constructor(issue: ReplyIssue) {
    super(issue.message);
    this.name = 'ReplyValidationError';
    this.issue = issue;
  }
}

export function atAction(error: unknown, actionIndex: number): never {
  if (error instanceof ReplyValidationError) {
    throw new ReplyValidationError({ ...error.issue, actionIndex });
  }

  let detail = '';

  if (error instanceof Error) {
    detail = error.message;
  }

  let message = 'The action does not match the tool schema.';

  if (detail.startsWith('Unexpected field:')) {
    message = 'The action contains unsupported fields.';
  } else if (detail && detail.length <= 240) {
    message = detail;
  }

  throw new ReplyValidationError({
    stage: 'schema',
    code: 'INVALID_ACTION',
    actionIndex,
    message,
  });
}

export function editBaseError(field: 'base' | 'expectedHash'): ReplyValidationError {
  let code = 'INVALID_EXPECTED_HASH';
  let message =
    'expectedHash must be exactly 64 lowercase SHA-256 hex characters from a read, or ' +
    '"missing" for a new file. Prefer the read result’s base reference; never insert an explanation ' +
    'or calculate a hash yourself.';

  if (field === 'base') {
    code = 'INVALID_BASE';
    message = 'base must be the exact r_ reference returned by read, or "missing" for a new file.';
  }

  return new ReplyValidationError({ stage: 'schema', code, field, message });
}

export function correctionAdvice(issue: ReplyIssue): string {
  let where = 'the action';

  if (issue.actionIndex !== undefined) {
    where = `actions[${issue.actionIndex}] (action ${issue.actionIndex + 1})`;
  }

  const header = `REPLY VALIDATION: ${JSON.stringify({
    stage: issue.stage,
    code: issue.code,
    actionIndex: issue.actionIndex,
    field: issue.field,
  })}\n${where}: ${issue.message}`;

  if (
    [
      'INVALID_BASE',
      'INVALID_EXPECTED_HASH',
      'BASE_REQUIRED',
      'BASE_CONFLICT',
      'BASE_UNAVAILABLE',
      'BASE_INCOMPLETE',
    ].includes(issue.code)
  ) {
    return (
      header +
      '\nDo not repeat the rejected write yet. Return only read actions for the affected ' +
      'files, then wait for the report. Continue reading nextOffset pages when present. On the next turn ' +
      'copy the exact base reference into the edit; omit expectedHash when using base. Never guess, pad, ' +
      'trim or replace an unknown hash with the current file hash. Use base:"missing" only for a ' +
      'genuinely new file. No rejected actions ran.'
    );
  }

  return (
    header +
    '\nCorrect the indicated action using the tool schema. No rejected actions ran. ' +
    'Do not repeat completed edits.'
  );
}
