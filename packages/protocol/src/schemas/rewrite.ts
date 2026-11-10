import { z } from 'zod';

const draftError = 'Enter a draft of up to 4,000 characters.';

export const rewriteModeSchema = z
  .enum(['clarity', 'concise', 'technical', 'steps', 'checks', 'polish'], { error: 'Choose a rewrite mode.' })
  .describe('Requested draft-rewriting mode.');

export const rewriteProviderSchema = z
  .enum(['local', 'chatgpt'], { error: 'Choose a rewrite provider.' })
  .describe('Local deterministic template or linked ChatGPT draft rewrite.');

export const rewriteTextSchema = z
  .string({ error: draftError })
  .refine(
    (value) => {
      return Boolean(value.trim()) && value.length <= 4000 && !value.includes('\0');
    },
    { error: draftError },
  )
  .describe('Nonblank draft text, at most 4,000 UTF-16 code units, without NUL.');

export const rewriteRequestSchema = z
  .strictObject({
    instruction: rewriteTextSchema,
    mode: rewriteModeSchema,
    provider: rewriteProviderSchema,
  })
  .describe('Draft rewrite request; never permission to execute project actions.');

export const rewriteReplySchema = z
  .strictObject({
    protocol: z.literal('miter-rewrite/1').describe('Exact rewrite-response protocol.'),
    requestId: z.string().describe('Exact request correlation identifier.'),
    text: rewriteTextSchema.describe('Rewritten draft, preserving request constraints.'),
  })
  .describe('Strict correlated draft rewrite response.');

export type RewriteMode = z.infer<typeof rewriteModeSchema>;
export type RewriteProvider = z.infer<typeof rewriteProviderSchema>;
export type RewriteRequest = z.infer<typeof rewriteRequestSchema>;
export type RewriteReply = z.infer<typeof rewriteReplySchema>;
