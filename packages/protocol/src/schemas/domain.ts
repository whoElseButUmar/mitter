import { z } from 'zod';
import { VERSION } from '../constants.js';
import { actionSchema, checkSchema } from './actions.js';
import { envelopeSchema } from './envelopes.js';
import { settingsSchema } from './model-settings.js';
import { followupSummarySchema } from './requests.js';

export const workerStateSchema = z
  .enum([
    'idle',
    'queued',
    'planning',
    'waiting_model',
    'waiting_lock',
    'executing',
    'verifying',
    'awaiting_approval',
    'paused',
    'review',
    'blocked',
    'complete',
    'cancelled',
  ])
  .describe('Worker lifecycle state.');

export const profileSchema = z
  .strictObject({
    id: z.string().describe('Configured command profile identifier.'),
    label: z.string().describe('Human-readable profile label.'),
    program: z.string().describe('User-configured executable path.'),
    args: z.array(z.string().describe('Literal configured command argument.')).describe('Ordered arguments.'),
    timeoutMs: z
      .int()
      .min(1000)
      .max(600000)
      .describe('Configured command timeout in whole milliseconds, from 1000 through 600000.'),
  })
  .describe('User-configured command profile, not arbitrary model shell input.');

export const projectSchema = z
  .strictObject({
    id: z.string().describe('Project identifier.'),
    name: z.string().describe('Project display name.'),
    root: z.string().describe('Host-owned absolute project root.'),
    profiles: z.array(profileSchema).describe('Configured command profiles.'),
    revision: z.int().nonnegative().describe('Nonnegative whole-number project configuration revision.'),
    mission: z.string().optional().describe('Optional project mission.'),
    conventions: z.string().optional().describe('Optional project conventions.'),
    sourceRoot: z.string().optional().describe('Optional source subtree.'),
  })
  .describe('Serialized project configuration.');

export const approvalSchema = z
  .strictObject({
    token: z.string().describe('Host-issued approval token.'),
    fingerprint: z.string().describe('Exact action approval fingerprint.'),
    action: actionSchema,
    reason: z.string().describe('Why approval is required.'),
    revision: z
      .int()
      .nonnegative()
      .describe('Nonnegative whole-number project revision bound to this approval.'),
    profile: profileSchema.optional().describe('Bound command profile, when applicable.'),
  })
  .describe('Host-issued pending action approval.');

export const taskBoundarySchema = z
  .strictObject({
    runId: z.string().describe('The exact worker run identifier the caller reviewed.'),
    epoch: z
      .int()
      .nonnegative()
      .describe('The nonnegative whole-number user-owned execution epoch the caller reviewed.'),
  })
  .describe('The reviewed task run and execution epoch; receivers must match both before mutation.');

/** Old tasks omit the entire control record; no optional fields receive defaults. */
export const taskControlSchema = z
  .strictObject({
    version: z.literal(1).describe('Task-control record format version.'),
    epoch: z.int().nonnegative().describe('Nonnegative whole-number user-owned run boundary epoch.'),
    mode: z.enum(['stopped', 'fresh', 'active']).describe('Run boundary mode.'),
    at: z
      .int()
      .nonnegative()
      .describe('Boundary transition time in nonnegative whole milliseconds since the Unix epoch.'),
    operationId: z.string().describe('User operation identifier.'),
    reason: z.string().describe('Boundary transition reason.'),
    retiredExchanges: z
      .array(z.string().describe('Retired exchange identifier.'))
      .describe('Exchanges no longer eligible for reply admission.'),
  })
  .describe('Persisted user-owned run boundary, never model-writable.');

export const completionRecordSchema = z
  .strictObject({
    version: z.literal(1).describe('Completion record format version.'),
    verification: z.enum(['passed', 'not-run', 'legacy-accepted']).describe('Actual verification outcome.'),
    summary: z.string().describe('Completion summary.'),
    checked: z.int().nonnegative().describe('Nonnegative whole-number count of configured checks performed.'),
    at: z
      .int()
      .nonnegative()
      .describe('Completion time in nonnegative whole milliseconds since the Unix epoch.'),
    followupId: z.string().optional().describe('Completed follow-up identifier, when applicable.'),
  })
  .describe('Persisted completion evidence.');

export const worktreeSchema = z
  .strictObject({
    root: z.string().describe('Worktree filesystem root.'),
    branch: z.string().describe('Worktree branch name.'),
    baseCommit: z.string().describe('Commit from which the worktree was created.'),
  })
  .describe('Host-owned worker worktree metadata.');

