import { z } from 'zod';
import { VERSION } from '../constants.js';
import { actionSchema, proposalActionSchema } from './actions.js';
import { identifierSchema, recordSchema, textSchema } from './primitives.js';

export const envelopeSchema = z
  .strictObject({
    protocol: z
      .literal(VERSION, { error: 'Unsupported protocol. Expected mitter/1.' })
      .describe('Exact handoff protocol version.'),
    id: identifierSchema().describe('Unique batch identifier.'),
    workerId: identifierSchema().describe('Target worker identifier.'),
    projectId: identifierSchema().describe('Target project identifier.'),
    summary: textSchema('summary', 4000),
    actions: z.array(actionSchema).min(1).max(16).describe('One through sixteen executable actions.'),
    replyTo: identifierSchema('replyTo')
      .optional()
      .describe('Optional exact exchange correlation identifier.'),
  })
  .describe('Executable host handoff; admission and authorization remain host responsibilities.');

export const envelopeIdentitySchema = envelopeSchema
  .pick({
    protocol: true,
    id: true,
    workerId: true,
    projectId: true,
    summary: true,
  })
  .describe('Handoff identity and summary, validated before action contents.');

export const proposalEnvelopeSchema = envelopeSchema
  .extend({
    actions: z
      .array(proposalActionSchema)
      .min(1)
      .max(16)
      .superRefine((actions, context) => {
        for (const [index, action] of actions.entries()) {
          if (action.type === 'generateImage' && actions.length !== 1) {
            context.addIssue({
              code: 'custom',
              path: [index, 'type'],
              message: 'Return generateImage on its own, then wait for the generated image before saving it.',
            });
          }
          if (action.type === 'finish' && index < actions.length - 1) {
            context.addIssue({
              code: 'custom',
              path: [index, 'type'],
              message: 'finish must be the final action in a batch.',
            });
          }
        }
      })
      .describe('One through sixteen proposed actions; finish must be last.'),
  })
  .describe('Model proposal handoff; referenced edits require native-host resolution before execution.');

export const requestSchema = z
  .strictObject({
    id: identifierSchema(),
    method: textSchema('method', 100),
    params: recordSchema('params')
      .nullish()
      .transform((value) => value ?? {})
      .describe('RPC parameters; legacy null/omitted parameters mean an empty object.'),
  })
  .describe('Strict RPC request; method-specific parameter validation happens at the receiving boundary.');

export const responseSchema = z
  .discriminatedUnion('ok', [
    z
      .strictObject({
        id: z.string().describe('Request correlation identifier.'),
        ok: z.literal(true).describe('Successful response discriminant.'),
        result: z.unknown().describe('Method-specific result, validated by its consumer.'),
      })
      .describe('Successful RPC response.'),
    z
      .strictObject({
        id: z.string().describe('Request correlation identifier.'),
        ok: z.literal(false).describe('Failed response discriminant.'),
        error: z.string().describe('User-visible request error.'),
      })
      .describe('Failed RPC response.'),
  ])
  .describe('RPC response envelope; result shape depends on the method.');

export type Envelope = z.infer<typeof envelopeSchema>;
export type ProposalEnvelope = z.infer<typeof proposalEnvelopeSchema>;
export type Request = z.infer<typeof requestSchema>;
export type Response = z.infer<typeof responseSchema>;
