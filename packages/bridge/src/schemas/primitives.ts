import { z } from 'zod';
import { identifierSchema as protocolIdentifierSchema } from '../../../protocol/src/schemas/primitives.js';
import { chatgptAddress } from '../connections/chatgpt.js';

export const identifierSchema = protocolIdentifierSchema().describe(
  'An ID with up to 100 letters, numbers, underscores, or hyphens.',
);

export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe('A SHA-256 fingerprint written as 64 lowercase hexadecimal characters.');

export const exchangeIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .describe('The unique ID linking an outgoing message to its reply.');

export const nonNegativeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .describe('A whole number that is zero or greater.');

export function isSavedConversationUrl(address: string): boolean {
  return chatgptAddress(address) === address;
}

export const conversationUrlSchema = z
  .string()
  .max(600)
  .refine(isSavedConversationUrl)
  .describe('A saved ChatGPT conversation address without query parameters or a fragment.');

export function normalizeMessageText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}
