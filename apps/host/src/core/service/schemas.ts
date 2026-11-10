import { z } from 'zod';
import { checkSchema, envelopeSchema, profileSchema } from '../../../../../packages/protocol/src/index.js';
import { taskProgressSchema } from '../../../../../packages/bridge/src/progress.js';
import { controlResultSchema } from '../../../../../packages/protocol/src/rpc.js';
export { controlResultSchema, followupActivationSchema } from '../../../../../packages/protocol/src/rpc.js';
export type { ControlResult, FollowupActivation } from '../../../../../packages/protocol/src/rpc.js';
import { commandResultSchema } from '../commands.js';
import { identifierSchema as protocolIdentifierSchema } from '../../../../../packages/protocol/src/schemas/primitives.js';
import { sha256Schema as hashSchema, skippedEditSchema } from '../storage-schemas.js';

export { commandResultSchema } from '../commands.js';
export { skippedEditSchema } from '../storage-schemas.js';

const identifierSchema = protocolIdentifierSchema('saved record identifier');
const counterSchema = z.number().int().nonnegative().describe('A non-negative saved counter.');

const startedCommandSchema = z
  .object({
    status: z.literal('started').describe('Command intent was saved before launching the process.'),
    workerId: identifierSchema.describe('The task that launched the command.'),
    profile: profileSchema.describe('The reviewed profile saved before the process launched.'),
    time: counterSchema.describe('When command intent was saved.'),
  })
  .describe('A command whose side effects may still be unknown.');

const interruptedCommandSchema = z
  .object({
    status: z.literal('interrupted').describe('The command was cancelled or timed out.'),
    workerId: identifierSchema.describe('The task that launched the command.'),
    result: commandResultSchema.describe('The observed output before interruption.'),
  })
  .describe('An interrupted command that must never be replayed automatically.');

const finishedCommandSchema = z
  .object({
    status: z.literal('finished').describe('The command returned a final result.'),
    workerId: identifierSchema.describe('The task that launched the command.'),
    result: commandResultSchema.describe('The exact result retained for acknowledgement recovery.'),
  })
  .describe('A completed command retained without running it again.');

export const commandJournalSchema = z
  .discriminatedUnion('status', [startedCommandSchema, interruptedCommandSchema, finishedCommandSchema])
  .describe('The durable execution boundary for one command action.');

export type CommandJournal = z.infer<typeof commandJournalSchema>;

export const controlOperationSchema = z
  .object({
    signature: hashSchema.describe('The fingerprint of the task and exact control request.'),
    result: controlResultSchema.describe('The original acknowledgement returned for exact retries.'),
  })
  .describe('A saved control acknowledgement that cannot authorize a different request.');

export type ControlOperation = z.infer<typeof controlOperationSchema>;

export function readControlOperation(value: unknown, operationId: string): ControlOperation | undefined {
  if (value === undefined) {
    return;
  }

  const parsed = controlOperationSchema
    .refine((operation) => operation.result.operationId === operationId, {
      message: 'The saved acknowledgement belongs to another control operation.',
      path: ['result', 'operationId'],
    })
    .safeParse(value);

  if (!parsed.success) {
    throw new Error('Saved run-control acknowledgement is invalid. It was not overwritten.', {
      cause: parsed.error,
    });
  }

  return parsed.data;
}

export const retiredQueueSchema = z
  .object({
    workerId: identifierSchema.describe('The task whose remaining plan was retired.'),
    runId: identifierSchema.describe('The run that owned the retired plan.'),
    queue: z.array(envelopeSchema).describe('The exact unexecuted batches retained for inspection.'),
    cursor: counterSchema.describe('The settled cursor in the retired queue head.'),
    at: counterSchema.describe('When the queue was archived.'),
  })
  .describe('An archived plan that must never be resumed automatically.');

export type RetiredQueue = z.infer<typeof retiredQueueSchema>;

export const controlArchiveSchema = retiredQueueSchema
  .extend({
    progress: taskProgressSchema.optional().describe('Progress before the stop fence was published.'),
    kind: z.enum(['steer', 'stop']).describe('The user operation that retired this plan.'),
  })
  .describe('The queue and progress preserved before a task interruption.');

export type ControlArchive = z.infer<typeof controlArchiveSchema>;

export type SkippedEdit = z.infer<typeof skippedEditSchema>;

export const verificationIntentSchema = z
  .object({
    status: z.literal('started').describe('Fresh verification intent was saved before checks ran.'),
    time: counterSchema.describe('When this verification attempt started.'),
    revision: counterSchema.describe('The project revision before the checks ran.'),
  })
  .describe('A verification attempt that cannot reuse stale command output.');

