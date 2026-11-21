import { z } from 'zod';
import { bridgeProgressSummarySchema, type Worker } from '../../protocol/src/index.js';
import { outboundReceiptSchema, parseReceipt, type OutboundReceipt } from './message-wire.js';
import {
  conversationUrlSchema,
  identifierSchema,
  nonNegativeIntegerSchema,
  sha256Schema,
} from './schemas/primitives.js';

export const taskProgressStageSchema = z
  .enum([
    'ready',
    'prepared',
    'commit_intent',
    'waiting_reply',
    'local_batch',
    'report_due',
    'review',
    'complete',
  ])
  .describe('The saved step to resume without repeating a send or a local action.');

export const approvedReplySchema = z
  .object({
    id: identifierSchema.describe('The reply selected by the user.'),
    hash: sha256Schema.describe('A fingerprint of the complete validated reply.'),
    url: conversationUrlSchema.describe('The conversation where the user selected the reply.'),
    at: nonNegativeIntegerSchema.describe('When the user confirmed this exact reply.'),
  })
  .describe('Approval for one exact reply; it does not approve later replies or bypass file checks.');

export type ApprovedReply = z.infer<typeof approvedReplySchema>;

/** The version is independent of app releases. This record never stores prompt
 * bodies, session tokens, command approvals, or permission grants. */
const taskProgressFieldsSchema = z.object({
  version: z.literal(1).describe('The saved progress format version.'),
  revision: nonNegativeIntegerSchema.describe('The revision used to reject outdated saves.'),
  workerId: identifierSchema.describe('The task whose progress is saved.'),
  projectId: identifierSchema.describe('The project that owns the task.'),
  goalHash: sha256Schema.describe('A fingerprint of the complete task goal.'),
  turns: nonNegativeIntegerSchema.max(100000).describe('The automatic chat turns already reserved.'),
  maxTurns: nonNegativeIntegerSchema.min(1).max(100000).describe('The saved automatic turn limit.'),
  lowerBound: z
    .boolean()
    .describe('Earlier releases may have missed turns, so the count is a known minimum.'),
  activeMs: nonNegativeIntegerSchema.describe('The task time used while active, in milliseconds.'),
  maxMinutes: nonNegativeIntegerSchema.min(1).max(100000).describe('The saved active-time limit in minutes.'),
  startedAt: nonNegativeIntegerSchema.describe('When this task first started recording progress.'),
  updatedAt: nonNegativeIntegerSchema.describe('When this progress record was last saved.'),
  stage: taskProgressStageSchema,
  conversationUrl: conversationUrlSchema
    .optional()
    .describe('The pinned conversation, once its route is known.'),
  lastReceipt: outboundReceiptSchema.optional().describe('The exact outgoing message waiting for its reply.'),
  approvedReply: approvedReplySchema.optional().describe('An exact reply explicitly selected by the user.'),
  lastImportedId: identifierSchema.optional().describe('The latest reply accepted by the local host.'),
  lastActionsHash: sha256Schema.optional().describe('A fingerprint used to detect repeated action batches.'),
  repeats: nonNegativeIntegerSchema.max(100).describe('Consecutive repeated action batches.'),
  formatRepairs: nonNegativeIntegerSchema.max(100).describe('Reply correction attempts used so far.'),
  phase: z.string().max(40).describe('The last published task status.'),
  reason: z.string().max(500).describe('A short explanation of that status.'),
  errorCode: z
    .string()
    .regex(/^[A-Z0-9_]{1,64}$/)
    .optional()
    .describe('A failure code when the task needs attention.'),
  readerDiagnostic: bridgeProgressSummarySchema.shape.readerDiagnostic,
  monitoring: bridgeProgressSummarySchema.shape.monitoring,
  watchUntil: bridgeProgressSummarySchema.shape.watchUntil,
});

function checkReceiptBinding(
  progress: z.infer<typeof taskProgressFieldsSchema>,
  context: z.RefinementCtx,
): void {
  const receipt = progress.lastReceipt;

  if (!receipt) {
    return;
  }

  const sameTask = receipt.workerId === progress.workerId && receipt.projectId === progress.projectId;
  const sameGoal = receipt.goalHash === progress.goalHash;

  if (!sameTask || !sameGoal) {
    context.addIssue({
      code: 'custom',
      path: ['lastReceipt'],
      message: 'The saved message belongs to a different task, project, or goal.',
    });
  }
}

export const taskProgressSchema = taskProgressFieldsSchema
  .superRefine(checkReceiptBinding)
  .describe('Durable task progress used to resume safely after a pause or restart.');

export type TaskProgress = z.infer<typeof taskProgressSchema>;

export function isActiveReplyWait(
  progress: Pick<TaskProgress, 'phase' | 'errorCode' | 'monitoring'>,
): boolean {
  return (
    !progress.monitoring && !progress.errorCode && ['waiting_reply', 'reconnecting'].includes(progress.phase)
  );
}

/** Match a held host approval to the accepted batch, including an owner-requested
 * install injected by the host at the end of that batch. This grants no command authority. */
export function holdsSetupApproval(worker: Worker, batchId?: string): boolean {
  const head = worker.queue[0];
  const pending = worker.pending;
  if (
    worker.mode !== 'handoff' ||
    worker.state !== 'awaiting_approval' ||
    worker.teamPaused ||
    worker.control?.mode === 'stopped' ||
    worker.humanAcceptanceReady ||
    pending?.action.type !== 'setupCommand' ||
    !head ||
    head.workerId !== worker.id ||
    head.projectId !== worker.projectId ||
    (batchId !== undefined && head.id !== batchId)
  ) {
    return false;
  }
  if (pending.fromTaskRequest) {
    return (
      pending.action.command.length === 2 &&
      pending.action.command[0] === 'pnpm' &&
      pending.action.command[1] === 'install'
    );
  }
  const action = head.actions[worker.cursor];
  return (
    action?.type === 'setupCommand' &&
    JSON.stringify(action.command) === JSON.stringify(pending.action.command)
  );
}

