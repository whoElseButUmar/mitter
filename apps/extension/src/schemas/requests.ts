import { z } from 'zod';
import { proposalEnvelopeSchema } from '../../../../packages/protocol/src/proposal.js';
import { taskBoundarySchema } from '../../../../packages/protocol/src/index.js';
import { followupRequestSchema } from '../../../../packages/protocol/src/requests.js';
import {
  workerParamsSchema,
  workerFollowupParamsSchema,
  workerStopParamsSchema,
  workerRestoreFileParamsSchema,
  workerRollbackParamsSchema,
  epochParamsSchema,
} from '../../../../packages/protocol/src/rpc.js';
import { chatLinkSchema } from '../../../../packages/bridge/src/chat-links.js';
import { FileTargetSchema } from '../../../../packages/ui/src/file-target.js';
import { identifierSchema, timestampSchema } from './primitives.js';

export const workerParametersSchema = workerParamsSchema;
export const followupParametersSchema = workerFollowupParamsSchema;

export const haltParametersSchema = workerStopParamsSchema
  .extend({
    id: workerStopParamsSchema.shape.id
      .optional()
      .describe('The optional idempotent stop operation identifier.'),
  })
  .strict()
  .describe('A task stop validated before revoking reply tickets or superseding an in-flight start.');

export const restoreFileParametersSchema = workerRestoreFileParamsSchema
  .extend({
    path: FileTargetSchema.shape.path,
  })
  .strict()
  .describe('A file restore validated before stopping its runner; native confinement remains authoritative.');

export const rollbackParametersSchema = workerRollbackParamsSchema
  .extend({ epoch: epochParamsSchema.shape.epoch })
  .strict()
  .describe('A rollback validated before stopping a runner; command side effects cannot be undone.');

export const changeRequestSchema = followupRequestSchema
  .extend({
    autoStart: z.boolean().optional().describe('Whether to continue after queuing the requested change.'),
  })
  .describe(
    'A file-selection follow-up draft; the receiving boundary applies the canonical continuation default.',
  );

export type ChangeRequest = z.infer<typeof changeRequestSchema>;

export const bridgeResumeSchema = workerParametersSchema
  .extend({ expectedRun: taskBoundarySchema })
  .describe('Resume authorization for the exact task run and execution epoch reviewed by the user.');

export const bridgeContinuePendingSchema = epochParamsSchema
  .extend({ expectedRun: taskBoundarySchema })
  .superRefine((params, context) => {
    if (params.epoch !== undefined && params.epoch !== params.expectedRun.epoch) {
      context.addIssue({
        code: 'custom',
        path: ['epoch'],
        message: 'The supplied epoch does not match the reviewed task boundary. Review the task again.',
      });
    }
  })
  .describe('Continuation bound to the reviewed task run and epoch; validation grants no chat permission.');

export const bridgeResendSchema = bridgeResumeSchema
  .extend({
    confirm: z.literal(true).describe('Explicit authorization to resend the exact reviewed pending prompt.'),
    expectedPrompt: z.string().describe('The byte-exact pending prompt the user reviewed, without trimming.'),
  })
  .describe('One explicit resend bound to the reviewed task and exact pending prompt bytes.');

export const forwardedTaskParametersSchema = epochParamsSchema.describe(
  'Task mutation admission fields; legacy callers may omit their reviewed boundary.',
);

export type ForwardedTaskParameters = z.infer<typeof forwardedTaskParametersSchema>;

export const handoffDeliveryParametersSchema = workerParametersSchema
  .extend({
    envelopeId: identifierSchema.describe(
      'The exact accepted batch whose durable delivery receipt authorizes start.',
    ),
    envelopeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('The SHA-256 hash of the exact accepted batch, in lowercase hexadecimal.'),
  })
  .describe(
    'A post-import start proven by the host’s saved delivery receipt, not a pre-import run identifier.',
  );

export const bridgeStartOptionsSchema = workerParametersSchema
  .extend({
    consent: z.literal(true).describe('Explicit authorization to send project information to ChatGPT.'),
    newChat: z.boolean().optional().describe('Whether to create a new, unclaimed conversation.'),
    tabId: z.number().int().nonnegative().optional().describe('An explicitly selected browser tab.'),
    maxTurns: z.number().int().min(1).max(20).default(15).describe('The initial automatic turn limit.'),
    maxMinutes: z.number().int().min(1).max(60).default(30).describe('The initial active-time limit.'),
  })
  .describe('Authorization and limits for a task chat; internal starts bind their admission separately.');

export type BridgeStartOptions = z.infer<typeof bridgeStartOptionsSchema>;

export const bridgeStartSchema = bridgeStartOptionsSchema
  .extend({ expectedRun: taskBoundarySchema })
  .describe('An authenticated view’s chat start bound to its exact reviewed task run and execution epoch.');

export const bridgeStartIdentitySchema = z
  .strictObject({
    admissionId: identifierSchema.describe(
      'The opaque identity of one runner admitted by this background instance.',
    ),
    expectedRun: taskBoundarySchema,
  })
  .describe('The exact admitted runner and original task boundary retained for disposed-form cleanup.');

export type BridgeStartIdentity = z.infer<typeof bridgeStartIdentitySchema>;

export const bridgeStopStartedSchema = workerParametersSchema
  .extend(bridgeStartIdentitySchema.shape)
  .strict()
  .describe('Cleanup of one admitted chat runner; a replacement runner cannot inherit this authority.');

export type BridgeStopStartedParameters = z.infer<typeof bridgeStopStartedSchema>;

export const steeringParametersSchema = workerFollowupParamsSchema;

export const replyPreviewParametersSchema = workerParametersSchema
  .extend({
    source: z.enum(['chat', 'clipboard']).default('chat').describe('The user-selected reply source.'),
    text: z.string().optional().describe('The exact explicitly copied reply text.'),
  })
  .describe('A request to inspect one reply without importing actions.');

export const replyConfirmationSchema = workerParametersSchema
  .extend({
    ticket: identifierSchema.describe('The exact one-use approval ticket.'),
    confirm: z.literal(true).describe('Explicit authorization to apply the previewed reply.'),
  })
  .describe('Confirmation of one exact, previously previewed reply.');

export const replyTicketSchema = z
  .object({
    workerId: identifierSchema.describe('The task that owns this ticket.'),
    projectId: identifierSchema.describe('The exact owning project.'),
    goal: z.string().describe('The exact goal at preview time.'),
    link: chatLinkSchema.describe('The pinned tab and conversation at preview time.'),
    envelope: proposalEnvelopeSchema.describe('The exact locally validated proposed actions.'),
    hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('The complete reply payload fingerprint.'),
    source: z.enum(['chat', 'clipboard']).describe('Whether to recheck visible chat text before importing.'),
    expiresAt: timestampSchema.describe('The ticket expiry time.'),
    createdAt: timestampSchema.describe('The start of the visible reply settling period.'),
  })
  .describe('A bounded, task-bound, one-use approval ticket that cannot authorize another payload.');

export type ReplyTicket = z.infer<typeof replyTicketSchema>;
