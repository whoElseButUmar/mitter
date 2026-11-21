import { z } from 'zod';
import type { BootstrapDraft } from '../bootstrap-draft.js';
import { taskBoundarySchema, type Snapshot } from '../../../protocol/src/index.js';
import type { DomRequest } from '../chat-dom.js';
import { outboundReceiptSchema, type OutboundReceipt } from '../message-wire.js';
import type { TaskProgress } from '../progress.js';
import { identifierSchema, nonNegativeIntegerSchema } from '../schemas/primitives.js';
import { chatStartURL } from './chat-identity.js';

const chatAddressSchema = z
  .string()
  .refine((address) => {
    try {
      chatStartURL(address, true);
      return true;
    } catch {
      return false;
    }
  })
  .describe('A supported ChatGPT conversation address or new-chat address.');

export const bridgeWatchStatusSchema = z
  .object({
    receiving: z.boolean().optional().describe('Whether a late reply is currently arriving.'),
    monitoring: z.boolean().optional().describe('Whether the runner is watching read-only for a late reply.'),
    watchUntil: nonNegativeIntegerSchema
      .optional()
      .describe('Absolute watch deadline as a Unix time in milliseconds.'),
  })
  .describe('What the runner has observed while waiting for a late reply.');

export type BridgeWatchStatus = z.infer<typeof bridgeWatchStatusSchema>;

export const bridgeResendResultSchema = z
  .object({
    sent: z.boolean().describe('Whether the confirmed resend finished its send attempt.'),
    replyFound: z.boolean().optional().describe('Whether an existing verified reply prevented a resend.'),
    pending: z.boolean().optional().describe('Whether the confirmed resend is waiting for the composer.'),
  })
  .describe('The outcome of one user-confirmed resend of the reviewed instructions with a fresh reply ID.');

export type BridgeResendResult = z.infer<typeof bridgeResendResultSchema>;

export const bridgeStatusSchema = bridgeWatchStatusSchema
  .extend({
    workerId: identifierSchema.describe('Task worker linked to this runner.'),
    tabId: nonNegativeIntegerSchema.describe('Browser tab linked to this runner.'),
    url: chatAddressSchema.describe('The task conversation or new-chat address.'),
    active: z.boolean().describe('Whether normal sending and local execution are active.'),
    phase: z.string().describe('Current step in the bridge lifecycle.'),
    reason: z.string().describe('Human-readable explanation of the current step.'),
    turns: nonNegativeIntegerSchema.describe('Number of automatic chat turns already reserved.'),
    maxTurns: nonNegativeIntegerSchema.min(1).describe('Saved limit on automatic chat turns.'),
    startedAt: nonNegativeIntegerSchema.describe('When this task first started recording progress.'),
    errorCode: z.string().optional().describe('Failure code when the runner needs attention.'),
    bindingPending: z
      .boolean()
      .optional()
      .describe('Whether a new chat still needs a verified conversation binding.'),
    lowerBound: z
      .boolean()
      .optional()
      .describe('Whether the displayed turn count is a known minimum from older history.'),
    activeMs: nonNegativeIntegerSchema.optional().describe('Active task time recorded in milliseconds.'),
    maxMinutes: nonNegativeIntegerSchema.min(1).optional().describe('Saved active-time limit in minutes.'),
  })
  .describe('The task status shown by the bridge runner.');

export type BridgeStatus = z.infer<typeof bridgeStatusSchema>;

export const bridgePreviousProgressSchema = z
  .object({
    turns: nonNegativeIntegerSchema.describe('Previously recorded chat turn count.'),
    maxTurns: nonNegativeIntegerSchema.min(1).describe('Previously saved turn limit.'),
    lowerBound: z.boolean().describe('Whether earlier unrecorded turns may be missing.'),
    startedAt: nonNegativeIntegerSchema.describe('When this task first started recording progress.'),
    activeMs: nonNegativeIntegerSchema.describe('Previously recorded active time in milliseconds.'),
    maxMinutes: nonNegativeIntegerSchema.min(1).describe('Previously saved active-time limit in minutes.'),
  })
  .describe('An earlier progress summary used before saved task progress is loaded.');

export type BridgePreviousProgress = z.infer<typeof bridgePreviousProgressSchema>;

export const bridgeOptionsSchema = z
  .object({
    workerId: identifierSchema.describe('Worker that owns this execution plan.'),
    projectId: identifierSchema.describe('Project that owns this execution plan.'),
    tabId: nonNegativeIntegerSchema.describe('Browser tab used for this task handoff.'),
    url: chatAddressSchema.describe('Selected ChatGPT conversation or new-chat address.'),
    maxTurns: nonNegativeIntegerSchema.min(1).max(20).describe('Automatic turn limit, from one to twenty.'),
    maxMinutes: nonNegativeIntegerSchema
      .min(1)
      .max(60)
      .describe('Automatic active-time limit, from one to sixty minutes.'),
    token: z.string().describe('Page transport token for the linked task tab.'),
    newChat: z
      .boolean()
      .optional()
      .describe('Whether an explicitly opened new chat may be bound to this task.'),
    resumeExisting: z
      .boolean()
      .optional()
      .describe('Whether the runner should reuse an existing task exchange.'),
    expectedRun: taskBoundarySchema
      .optional()
      .describe('The original reviewed run and epoch retained across runner startup and native requests.'),
    waitingReplyRevision: nonNegativeIntegerSchema
      .optional()
      .describe('The exact active reply checkpoint being reattached after the background worker restarted.'),
    expectedBatchId: identifierSchema
      .optional()
      .describe('The exact queued batch admitted by pending continuation, without lost-ack substitution.'),
    lastReceipt: outboundReceiptSchema
      .optional()
      .describe('Saved receipt for the most recent outgoing task message.'),
    previousProgress: bridgePreviousProgressSchema
      .optional()
      .describe('Legacy progress available before durable loading.'),
  })
  .superRefine((options, context) => {
    try {
      chatStartURL(options.url, options.newChat === true);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'Choose a ChatGPT conversation, or explicitly open a new chat.',
      });
    }
  })
  .describe('The task, chat tab, time limits, and saved information used by the bridge runner.');

export type BridgeOptions = z.infer<typeof bridgeOptionsSchema>;

export type BridgeDependencies = {
  checkAvailable?(): void;
  verifyStartup?(): Promise<void>;
  reconnectHost?(): Promise<Snapshot>;
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  page(tabId: number, request: DomRequest): Promise<unknown>;
  snapshot(): Snapshot | undefined;
  publish(status: BridgeStatus): void;
  log(kind: string, message: string): void;
  saveReceipt?(receipt: OutboundReceipt): Promise<void>;
  confirmBootstrapDraft?(proof: BootstrapDraft): Promise<void>;
  rememberAnsweredDraft?(exchangeId: string): Promise<void>;
  findCompletedBootstrapDraft?(text: string): Promise<BootstrapDraft | undefined>;
  loadProgress?(): Promise<unknown>;
  saveProgress?(progress: TaskProgress, epoch?: number): Promise<unknown>;
  now?(): number;
};