export function matchesRecoverableWait(
  saved: TaskProgress | null,
  revision: number,
  url: string,
  receipt: OutboundReceipt | undefined,
  worker: Worker,
  setupResultBatchId?: string,
): boolean {
  if (!saved || saved.monitoring || saved.errorCode || saved.approvedReply) {
    return false;
  }
  if (saved.stage === 'local_batch' || saved.stage === 'report_due') {
    const batchId = saved.lastImportedId;
    if (!batchId || !['running', 'waiting_approval'].includes(saved.phase)) {
      return false;
    }
    const released =
      worker.state === 'review' && !worker.pending && !worker.queue.length && setupResultBatchId === batchId;
    const held =
      saved.stage === 'local_batch' &&
      holdsSetupApproval(worker, batchId) &&
      worker.queue[0]?.replyTo === receipt?.exchangeId;
    if (!released && !held) {
      return false;
    }
  } else if (saved.stage !== 'waiting_reply' || !isActiveReplyWait(saved)) {
    return false;
  }
  return (
    saved.revision === revision &&
    saved.conversationUrl === url &&
    !!receipt?.expectsReplyTo &&
    !!receipt.exchangeId &&
    saved.lastReceipt?.expectsReplyTo === true &&
    saved.lastReceipt.exchangeId === receipt.exchangeId &&
    saved.lastReceipt.textHash === receipt.textHash &&
    saved.lastReceipt.renderedHash === receipt.renderedHash &&
    saved.lastReceipt.goalHash === receipt.goalHash &&
    saved.lastReceipt.workerId === receipt.workerId &&
    saved.lastReceipt.projectId === receipt.projectId &&
    saved.lastReceipt.turn === receipt.turn &&
    saved.lastReceipt.turn === saved.turns
  );
}

/** A ready checkpoint with no reserved, staged, or admitted exchange. */
export function isUnsentBootstrap(progress: TaskProgress | null | undefined): boolean {
  return (
    progress?.stage === 'ready' &&
    progress.turns === 0 &&
    !progress.lowerBound &&
    !progress.lastReceipt &&
    !progress.conversationUrl &&
    !progress.lastImportedId &&
    !progress.approvedReply &&
    !progress.lastActionsHash
  );
}

function readSavedPhase(value: unknown): string {
  if (typeof value === 'string') {
    return value.slice(0, 40);
  }

  return 'stopped';
}

function readSavedReason(value: unknown): string {
  if (typeof value === 'string') {
    return value.slice(0, 500);
  }

  return 'Progress saved.';
}

export const savedTaskProgressSchema = taskProgressFieldsSchema
  .extend({
    phase: z
      .preprocess(readSavedPhase, z.string().max(40))
      .describe('Legacy display phase clipped to forty characters, defaulting to stopped when unreadable.'),
    reason: z
      .preprocess(readSavedReason, z.string().max(500))
      .describe('Legacy display reason clipped to five hundred characters, with a fallback when unreadable.'),
    errorCode: taskProgressFieldsSchema.shape.errorCode
      .catch(undefined)
      .describe('A valid legacy failure code; malformed display hints are discarded.'),
    lastReceipt: z
      .preprocess(parseReceipt, outboundReceiptSchema)
      .optional()
      .describe(
        'An optional migrated receipt; malformed required hashes or task bindings reject the record.',
      ),
    conversationUrl: conversationUrlSchema
      .transform((address) => {
        const url = new URL(address);
        return url.origin + url.pathname;
      })
      .optional()
      .describe('The supported saved conversation normalized to its origin and path, absent until binding.'),
  })
  .superRefine(checkReceiptBinding)
  .transform((progress) => {
    if (progress.errorCode === undefined) {
      delete progress.errorCode;
    }
    return progress;
  })
  .describe('Legacy task progress normalized without resetting counters, bindings, receipts, or approvals.');

export function parseTaskProgress(raw: unknown): TaskProgress | undefined {
  const result = savedTaskProgressSchema.safeParse(raw);

  if (!result.success) {
    return;
  }

  return result.data;
}

export function progressKey(workerId: string): string {
  return 'mitter.taskProgress.v1.' + workerId;
}

export const taskProgressSummarySchema = bridgeProgressSummarySchema
  .extend(
    taskProgressFieldsSchema.pick({
      workerId: true,
      turns: true,
      maxTurns: true,
      lowerBound: true,
      activeMs: true,
      maxMinutes: true,
      startedAt: true,
      phase: true,
      reason: true,
      errorCode: true,
      readerDiagnostic: true,
      monitoring: true,
      watchUntil: true,
    }).shape,
  )
  .describe('Task counters, limits, and status without private message receipts.');

export type TaskProgressSummary = z.infer<typeof taskProgressSummarySchema>;

export function progressSummary(progress: TaskProgress): TaskProgressSummary {
  return {
    workerId: progress.workerId,
    revision: progress.revision,
    turns: progress.turns,
    maxTurns: progress.maxTurns,
    lowerBound: progress.lowerBound,
    activeMs: progress.activeMs,
    maxMinutes: progress.maxMinutes,
    startedAt: progress.startedAt,
    phase: progress.phase,
    reason: progress.reason,
    errorCode: progress.errorCode,
    ...(progress.readerDiagnostic && { readerDiagnostic: progress.readerDiagnostic }),
    monitoring: progress.monitoring,
    watchUntil: progress.watchUntil,
  };
}
