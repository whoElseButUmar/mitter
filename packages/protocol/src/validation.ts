/** Safe, body-free model feedback. Never put a rejected value or source snippet
 * in diagnostics. A validation failure does not authorize any action. */
export interface ReplyIssue {
  stage:'schema'|'precondition'; code:string; message:string;
  field?:string; actionIndex?:number;
}
export class ReplyValidationError extends Error {
  readonly issue:ReplyIssue;
  constructor(issue:ReplyIssue) { super(issue.message); this.name='ReplyValidationError'; this.issue=issue; }
}
export function atAction(error:unknown,actionIndex:number):never {
  if(error instanceof ReplyValidationError)throw new ReplyValidationError({...error.issue,actionIndex});
  const detail=error instanceof Error?error.message:'';
  const message=detail.startsWith('Unexpected field:')?'The action contains unsupported fields.':
    detail&&detail.length<=240?detail:'The action does not match the tool schema.';
  throw new ReplyValidationError({stage:'schema',code:'INVALID_ACTION',actionIndex,message});
}
export function editBaseError(field:'base'|'expectedHash'):ReplyValidationError {
  return new ReplyValidationError({stage:'schema',code:field==='base'?'INVALID_BASE':'INVALID_EXPECTED_HASH',field,
    message:field==='base'?'base must be the exact r_ reference returned by read, or "missing" for a new file.':
      'expectedHash must be exactly 64 lowercase SHA-256 hex characters from a read, or "missing" for a new file. Prefer the read result’s base reference; never insert an explanation or calculate a hash yourself.'});
}
export function correctionAdvice(issue:ReplyIssue):string {
  const where=issue.actionIndex===undefined?'the action':`actions[${issue.actionIndex}] (action ${issue.actionIndex+1})`;
  const header=`REPLY VALIDATION: ${JSON.stringify({stage:issue.stage,code:issue.code,actionIndex:issue.actionIndex,field:issue.field})}\n${where}: ${issue.message}`;
  if(['INVALID_BASE','INVALID_EXPECTED_HASH','BASE_REQUIRED','BASE_CONFLICT','BASE_UNAVAILABLE','BASE_INCOMPLETE'].includes(issue.code))
    return header+'\nDo not repeat the rejected write yet. Return only read actions for the affected files, then wait for the report. Continue reading nextOffset pages when present. On the next turn copy the exact base reference into the edit; omit expectedHash when using base. Never guess, pad, trim or replace an unknown hash with the current file hash. Use base:"missing" only for a genuinely new file. No rejected actions ran.';
  return header+'\nCorrect the indicated action using the tool schema. No rejected actions ran. Do not repeat completed edits.';
}
