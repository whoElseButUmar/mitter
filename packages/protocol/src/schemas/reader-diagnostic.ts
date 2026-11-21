import { z } from 'zod';

export const transcriptDiscoveryStateSchema = z
  .enum(['ready', 'empty', 'unrecognized', 'partial'])
  .describe('Transcript-discovery result.');

export const receiptDiscoveryStateSchema = z
  .enum([
    'searching',
    'missing',
    'mismatch',
    'ambiguous',
    'collapsed',
    'matched',
    'waiting_reply',
    'unknown_tail',
    'limit',
  ])
  .describe('Result of receipt-bound message discovery.');

export const readerRevisionSchema = z
  .int()
  .min(1)
  .max(2 ** 31 - 1)
  .describe('Positive 32-bit revision of the reader script that made the observation.');

const count = z.int().min(0).max(24000).describe('Bounded structural count in the inspected conversation.');

export const readerDiagnosticSchema = z
  .strictObject({
    readerRevision: readerRevisionSchema
      .optional()
      .describe('Version of the reader that produced the observation, when reported.'),
    transcript: transcriptDiscoveryStateSchema.optional().describe('Observed state of transcript discovery.'),
    receipt: receiptDiscoveryStateSchema
      .optional()
      .describe('Observed state of matching the saved outgoing message.'),
    matches: count.optional().describe('Number of matching message containers observed.'),
    tail: count.optional().describe('Number of content branches observed after the matching message.'),
    reason: z
      .enum([
        'unclassified_tail',
        'scan_limit',
        'busy',
        'draft',
        'not_ready',
        'awaiting_receipt',
        'different_conversation',
        'ambiguous_reply',
        'newer_message',
        'receipt_mismatch',
        'incomplete_reply',
        'invalid_reply',
        'wrong_exchange',
        'validation_rejected',
        'verifying_reply',
      ])
      .describe('Reason the reader is waiting or verifying a candidate reply.'),
  })
  .readonly()
  .describe(
    'Display-only reader observation, containing structural counts and states without conversation text.',
  );

export type ReaderDiagnostic = z.infer<typeof readerDiagnosticSchema>;
