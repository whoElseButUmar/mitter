import { z } from 'zod';
import { checkSchema, teamMessageActionSchema } from '../schemas/actions.js';
import { profileSchema, taskBoundarySchema } from '../schemas/domain.js';
import { settingsSchema } from '../schemas/model-settings.js';
import { followupRequestSchema } from '../schemas/requests.js';
import { identifierSchema, integerSchema, textSchema } from '../schemas/primitives.js';
import { DEFAULT_SETTINGS } from '../model-settings.js';
import { MAX_HANDOFF_BYTES, exceedsHandoffBytes } from '../reply-json.js';
import { stateBackupIdSchema } from './system.js';

export function optionalRpcFlagSchema(label: string) {
  return z
    .boolean({ error: 'Invalid ' + label + '. Use true or false.' })
    .optional()
    .describe('An explicit boolean ' + label + ', or absence for the existing default behavior.');
}

export const promptKindSchema = z
  .enum(['bootstrap', 'review', 'fix', 'next'], {
    error: 'Choose bootstrap, review, fix or next for the prompt.',
  })
  .optional()
  .default('bootstrap')
  .describe('The chat prompt purpose; absence selects the initial task prompt.');

export const browsePathSchema = z
  .string({ error: 'Invalid browse path. Use a relative project path.' })
  .optional()
  .default('.')
  .describe('The literal relative folder to browse; absence selects the project root.');

export const handoffTextSchema = textSchema('handoff', MAX_HANDOFF_BYTES)
  .refine((value) => !exceedsHandoffBytes(value), {
    error: 'Handoff is too large. Split it into smaller batches.',
  })
  .describe(
    'Literal handoff JSON or fence syntax, bounded in UTF-16 units and UTF-8 bytes; never normalized here.',
  );

export const workerCreationSchema = z
  .object({
    checks: z.array(checkSchema).max(20).describe('The configured goal checks for this task.'),
    mode: z
      .enum(['handoff', 'local'], { error: 'Choose handoff or local mode.' })
      .describe('Whether the task uses chat handoffs or a local model.'),
    goal: textSchema('goal', 4000).describe('The user task goal, trimmed explicitly by the creation parser.'),
    name: textSchema('worker name', 60).describe('The task name or a name suggested from its goal.'),
    maxIterations: integerSchema('iterations', 1, 100).describe(
      'The creation-time local proposal iteration limit.',
    ),
    maxMinutes: integerSchema('minutes', 1, 240).describe('The creation-time active run limit in minutes.'),
  })
  .describe('Validated task creation fields; persisted follow-ups may later increase these budgets.');

const commandTextSchema = z
  .string()
  .refine((value) => !value.includes('\0'), 'NUL is not allowed.')
  .describe('A literal command field without NUL characters.');

