import { z } from 'zod';
import {
  exchangeIdSchema,
  identifierSchema,
  nonNegativeIntegerSchema,
  normalizeMessageText,
  sha256Schema,
} from '../schemas/primitives.js';

import { unwrapMessage } from './frames.js';

/** Receipts contain hashes and task identity, never prompts or permission grants.
 * Optional fields keep older hash-only receipts readable. */
export const outboundReceiptSchema = z
  .object({
    workerId: identifierSchema.describe('The task that sent this message.'),
    projectId: identifierSchema.describe('The project that owns this task.'),
    goalHash: sha256Schema.describe('A fingerprint of the complete task goal.'),
    textHash: sha256Schema.describe('A fingerprint of the complete outgoing message.'),
    renderedHash: sha256Schema.describe('A fingerprint of the composer text after insertion.'),
    at: z.number().describe('When this send was recorded, in milliseconds since the Unix epoch.'),
    exchangeId: exchangeIdSchema.optional().describe('The exchange ID; older receipts may not have one.'),
    expectsReplyTo: z.literal(true).optional().describe('The reply must name the saved exchange ID.'),
    payloadHash: sha256Schema.optional().describe('A fingerprint of the message body without its wrapper.'),
    messageId: identifierSchema.optional().describe('The send intent ID used to prevent duplicate sends.'),
    turn: nonNegativeIntegerSchema
      .min(1)
      .max(100000)
      .optional()
      .describe('The task turn reserved for this send.'),
    priorReplyIds: z
      .array(identifierSchema)
      .max(64)
      .optional()
      .describe('Reply IDs already visible before this send.'),
    acknowledgedUserId: identifierSchema.optional().describe('The user message confirmed after sending.'),
    acknowledgedHash: sha256Schema.optional().describe('A fingerprint of the confirmed full user message.'),
    priorUserId: identifierSchema.optional().describe('The latest user message before this send.'),
    priorUserHash: sha256Schema.optional().describe('A fingerprint of the preceding user message.'),
    priorAssistantHash: sha256Schema.optional().describe('A fingerprint of the preceding assistant reply.'),
  })
  .describe('Saved proof used to match one outgoing message to its task and reply.');

export type OutboundReceipt = z.infer<typeof outboundReceiptSchema>;

function legacyOptional<Schema extends z.ZodType>(schema: Schema) {
  return schema.optional().catch(undefined);
}

// Older releases ignored malformed optional hints, but never malformed required
// hashes or a malformed reply baseline. Preserve that migration behavior.
const savedReceiptSchema = outboundReceiptSchema.extend({
  exchangeId: legacyOptional(exchangeIdSchema),
  expectsReplyTo: legacyOptional(z.literal(true)),
  payloadHash: legacyOptional(sha256Schema),
  messageId: legacyOptional(identifierSchema),
  turn: legacyOptional(nonNegativeIntegerSchema.min(1).max(100000)),
  acknowledgedUserId: legacyOptional(identifierSchema),
  acknowledgedHash: legacyOptional(sha256Schema),
  priorUserId: legacyOptional(identifierSchema),
  priorUserHash: legacyOptional(sha256Schema),
  priorAssistantHash: legacyOptional(sha256Schema),
});

export function parseReceipt(raw: unknown): OutboundReceipt | undefined {
  const result = savedReceiptSchema.safeParse(raw);

  if (!result.success) {
    return;
  }

  const saved = result.data;
  const receipt: OutboundReceipt = {
    workerId: saved.workerId,
    projectId: saved.projectId,
    goalHash: saved.goalHash,
    textHash: saved.textHash,
    renderedHash: saved.renderedHash,
    at: saved.at,
  };

  if (saved.exchangeId !== undefined) {
    receipt.exchangeId = saved.exchangeId;

    if (saved.expectsReplyTo === true) {
      receipt.expectsReplyTo = true;
    }
  }

  if (saved.payloadHash !== undefined) {
    receipt.payloadHash = saved.payloadHash;
  }

  if (saved.priorReplyIds !== undefined) {
    receipt.priorReplyIds = [...new Set(saved.priorReplyIds)];
  }

  if (saved.messageId !== undefined) {
    receipt.messageId = saved.messageId;
  }

  if (saved.turn !== undefined) {
    receipt.turn = saved.turn;
  }

  if (saved.acknowledgedUserId !== undefined) {
    receipt.acknowledgedUserId = saved.acknowledgedUserId;
  }

  if (saved.acknowledgedHash !== undefined) {
    receipt.acknowledgedHash = saved.acknowledgedHash;
  }

  if (saved.priorUserId !== undefined) {
    receipt.priorUserId = saved.priorUserId;
  }

  if (saved.priorUserHash !== undefined) {
    receipt.priorUserHash = saved.priorUserHash;
  }

  if (saved.priorAssistantHash !== undefined) {
    receipt.priorAssistantHash = saved.priorAssistantHash;
  }

  return receipt;
}

export async function messageDigest(text: string): Promise<string> {
  const normalizedText = normalizeMessageText(text);
  const bytes = new TextEncoder().encode(normalizedText);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hexadecimalBytes = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));

  return hexadecimalBytes.join('');
}

/** Full-message hashes authorize a match. A payload fallback also requires a
 * complete, uniquely framed exchange, so a shared marker cannot match alone. */
export async function matchesReceipt(text: string, receipt: OutboundReceipt): Promise<boolean> {
  const digest = await messageDigest(text);
  const knownHashes = [receipt.textHash, receipt.renderedHash, receipt.acknowledgedHash];

  if (knownHashes.includes(digest)) {
    return true;
  }

  const frame = unwrapMessage(text);

  if (!frame || frame.exchangeId !== receipt.exchangeId || !receipt.payloadHash) {
    return false;
  }

  const payloadDigest = await messageDigest(frame.payload);

  return payloadDigest === receipt.payloadHash;
}