export type VerificationIntent = z.infer<typeof verificationIntentSchema>;

export const checkResultSchema = z
  .object({
    check: checkSchema.describe('The configured check that was performed.'),
    ok: z.boolean().describe('Whether this check passed.'),
    detail: z
      .union([commandResultSchema, z.string()])
      .optional()
      .describe('Command output or the reason a file check failed.'),
  })
  .describe('The evidence from one configured completion check.');

export type CheckResult = z.infer<typeof checkResultSchema>;

export const verificationResultSchema = z
  .object({
    ok: z.boolean().describe('Whether every configured check passed.'),
    results: z.array(checkResultSchema).describe('Check evidence in command-first order.'),
    requiresHumanAcceptance: z
      .literal(false)
      .describe('Explicit finish no longer requires a separate acceptance click.'),
    verification: z
      .enum(['passed', 'not-run'])
      .describe('Whether automated checks were configured for this finish.'),
    summary: z.string().describe('The summary supplied by the explicit finish action.'),
  })
  .describe('Completion-check evidence; failed checks do not authorize completion.');

export type VerificationResult = z.infer<typeof verificationResultSchema>;

export const repairFileEvidenceSchema = z
  .union([
    z
      .object({
        path: z.string().describe('The file whose edit precondition failed.'),
        hash: hashSchema.describe('The exact current file hash, not a replacement edit precondition.'),
        bytes: counterSchema.describe('The current file size in UTF-8 bytes.'),
        content: z
          .string()
          .optional()
          .describe('Complete small-file content when it fits the evidence budget.'),
        contentOmitted: z
          .boolean()
          .optional()
          .describe('Whether the complete source was intentionally omitted.'),
      })
      .describe('Current file evidence without silently truncating source content.'),
    z
      .object({
        path: z.string().describe('The file that could not be inspected.'),
        error: z.string().describe('Why current file evidence was unavailable.'),
      })
      .describe('A failed attempt to inspect current file content.'),
  ])
  .describe('Current file evidence used to explain an edit conflict.');

export type RepairFileEvidence = z.infer<typeof repairFileEvidenceSchema>;

export const editRepairSchema = z
  .object({
    code: z
      .enum(['STALE_EDIT', 'REPLACE_MATCH', 'EDIT_OUTPUT'])
      .describe('The reason edit preflight failed.'),
    batchId: identifierSchema.describe('The batch whose unapplied remainder was retired.'),
    actionIndex: counterSchema.describe('The index of the conflicting edit.'),
    path: z.string().describe('The path of the conflicting edit.'),
    message: z.string().describe('The preflight failure reported by the edit planner.'),
    current: repairFileEvidenceSchema,
    applied: z
      .array(
        z
          .object({
            actionId: z.string().describe('The journaled action that already committed.'),
            path: z.string().describe('The path changed by that action.'),
            hash: hashSchema.describe('The recorded hash after that action.'),
          })
          .describe('One already-applied edit retained in the journal.'),
      )
      .describe('Successful edits that must be kept.'),
    discarded: z
      .array(
        z
          .object({
            batchId: identifierSchema.describe('A batch whose remaining actions were set aside.'),
            remainingActions: counterSchema.describe('The number of actions not yet executed in that batch.'),
          })
          .describe('One retired batch remainder.'),
      )
      .describe('Retired actions that were not executed by this repair.'),
    next: z.string().describe('Instructions to replan from current files without replaying completed edits.'),
  })
  .describe('Complete audit evidence for a rejected edit plan.');

export type EditRepair = z.infer<typeof editRepairSchema>;

export const editRepairArchiveSchema = z
  .object({
    version: z.literal(1).describe('The edit repair archive format version.'),
    workerId: identifierSchema.describe('The task whose edit plan was retired.'),
    runId: identifierSchema.describe('The run containing the rejected plan.'),
    cursor: counterSchema.describe('The cursor before the remaining plan was retired.'),
    batches: z.array(envelopeSchema).describe('The exact batches retained for local inspection.'),
    repair: editRepairSchema,
    time: counterSchema.describe('When the repair archive was saved.'),
  })
  .describe('The full edit repair audit record, independent of prompt budgets.');

export type EditRepairArchive = z.infer<typeof editRepairArchiveSchema>;

export const editRepairObservationSchema = editRepairSchema
  .extend({
    appliedOmitted: counterSchema.describe('Applied entries omitted only from this bounded observation.'),
    discardedOmitted: counterSchema.describe('Retired entries omitted only from this bounded observation.'),
  })
  .describe('A complete JSON repair observation with explicit evidence omissions.');

export type EditRepairObservation = z.infer<typeof editRepairObservationSchema>;