export const commandProfileInputSchema = profileSchema
  .extend({
    id: commandTextSchema
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .describe('A command profile ID with 1–100 ASCII letters, digits, underscores or hyphens.'),
    label: commandTextSchema
      .min(1)
      .max(80)
      .refine((value) => !!value.trim())
      .describe('The reviewed command label; at most 80 UTF-16 code units and not blank.'),
    program: commandTextSchema
      .min(1)
      .max(1000)
      .refine((value) => !!value.trim())
      .describe('The literal executable name or path; at most 1000 UTF-16 code units and not blank.'),
    args: z
      .array(commandTextSchema.max(4000))
      .max(50)
      .describe('At most 50 literal arguments, each at most 4000 UTF-16 code units.'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(600000)
      .nullish()
      .transform((value) => value ?? 120000)
      .describe('The timeout in milliseconds, from 1000 to 600000; legacy absence or null means 120000.'),
  })
  .strict()
  .describe('An explicit command profile request, still subject to host refusal and approval rules.');

export const modelSettingsInputSchema = z
  .strictObject({
    coderModelPath: settingsSchema.shape.coderModelPath
      .nullish()
      .transform((value) => value ?? DEFAULT_SETTINGS.coderModelPath)
      .describe('The literal local model path; legacy absence or null uses the empty default.'),
    contextSize: settingsSchema.shape.contextSize
      .nullish()
      .transform((value) => value ?? DEFAULT_SETTINGS.contextSize)
      .describe('The model context token count; legacy absence or null uses the shared default.'),
    maxTokens: settingsSchema.shape.maxTokens
      .nullish()
      .transform((value) => value ?? DEFAULT_SETTINGS.maxTokens)
      .describe('The output token limit; legacy absence or null uses the shared default.'),
    gpu: settingsSchema.shape.gpu
      .nullish()
      .transform((value) => value ?? DEFAULT_SETTINGS.gpu)
      .describe('The device choice; legacy absence or null uses the shared default.'),
  })
  .pipe(settingsSchema)
  .describe('The existing strict model-settings request, including its explicit nullish defaults.');

// Service historically ignores unused outer parameters. Only known request fields
// are retained; nested authority-bearing requests keep their owner's strict schema.
export const emptyRpcParamsSchema = z.object({}).describe('No operation-specific parameters are required.');

export const projectParamsSchema = z
  .object({
    projectId: identifierSchema('project ID').describe('The registered project selected by the caller.'),
  })
  .describe('A request bound to one registered project.');

export const workerParamsSchema = z
  .object({
    workerId: identifierSchema('worker ID').describe('The task selected by the caller.'),
    expectedRun: taskBoundarySchema.optional().describe('The exact reviewed run and epoch, when supplied.'),
  })
  .describe('A task request; the host must match a supplied reviewed boundary before mutation.');

export const epochParamsSchema = workerParamsSchema
  .extend({
    epoch: integerSchema('epoch', 0, Number.MAX_SAFE_INTEGER)
      .optional()
      .describe(
        'The execution epoch reviewed by the caller; absence retains the existing legacy gate behavior.',
      ),
  })
  .describe('A task request carrying its optional execution epoch and reviewed run boundary.');

export const verifyBackupParamsSchema = z
  .object({
    id: textSchema('backup ID', 100)
      .pipe(stateBackupIdSchema)
      .describe('The path-safe ID of a listed state backup.'),
  })
  .describe('A request to verify one private state snapshot without restoring anything.');

export const projectReadParamsSchema = projectParamsSchema
  .extend({
    path: textSchema('file path', 1000).describe('The literal project-relative source path.'),
  })
  .describe('A complete source read from the selected registered project.');

export const projectContextParamsSchema = projectParamsSchema
  .extend({
    save: optionalRpcFlagSchema('project context save').describe('Only literal true saves project context.'),
    mission: textSchema('project goal', 4000, true)
      .nullish()
      .transform((value) => value ?? '')
      .describe('The literal project goal; absence or null clears it when save is true.'),
    conventions: textSchema('conventions', 4000, true)
      .nullish()
      .transform((value) => value ?? '')
      .describe('The literal project conventions; absence or null clears them when save is true.'),
  })
  .describe('A project context read or atomic explicit update of both saved context fields.');

export const projectRenameParamsSchema = projectParamsSchema
  .extend({
    name: textSchema('project name', 60).describe(
      'The new project display name, trimmed explicitly by the host.',
    ),
  })
  .describe('A user-requested project rename.');

export const projectAddParamsSchema = z
  .object({
    root: textSchema('project root', 2000).describe(
      'The literal absolute folder path, checked by the host filesystem.',
    ),
    name: textSchema('project name', 60).describe(
      'The project display name; registration preserves its whitespace.',
    ),
  })
  .describe('Project registration fields validated before filesystem resolution.');

export const projectProfileParamsSchema = projectParamsSchema
  .extend({
    profile: commandProfileInputSchema.describe(
      'The exact reviewed profile, not arbitrary model shell input.',
    ),
  })
  .describe('An explicit project command-profile change, subject to active-worker and host refusal gates.');

export const workerCreateParamsSchema = projectParamsSchema
  .extend({
    checks: workerCreationSchema.shape.checks
      .nullish()
      .transform((value) => value ?? [])
      .describe('Up to twenty configured checks; legacy absence or null means no objective checks.'),
    mode: workerCreationSchema.shape.mode,
    goal: workerCreationSchema.shape.goal,
    name: z
      .union([
        workerCreationSchema.shape.name,
        z
          .string()
          .refine((value) => !value.trim())
          .describe('A blank legacy name requests a suggested name, regardless of its whitespace length.'),
      ])
      .optional()
      .describe('An optional display name; an absent or blank name is suggested from the goal.'),
    maxIterations: workerCreationSchema.shape.maxIterations
      .nullish()
      .transform((value) => value ?? 8)
      .describe('The initial iteration budget; legacy absence or null means eight iterations.'),
    maxMinutes: workerCreationSchema.shape.maxMinutes
      .nullish()
      .transform((value) => value ?? 15)
      .describe('The initial active-time budget in minutes; legacy absence or null means fifteen minutes.'),
    workspaceMode: z
      .enum(['shared', 'worktree'], { error: 'Choose shared workspace or worktree.' })
      .optional()
      .describe('The explicit workspace mode; absence uses the registered shared workspace.'),
  })
  .describe('Task creation parameters; creation limits are not limits on later persisted follow-up budgets.');

export const settingsUpdateParamsSchema = z
  .object({
    settings: modelSettingsInputSchema.describe('The explicit local inference settings update.'),
  })
  .describe('A strict settings update, permitted only when local workers are paused.');

export const workerReadParamsSchema = workerParamsSchema
  .extend({
    path: textSchema('path', 1000).describe('The literal project-relative source path.'),
  })
  .describe('A complete source read from the task execution root.');

export const workerBrowseParamsSchema = workerParamsSchema
  .extend({
    path: browsePathSchema,
  })
  .describe('A recursive confined file listing from the task execution root.');

export const workerAssetParamsSchema = workerParamsSchema
  .extend({
    stamp: textSchema('stamp', 64)
      .optional()
      .describe('The previous literal file-identity stamp, when continuing a preview.'),
    path: textSchema('path', 1000).describe('The literal project-relative preview path.'),
    offset: integerSchema('offset', 0, 24 * 1024 * 1024)
      .nullish()
      .transform((value) => value ?? 0)
      .describe('The starting byte offset; legacy absence or null starts at zero.'),
    length: integerSchema('chunk size', 1, 192000)
      .nullish()
      .transform((value) => value ?? 192000)
      .describe('The requested chunk size in bytes; legacy absence or null requests 192000 bytes.'),
  })
  .describe('A bounded ordinary-file preview request with optional identity continuity.');

export const workerOpenFileParamsSchema = workerParamsSchema
  .extend({
    application: z
      .enum(['finder', 'vscode'], { error: 'Choose Finder or VS Code.' })
      .describe('The desktop application explicitly selected by the user.'),
    path: textSchema('path', 1000).describe('The confined project-relative file to open.'),
  })
  .describe('An explicit desktop file-open request, never a model action.');

export const workerFollowupParamsSchema = workerParamsSchema
  .extend({
    request: followupRequestSchema.describe(
      'The user-owned instruction, exact selection and stable request ID.',
    ),
  })
  .describe(
    'A follow-up or steering request retaining the shared selection and auto-start compatibility rules.',
  );

export const workerFollowupCancelParamsSchema = workerParamsSchema
  .extend({
    id: identifierSchema().describe('The exact queued or blocked follow-up to cancel.'),
  })
  .describe('A request to cancel a not-yet-active follow-up.');

export const workerTeamMessageParamsSchema = workerParamsSchema
  .extend({
    message: teamMessageActionSchema.shape.message.describe(
      'The literal cooperative context, bounded to 3000 UTF-16 units.',
    ),
    to: teamMessageActionSchema.shape.to.describe(
      'An optional peer ID; malformed recipients must never become broadcast.',
    ),
    id: identifierSchema().describe('The stable user message ID used for acknowledgement recovery.'),
  })
  .describe('A user-requested team message; peer context never grants execution or approval authority.');

export const workerRenameParamsSchema = workerParamsSchema
  .extend({
    name: textSchema('task name', 60).describe('The new task display name, trimmed explicitly by the host.'),
  })
  .describe('A user-requested task rename.');

export const workerPromptParamsSchema = workerParamsSchema
  .extend({
    kind: promptKindSchema,
  })
  .describe('A request for a task prompt of one known purpose.');

export const workerHistoryParamsSchema = workerParamsSchema
  .extend({
    before: integerSchema('history cursor', 1, Number.MAX_SAFE_INTEGER)
      .optional()
      .describe('The exclusive activity ID cursor; absence starts with the latest events.'),
  })
  .describe('A bounded task history page request.');

export const workerHandoffSeenParamsSchema = workerParamsSchema
  .extend({
    envelopeId: identifierSchema('envelope ID').describe(
      'The exact envelope whose task ownership is queried.',
    ),
  })
  .describe('An envelope ownership lookup without execution.');

export const workerFileParamsSchema = workerParamsSchema
  .extend({
    path: textSchema('file path', 1000).describe('The confined project-relative file path.'),
  })
  .describe('A task file review or parse-only syntax-check request.');

export const workerRestoreFileParamsSchema = workerFileParamsSchema
  .extend({
    expectedHash: textSchema('reviewed hash', 64)
      .refine((value) => /^[a-f0-9]{64}$/.test(value), {
        error: 'Restore requires the current reviewed file hash.',
      })
      .describe('The exact current SHA-256 reviewed by the user before restoring this file.'),
    confirm: z
      .literal(true, { error: 'Confirm restoring this journaled file.' })
      .describe('Literal true explicitly confirms this file-only restoration.'),
  })
  .describe('A confirmed single-file restore bound to the reviewed current hash and task run.');

export const workerReplyParamsSchema = epochParamsSchema
  .extend({
    text: handoffTextSchema,
  })
  .describe(
    'An exact reply validation request; detailed proposal admission remains a separate shared boundary.',
  );

export const workerImportParamsSchema = epochParamsSchema
  .extend({
    reconcile: optionalRpcFlagSchema('handoff reconciliation').describe(
      'Only literal true permits acknowledging an exact previously admitted handoff.',
    ),
    text: handoffTextSchema,
  })
  .describe(
    'An exact handoff admission or acknowledgement-recovery request, still subject to run/epoch gates.',
  );

export const workerRunParamsSchema = epochParamsSchema
  .extend({
    envelopeId: identifierSchema('envelope ID')
      .optional()
      .describe('The exact accepted envelope, when starting a delivery.'),
    envelopeHash: textSchema('envelope hash', 64)
      .optional()
      .describe('The literal digest of the exact accepted envelope; the durable delivery must match it.'),
  })
  .superRefine((value, context) => {
    if (value.envelopeId === undefined && value.envelopeHash !== undefined) {
      context.addIssue({
        code: 'custom',
        message:
          'Starting an accepted handoff requires its envelope ID and exact hash. No actions were started.',
        path: ['envelopeId'],
      });
    } else if (value.envelopeId !== undefined && value.envelopeHash === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Invalid envelope hash (maximum 64 characters).',
        path: ['envelopeHash'],
      });
    }
  })
  .describe(
    'A task execution request; delivery starts require both exact envelope ID and hash, without replay.',
  );

