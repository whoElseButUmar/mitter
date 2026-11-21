import { z } from 'zod';
import { activitySchema, workerStateSchema } from '../schemas/domain.js';
import { replyIssueSchema } from '../schemas/issues.js';
import { identifierSchema } from '../schemas/primitives.js';
import { rpcCounterSchema } from './primitives.js';

export const projectContextSchema = z
  .strictObject({
    mission: z.string().describe('The saved project goal, or an empty string when unset.'),
    conventions: z.string().describe('The saved project conventions, or an empty string when unset.'),
  })
  .describe('The project context returned to the user and task prompts.');

export const workerSetupDecisionResultSchema = z
  .strictObject({
    accepted: z.literal(true).describe('The native host accepted this decision.'),
    sessionId: identifierSchema('terminal session ID')
      .optional()
      .describe('The terminal to show when the user chose manual entry.'),
  })
  .describe('Acknowledgement of one command decision. Its execution outcome follows in the task report.');

export const historyResultSchema = z
  .strictObject({
    events: z
      .array(activitySchema)
      .describe('Complete activity identities with bounded display messages, newest first.'),
    hasMore: z.boolean().describe('Whether older task events remain available.'),
    before: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe('The oldest returned event ID, or null for an empty page.'),
  })
  .describe('A task history page whose cursor preserves access to older retained events.');

export const handoffSeenResultSchema = z
  .strictObject({
    seen: z.boolean().describe('Whether this exact envelope was previously admitted by this task.'),
  })
  .describe('An envelope ownership lookup; it does not authorize import or replay.');

export const replyValidationResultSchema = z
  .discriminatedUnion('valid', [
    z
      .strictObject({
        valid: z.literal(true).describe('The reply passed admission preflight, without execution.'),
      })
      .describe('A valid reply proposal, not an import or approval receipt.'),
    z
      .strictObject({
        valid: z.literal(false).describe('The reply was rejected without importing or executing actions.'),
        issue: replyIssueSchema.describe(
          'Body-free structured failure feedback with its original stable code.',
        ),
      })
      .describe('A rejected proposal with safe structured feedback.'),
  ])
  .describe('The complete worker.validateReply result, preserving structured precondition/schema failures.');

export const steerValidationResultSchema = z
  .strictObject({
    valid: z.literal(true).describe('The steering request passed preflight without replacing current work.'),
    alreadyApplied: z.boolean().describe('Whether this exact control request was previously applied.'),
  })
  .describe('Steering validation or exact-retry recognition; it does not itself stop work.');

export const importResultSchema = z
  .union([
    z
      .strictObject({ queued: z.literal(true).describe('The new handoff was admitted to the task queue.') })
      .describe('A newly admitted handoff.'),
    z
      .strictObject({
        queued: z.boolean().describe('Whether the exact previously admitted envelope remains queued.'),
        acknowledged: z
          .literal(true)
          .describe('A matching durable receipt acknowledged an exact import retry.'),
      })
      .describe('An exact import acknowledgement recovered without replay.'),
  ])
  .describe('A handoff admission receipt, including exact import reconciliation without repeated actions.');

export const runResultSchema = z
  .union([
    z
      .strictObject({
        started: z.literal(true).describe('Execution was admitted; completion is not implied.'),
      })
      .describe('A newly admitted execution start.'),
    z
      .strictObject({
        started: z.literal(true).describe('Durable start intent already exists for this exact batch.'),
        acknowledged: z
          .literal(true)
          .describe('The original start was recognized without starting it again.'),
        state: workerStateSchema.describe(
          'The task lifecycle state observed during acknowledgement recovery.',
        ),
      })
      .describe('An exact start acknowledgement recovered without replay.'),
  ])
  .describe('The worker.run receipt, retaining no-replay acknowledgement and observed state.');

export const resumeResultSchema = z
  .strictObject({ started: z.literal(true).describe('Execution was admitted; completion is not implied.') })
  .describe('Acknowledgement that worker.resume admitted execution.');

export const cancelResultSchema = z
  .strictObject({
    stopping: z.boolean().describe('Whether owned execution is still settling after cancellation.'),
  })
  .describe('A cancellation receipt; stopping false means no owned execution remains.');

export const pauseResultSchema = z
  .union([
    cancelResultSchema,
    z
      .strictObject({
        stopping: z.literal(false).describe('No execution remains to pause.'),
        completed: z.literal(true).describe('Final verification already completed before the pause arrived.'),
      })
      .describe('A pause that retained an already completed task.'),
    z
      .strictObject({
        stopping: z.literal(false).describe('No execution remains to pause.'),
        review: z.literal(true).describe('The task was already at an empty-queue review boundary.'),
      })
      .describe('A pause that retained an existing review boundary.'),
  ])
  .describe('The full worker.pause receipt, including retained completion and review outcomes.');

