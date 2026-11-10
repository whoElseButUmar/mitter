import { z } from 'zod';
import {
  coreRpcRegistry,
  emptyRpcParamsSchema,
  openedResultSchema,
  promptResultSchema,
  runResultSchema,
  stopResultSchema,
  workerBridgeExtendParamsSchema,
  parseRpcResult,
} from '../../../../packages/protocol/src/rpc.js';
import { rewriteRequestSchema } from '../../../../packages/protocol/src/rewrite.js';
import {
  bridgeStatusSchema,
  bridgeResendResultSchema,
} from '../../../../packages/bridge/src/runner/types.js';
import { chatLinkSchema } from '../../../../packages/bridge/src/chat-links.js';
import { rewriteResultSchema } from '../../../../packages/bridge/src/rewrite-runner.js';
import { replyPreviewSchema } from '../../../../packages/bridge/src/reply-recovery.js';
import { debugEntrySchema } from '../../../../packages/bridge/src/diagnostics.js';
import { WorkspaceActionSchema } from '../../../../packages/ui/src/workspace.js';
import { notificationPreferencesSchema, notificationChangeSchema, workspaceStateSchema } from './messages.js';
import { identifierSchema } from './primitives.js';
import {
  bridgeStartIdentitySchema,
  bridgeStartSchema,
  bridgeStopStartedSchema,
  bridgeResumeSchema,
  bridgeContinuePendingSchema,
  bridgeResendSchema,
  haltParametersSchema,
  steeringParametersSchema,
  workerParametersSchema,
  replyPreviewParametersSchema,
  replyConfirmationSchema,
} from './requests.js';

export const bridgeStartResultSchema = bridgeStatusSchema
  .extend(bridgeStartIdentitySchema.shape)
  .describe('The admitted chat status and exact ownership identity returned to the initiating view.');
export type BridgeStartResult = z.infer<typeof bridgeStartResultSchema>;

export const bridgeStopStartedResultSchema = z
  .strictObject({
    stopped: z
      .boolean()
      .describe('Whether this cleanup stopped its exact live runner; stale cleanup is a no-op.'),
  })
  .describe('The outcome of disposing one admitted chat start without stopping a replacement.');
export type BridgeStopStartedResult = z.infer<typeof bridgeStopStartedResultSchema>;

export const resumeResultSchema = z
  .object({
    resumed: z.boolean().describe('Whether the saved conversation was safely resumed.'),
    status: bridgeStatusSchema.optional().describe('The resumed chat session status, when available.'),
  })
  .describe('The result of reconnecting a task to its original chat without replay.');
export type ResumeResult = z.infer<typeof resumeResultSchema>;

export const continuePendingResultSchema = z
  .discriminatedUnion('kind', [
    z
      .strictObject({
        kind: z.literal('chat').describe('The exact queued automatic batch belongs to its saved chat.'),
        result: resumeResultSchema,
      })
      .describe('The saved-chat continuation outcome, without starting unrelated local work.'),
    z
      .strictObject({
        kind: z.literal('local').describe('The reviewed pending work continues only on the local host.'),
        result: coreRpcRegistry['worker.resume'].result,
      })
      .describe('The complete native acknowledgement that local execution was admitted.'),
  ])
  .describe('One background-selected continuation of the reviewed task, without replay or fallback retry.');
export type ContinuePendingResult = z.infer<typeof continuePendingResultSchema>;

export const localRewriteResultSchema = z
  .strictObject({
    id: identifierSchema.describe('The local rewrite identifier.'),
    state: z.literal('done').describe('Local restructuring completed immediately.'),
    text: z.string().describe('The locally structured draft.'),
    provider: z.literal('local').describe('No project text was sent to a remote provider.'),
  })
  .describe('The result of a local-only draft rewrite.');
export type LocalRewriteResult = z.infer<typeof localRewriteResultSchema>;

export const rewriteOperationResultSchema = z
  .union([localRewriteResultSchema, rewriteResultSchema])
  .describe('A local restructuring result or the state of an isolated ChatGPT rewrite.');
export type RewriteOperationResult = z.infer<typeof rewriteOperationResultSchema>;

const pausedResultSchema = z
  .strictObject({ paused: z.literal(true).describe('The task plan was paused.') })
  .describe('Acknowledgement of pausing this task plan.');
const stoppedResultSchema = z
  .strictObject({ stopped: z.literal(true).describe('The chat runner was stopped.') })
  .describe('Acknowledgement of stopping this chat runner.');
const clearedResultSchema = z
  .strictObject({ cleared: z.literal(true).describe('Local diagnostics were cleared.') })
  .describe('Acknowledgement of clearing local diagnostics.');
const continuationResultSchema = z
  .union([resumeResultSchema, runResultSchema])
  .describe('A resumed chat or an admitted local execution after fresh continuation.');
const followupStartResultSchema = z
  .union([
    bridgeStartResultSchema,
    continuationResultSchema,
    z.strictObject({
      queued: z.literal(true).describe('The follow-up remains queued without a start.'),
      reason: z.string().optional().describe('Why the saved follow-up could not start yet.'),
    }),
  ])
  .describe('A saved follow-up that remains queued, resumes its chat, or starts an admitted run.');
