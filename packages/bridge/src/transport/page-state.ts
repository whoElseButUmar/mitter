import { z } from 'zod';
import { exceedsHandoffBytes } from '../../../protocol/src/reply-json.js';
import {
  chatViewSchema,
  codeAncestorSchema,
  codeReadObservationSchema,
  codeReplySchema,
  disclosureObservationSchema,
  receiptDiscoveryStatsSchema,
  transcriptStatsSchema,
  type ChatView,
  type DomRequest,
} from '../dom/types.js';
import { identifierSchema, nonNegativeIntegerSchema } from '../schemas/primitives.js';
import { PageBridgeError } from './page-error.js';

const structuralCountSchema = nonNegativeIntegerSchema.max(24000);

const transportedReceiptDiscoverySchema = receiptDiscoveryStatsSchema.extend({
  candidates: structuralCountSchema,
  matches: structuralCountSchema,
  tailBranches: structuralCountSchema,
  responseControls: structuralCountSchema,
});

const transportedCodeAncestorSchema = codeAncestorSchema.extend({
  tag: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,40}$/)
    .describe('An element tag name, without its text.'),
  attributes: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,64}$/))
    .max(12)
    .describe('Attribute names only; their values are never reported.'),
});

const transportedTranscriptSchema = transcriptStatsSchema
  .extend({
    roleAttributes: structuralCountSchema,
    alternativeRoles: structuralCountSchema,
    semanticRoles: structuralCountSchema,
    turnContainers: structuralCountSchema,
    unknownTurns: structuralCountSchema,
    users: structuralCountSchema,
    assistants: structuralCountSchema,
    codeBlocks: structuralCountSchema,
    openShadowRoots: structuralCountSchema,
    frames: structuralCountSchema,
    receiptDiscovery: transportedReceiptDiscoverySchema.optional(),
    codeAncestry: z.array(z.array(transportedCodeAncestorSchema).max(7)).max(2).optional(),
  })
  .superRefine((transcript, context) => {
    if (!transcript.receiptDiscovery) {
      return;
    }

    if (transcript.version !== 'message-discovery/2' || transcript.strategy !== 'receipt') {
      context.addIssue({
        code: 'custom',
        path: ['receiptDiscovery'],
        message: 'Receipt diagnostics require the receipt-based reader version.',
      });
    }
  });

const transportedCodeReplySchema = codeReplySchema.extend({
  id: z.string().max(100).describe('The observed reply ID, still subject to task validation.'),
  text: z
    .string()
    .refine((text) => !exceedsHandoffBytes(text))
    .describe('The original reply within the transport byte limit.'),
  replyTo: z.string().max(100).optional().describe('The exchange named by the reply, when supplied.'),
});

export const pageStateSchema = chatViewSchema
  .omit({ replyEvidence: true })
  .extend({
    composerSession: identifierSchema.optional().describe('The exact document that prepared the message.'),
    userIds: z
      .array(z.string().max(200))
      .max(256)
      .optional()
      .describe('Up to 256 observed user-message identities.'),
    disclosure: disclosureObservationSchema.extend({ attempts: nonNegativeIntegerSchema.max(3) }).optional(),
    transcript: transportedTranscriptSchema.optional(),
    codeRead: codeReadObservationSchema
      .extend({
        characters: nonNegativeIntegerSchema.max(400001),
        fingerprint: z
          .string()
          .regex(/^[0-9a-f]{1,8}$/)
          .describe('A short change signal, not proof of message ownership.'),
        issue: z.string().max(64).describe('The reader result for the newest code payload.'),
      })
      .optional(),
    codeReply: transportedCodeReplySchema.optional(),
    unlinkedReply: transportedCodeReplySchema.optional(),
    codeReplyIds: z
      .array(identifierSchema)
      .max(64)
      .optional()
      .describe('Up to 64 task replies observed on the page.'),
    codeReplyTotal: nonNegativeIntegerSchema.max(65).optional(),
  })
  .describe('Validated page observations with bounded diagnostic lists and reply payloads.');

export function readPageState(value: unknown, operation: DomRequest['op']): ChatView {
  const result = pageStateSchema.safeParse(value);

  if (!result.success) {
    throw new PageBridgeError(
      'INVALID_PAGE_STATE',
      'The page adapter returned incomplete or invalid state.',
      true,
      { cause: result.error },
    );
  }

  const view = result.data;
  const composerOperation = operation === 'prepare' || operation === 'commit' || operation === 'send';

  if (composerOperation && view.outcome === undefined) {
    throw new PageBridgeError(
      'INVALID_PAGE_STATE',
      'The composer operation returned no outcome. No send acknowledgement was accepted.',
      true,
    );
  }

  return view;
}