export const approveResultSchema = z
  .union([
    z
      .strictObject({
        denied: z.literal(true).describe('The reviewed action was denied and its token consumed.'),
      })
      .describe('An explicit approval denial.'),
    z
      .strictObject({
        approved: z.literal(true).describe('The exact token/revision-bound action was approved.'),
      })
      .describe('An exact reviewed approval and admitted execution start.'),
  ])
  .describe('An approval choice receipt; it never grants trust to a different batch.');

export const skipResultSchema = z
  .strictObject({
    skipped: z.literal(true).describe('One confirmed queued action was skipped without execution.'),
  })
  .describe('Acknowledgement of skipping one quarantined or unwanted action.');

export const acceptResultSchema = z
  .union([
    z
      .strictObject({
        accepted: z.literal(true).describe('A compatible legacy finish was manually accepted.'),
      })
      .describe('Legacy manual goal acceptance, not independently proven verification.'),
    z
      .strictObject({
        accepted: z.literal(false).describe('No new acceptance was applied.'),
        alreadyComplete: z.literal(true).describe('The empty-queue task was already complete.'),
      })
      .describe('An idempotent legacy acceptance of an already complete task.'),
  ])
  .describe('The full legacy acceptance receipt, preserving already-complete acknowledgements.');

export const controlResultSchema = z
  .strictObject({
    stopped: z.boolean().describe('Whether the task remains stopped.'),
    ready: z.boolean().describe('Whether fresh steering is ready to continue.'),
    epoch: rpcCounterSchema.describe('The task epoch after the control operation.'),
    operationId: identifierSchema('saved record identifier').describe(
      'The exact user control operation acknowledged.',
    ),
  })
  .describe('The acknowledgement of one exact stop or steering operation.');

export const stopResultSchema = controlResultSchema
  .extend({
    stopped: z.literal(true).describe('The task is fenced against replay of its old plan.'),
    ready: z.literal(false).describe('Fresh continuation has not yet been requested.'),
  })
  .describe('A durable stop acknowledgement bound to its exact operation and new epoch.');

export const steerResultSchema = controlResultSchema
  .extend({
    stopped: z.literal(false).describe('The prior plan was stopped and new steering is ready.'),
    ready: z.literal(true).describe('A fresh steering instruction is ready to continue.'),
  })
  .describe('A durable steering acknowledgement bound to its exact operation and new epoch.');

export const continueFreshResultSchema = z
  .union([
    z
      .strictObject({
        ready: z.boolean().describe('Whether this task is already in fresh continuation mode.'),
      })
      .describe('An unchanged fresh-continuation status.'),
    z
      .strictObject({
        ready: z.literal(true).describe('The task was rearmed for fresh continuation, without replay.'),
        epoch: rpcCounterSchema.describe('The retained user control epoch that fences the retired plan.'),
      })
      .describe('An acknowledged transition from stopped to fresh continuation.'),
  ])
  .describe('The full worker.continueFresh receipt; completed edits and retired-plan fences are retained.');

export const followupCancelResultSchema = z
  .strictObject({ cancelled: z.literal(true).describe('The queued or blocked follow-up was cancelled.') })
  .describe('Acknowledgement of removing a follow-up before it becomes active.');

export const followupActivationSchema = z
  .strictObject({
    activated: z.boolean().describe('Whether the next follow-up became active.'),
    id: identifierSchema('saved record identifier')
      .optional()
      .describe('The newly active follow-up, when activated.'),
    reason: z.string().optional().describe('Why the follow-up could not start yet, when known.'),
  })
  .refine((value) => value.activated === (value.id !== undefined), {
    message: 'An activated follow-up must identify the exact follow-up it started.',
  })
  .describe('The complete follow-up activation result, bound to an exact ID when successful.');

export const promptResultSchema = z
  .string()
  .describe('The literal bounded-context prompt returned for this task.');
export const reportResultSchema = z
  .string()
  .describe('The literal task report with bounded redacted context.');

export type ProjectContext = z.infer<typeof projectContextSchema>;
export type HistoryResult = z.infer<typeof historyResultSchema>;
export type ImportResult = z.infer<typeof importResultSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
export type PauseResult = z.infer<typeof pauseResultSchema>;
export type ApproveResult = z.infer<typeof approveResultSchema>;
export type AcceptResult = z.infer<typeof acceptResultSchema>;
export type ControlResult = z.infer<typeof controlResultSchema>;
export type FollowupActivation = z.infer<typeof followupActivationSchema>;
