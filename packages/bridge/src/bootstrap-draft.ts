import { z } from 'zod';
import { exchangeIdSchema, identifierSchema, sha256Schema } from './schemas/primitives.js';
import { unwrapMessage } from './wire/frames.js';

export const bootstrapDraftSchema = z
  .object({
    workerId: identifierSchema.describe('The task that prepared this message.'),
    projectId: identifierSchema.describe('The project owning the message.'),
    exchangeId: exchangeIdSchema.describe('The exchange that used this exact composer text.'),
    goalHash: sha256Schema.describe('The original task goal fingerprint.'),
    origin: z
      .enum(['https://chatgpt.com', 'https://chat.openai.com'])
      .describe('The provider origin where this composer text was inserted.'),
    rawHash: sha256Schema.describe('SHA-256 of the exact UTF-8 composer text, without normalization.'),
  })
  .describe(
    'A composer fingerprint. A confirmed send or an imported reply is needed to recover its stale draft.',
  );

export type BootstrapDraft = z.infer<typeof bootstrapDraftSchema>;

export async function rawDraftDigest(text: string): Promise<string> {
  if (/[\uD800-\uDFFF]/u.test(text)) {
    throw new Error('Invalid composer text: an unpaired Unicode surrogate cannot be fingerprinted.');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function matchesBootstrapDraft(
  text: string,
  proof: Pick<BootstrapDraft, 'exchangeId' | 'rawHash'>,
): Promise<boolean> {
  if (
    !text ||
    /[\uD800-\uDFFF]/u.test(text) ||
    text.length > 160000 ||
    unwrapMessage(text)?.exchangeId !== proof.exchangeId
  ) {
    return false;
  }
  return (await rawDraftDigest(text)) === proof.rawHash;
}