const rewriteStartParametersSchema = z
  .object({
    request: rewriteRequestSchema,
    consent: z
      .boolean()
      .optional()
      .describe('Explicit consent for a remote draft rewrite, absent for local use.'),
  })
  .superRefine((params, context) => {
    if (params.request.provider !== 'local' && params.consent !== true) {
      context.addIssue({
        code: 'custom',
        path: ['consent'],
        message: 'Allow ChatGPT access before rewriting.',
      });
    }
  })
  .describe('A checked composer-only rewrite; schema validity does not grant browser permission.');
const rewriteIdParametersSchema = z
  .strictObject({ id: identifierSchema.describe('The exact draft rewrite ID, without coercion.') })
  .describe('Selection of one retained draft rewrite.');
const workspaceActionParametersSchema = z
  .object({ action: WorkspaceActionSchema })
  .describe('One validated workspace action, without execution authority.');

export const localRpcRegistry = Object.freeze({
  'bridge.start': { params: bridgeStartSchema, result: bridgeStartResultSchema, mutation: true },
  'bridge.stopStarted': {
    params: bridgeStopStartedSchema,
    result: bridgeStopStartedResultSchema,
    mutation: true,
  },
  'bridge.resume': { params: bridgeResumeSchema, result: resumeResultSchema, mutation: true },
  'bridge.continuePending': {
    params: bridgeContinuePendingSchema,
    result: continuePendingResultSchema,
    mutation: true,
  },
  'bridge.extend': { params: workerBridgeExtendParamsSchema, result: resumeResultSchema, mutation: true },
  'bridge.resend': { params: bridgeResendSchema, result: bridgeResendResultSchema, mutation: true },
  'bridge.lastPrompt': { params: workerParametersSchema, result: promptResultSchema, mutation: false },
  'bridge.halt': { params: haltParametersSchema, result: stopResultSchema, mutation: true },
  'bridge.steer': { params: steeringParametersSchema, result: continuationResultSchema, mutation: true },
  'bridge.continueFresh': {
    params: workerParametersSchema,
    result: continuationResultSchema,
    mutation: true,
  },
  'bridge.pause': {
    params: coreRpcRegistry['worker.pause'].params,
    result: pausedResultSchema,
    mutation: true,
  },
  'bridge.stop': { params: workerParametersSchema, result: stoppedResultSchema, mutation: true },
  'bridge.replyPreview': {
    params: replyPreviewParametersSchema,
    result: replyPreviewSchema,
    mutation: false,
  },
  'bridge.replyApply': { params: replyConfirmationSchema, result: bridgeStatusSchema, mutation: true },
  'bridge.list': {
    params: emptyRpcParamsSchema,
    result: z.array(bridgeStatusSchema).describe('Complete locally retained chat run statuses.'),
    mutation: false,
  },
  'bridge.lastChat': { params: workerParametersSchema, result: chatLinkSchema.nullable(), mutation: false },
  'bridge.tabs': {
    params: emptyRpcParamsSchema,
    result: z
      .array(chatLinkSchema)
      .describe('Eligible ChatGPT tabs checked against the page origin allowlist.'),
    mutation: false,
  },
  'bridge.newChat': { params: emptyRpcParamsSchema, result: chatLinkSchema, mutation: true },
  'bridge.openChat': { params: workerParametersSchema, result: openedResultSchema, mutation: true },
  'rewrite.start': {
    params: rewriteStartParametersSchema,
    result: rewriteOperationResultSchema,
    mutation: true,
  },
  'rewrite.read': {
    params: rewriteIdParametersSchema,
    result: rewriteOperationResultSchema,
    mutation: false,
  },
  'rewrite.cancel': {
    params: rewriteIdParametersSchema,
    result: rewriteOperationResultSchema,
    mutation: true,
  },
  'workspace.read': { params: emptyRpcParamsSchema, result: workspaceStateSchema, mutation: false },
  'workspace.action': {
    params: workspaceActionParametersSchema,
    result: workspaceStateSchema,
    mutation: true,
  },
  'notifications.get': {
    params: emptyRpcParamsSchema,
    result: notificationPreferencesSchema,
    mutation: false,
  },
  'notifications.set': {
    params: notificationChangeSchema,
    result: notificationPreferencesSchema,
    mutation: true,
  },
  'debug.read': {
    params: emptyRpcParamsSchema,
    result: z.array(debugEntrySchema).describe('Complete locally retained diagnostic entries.'),
    mutation: false,
  },
  'debug.clear': { params: emptyRpcParamsSchema, result: clearedResultSchema, mutation: true },
  'worker.followup': coreRpcRegistry['worker.followup'],
  'worker.followupStart': {
    params: workerParametersSchema,
    result: followupStartResultSchema,
    mutation: true,
  },
});

export function parseLocalResult(method: string, result: unknown): unknown {
  return parseRpcResult(localRpcRegistry, method, result);
}