export const workerApproveParamsSchema = epochParamsSchema
  .extend({
    token: z
      .string({ error: 'Approval expired or does not match this worker.' })
      .describe('The exact pending host-issued approval token; the host also matches its project revision.'),
    approve: optionalRpcFlagSchema('approval choice').describe(
      'Only literal true approves; absence or false denies.',
    ),
    trustRun: optionalRpcFlagSchema('command trust').describe(
      'Only literal true trusts configured commands in this reviewed batch.',
    ),
  })
  .describe('An exact token/revision-bound approval choice that cannot approve later imported content.');

export const workerSkipParamsSchema = workerParamsSchema
  .extend({
    confirm: z
      .literal(true, { error: 'Explicit confirmation is required.' })
      .describe('Literal true confirms skipping one action.'),
  })
  .describe('A confirmed skip of one queued action without executing it.');

export const workerRollbackParamsSchema = workerParamsSchema
  .extend({
    confirm: z
      .literal(true, { error: 'Confirm rollback; command side effects cannot be undone.' })
      .describe('Literal true confirms file-only rollback, not reversal of command side effects.'),
  })
  .describe('A confirmed rollback of retained file edits in the reviewed run.');

export const workerAcceptParamsSchema = workerParamsSchema
  .extend({
    confirm: z
      .literal(true, {
        error:
          'Only an explicit finish with no objective checks can be manually accepted. A listed folder is not a completed goal.',
      })
      .describe('Literal true confirms compatible legacy manual goal acceptance.'),
  })
  .describe('A legacy acceptance request; the host still checks explicit finish and completion state.');

export const workerStopParamsSchema = workerParamsSchema
  .extend({
    id: identifierSchema('operation ID').describe(
      'The stable stop operation ID bound to its durable acknowledgement.',
    ),
  })
  .describe('A stop request that preserves completed edits and durably retires the previous plan.');

export const workerBridgeExtendParamsSchema = workerParamsSchema
  .extend({
    confirm: z
      .literal(true, { error: 'Explicit authorization is required to extend the task budget.' })
      .describe('Literal true explicitly authorizes the additive turn and active-time budget extension.'),
  })
  .describe('An authorized bridge budget extension; counters and prior receipts are retained.');

export type WorkerCreation = z.infer<typeof workerCreationSchema>;