export const workerSchema = z
  .strictObject({
    completion: completionRecordSchema.optional().describe('Optional completion evidence.'),
    control: taskControlSchema
      .optional()
      .describe('Optional user-owned run boundary; absent for legacy tasks.'),
    id: z.string().describe('Worker identifier.'),
    projectId: z.string().describe('Owning project identifier.'),
    name: z.string().describe('User-visible task name.'),
    goal: z.string().describe('Full user task goal.'),
    checks: z.array(checkSchema).describe('Configured completion checks.'),
    mode: z.enum(['handoff', 'local']).describe('Worker execution mode.'),
    state: workerStateSchema,
    queue: z.array(envelopeSchema).describe('Admitted executable envelopes.'),
    cursor: z.int().nonnegative().describe('Nonnegative whole-number cursor into the current action batch.'),
    runId: z.string().describe('Current run identifier.'),
    iteration: z.int().nonnegative().describe('Nonnegative whole-number count of task iterations.'),
    maxIterations: z
      .int()
      .positive()
      .describe(
        'Positive saved iteration limit within the exact integer range; resumes and follow-ups may raise it above the initial creation limit.',
      ),
    maxMinutes: z
      .int()
      .min(1)
      .max(240)
      .describe('Configured active-time limit in whole minutes, from one through 240.'),
    startedAt: z
      .int()
      .nonnegative()
      .describe(
        'Run start time in whole milliseconds since the Unix epoch; zero means the run has not started.',
      ),
    pending: approvalSchema.optional().describe('Optional pending action approval.'),
    approvedFingerprint: z.string().optional().describe('Previously approved exact fingerprint.'),
    autoCommands: z.boolean().describe('Whether configured commands may run automatically.'),
    humanAcceptanceReady: z.boolean().optional().describe('Optional legacy human-acceptance state.'),
    error: z.string().optional().describe('Current worker error, when present.'),
    observations: z.array(z.string().describe('Worker observation.')).describe('Ordered run observations.'),
    activeFollowupId: z.string().optional().describe('Currently active follow-up identifier.'),
    followups: z
      .array(followupSummarySchema)
      .optional()
      .describe('Optional display-only follow-up summaries.'),
    worktree: worktreeSchema.optional().describe('Optional worker worktree.'),
    teamPaused: z.string().optional().describe('Optional team pause reason.'),
    lastProposal: z.string().optional().describe('Optional last proposal identifier/signature.'),
    repeatCount: z.int().nonnegative().describe('Nonnegative whole-number count of repeated proposals.'),
    createdAt: z
      .int()
      .nonnegative()
      .describe('Worker creation time in nonnegative whole milliseconds since the Unix epoch.'),
  })
  .describe('Serialized worker state; no authority to mutate it is implied by validation.');

export const activitySchema = z
  .strictObject({
    id: z.int().nonnegative().describe('Nonnegative whole-number activity sequence identifier.'),
    workerId: z.string().describe('Associated worker identifier.'),
    time: z
      .int()
      .nonnegative()
      .describe('Event time in nonnegative whole milliseconds since the Unix epoch.'),
    kind: z.string().describe('Activity kind.'),
    message: z.string().describe('Activity display message.'),
  })
  .describe('Worker activity event.');

export const bridgeProgressSummarySchema = z
  .strictObject({
    workerId: z.string().describe('Associated worker identifier.'),
    turns: z.int().nonnegative().describe('Nonnegative whole-number count of observed model turns.'),
    maxTurns: z
      .int()
      .min(1)
      .max(100000)
      .describe('Saved whole-number model-turn limit, from one through 100000, including extended budgets.'),
    lowerBound: z.boolean().describe('Whether the observed turn count is only a lower bound.'),
    activeMs: z.int().nonnegative().describe('Accumulated active time in nonnegative whole milliseconds.'),
    maxMinutes: z
      .int()
      .min(1)
      .max(100000)
      .describe(
        'Saved active-time limit in whole minutes, from one through 100000, including extended budgets.',
      ),
    startedAt: z
      .int()
      .nonnegative()
      .describe('Bridge session start time in nonnegative whole milliseconds since the Unix epoch.'),
    phase: z.string().describe('Current bridge phase.'),
    reason: z.string().describe('Current progress reason.'),
    errorCode: z.string().optional().describe('Optional bridge error code.'),
  })
  .describe('Display-only bridge progress summary, independent of bridge runtime modules.');

export const runtimeSchema = z
  .strictObject({
    version: z.string().optional().describe('Optional installed runtime version.'),
    node: z.string().describe('Node runtime status.'),
    workflow: z.string().describe('Workflow runtime status.'),
    models: z.string().describe('Model runtime status.'),
  })
  .describe('Host runtime status summary.');

export const snapshotSchema = z
  .strictObject({
    bridgeProgress: z
      .array(bridgeProgressSummarySchema)
      .optional()
      .describe('Optional bridge progress summaries.'),
    protocol: z.literal(VERSION).describe('Exact snapshot protocol version.'),
    projects: z.array(projectSchema).describe('Available projects.'),
    workers: z.array(workerSchema).describe('Available workers.'),
    events: z.array(activitySchema).describe('Recent activity events.'),
    settings: settingsSchema,
    runtime: runtimeSchema,
  })
  .describe('Serialized host snapshot, with no bridge/UI/host module dependencies.');

export type WorkerState = z.infer<typeof workerStateSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type TaskBoundary = z.infer<typeof taskBoundarySchema>;
export type TaskControl = z.infer<typeof taskControlSchema>;
export type CompletionRecord = z.infer<typeof completionRecordSchema>;
export type Worker = z.infer<typeof workerSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type BridgeProgressSummary = z.infer<typeof bridgeProgressSummarySchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
