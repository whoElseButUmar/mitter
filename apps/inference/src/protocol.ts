import { z } from 'zod';
import { settingsSchema } from '../../../packages/protocol/src/model-settings.js';

export const modelCorrelationSchema = z
  .object({
    id: z.string().min(1).max(100).describe('The request ID used to match an inference response.'),
  })
  .describe('The correlation ID usable when an inference request is rejected.');

export const modelRequestSchema = z
  .strictObject({
    id: modelCorrelationSchema.shape.id,
    method: z.literal('propose').describe('The supported local-model operation.'),
    input: z.string().describe('The complete prompt sent to the local model.'),
    settings: settingsSchema.describe('The local model path and inference limits.'),
  })
  .describe('A single local-model inference request.');

export const modelOutputSchema = z
  .string()
  .describe('The literal text returned by the local model, without coercion or whitespace normalization.');

export function parseModelOutput(value: unknown): z.infer<typeof modelOutputSchema> {
  const parsed = modelOutputSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error('Local model returned invalid text. No actions were proposed.', { cause: parsed.error });
  }

  return parsed.data;
}

export const modelResponseSchema = z
  .discriminatedUnion('ok', [
    z.strictObject({
      id: modelCorrelationSchema.shape.id,
      ok: z.literal(true).describe('The inference request succeeded.'),
      result: modelOutputSchema,
    }),
    z.strictObject({
      id: modelCorrelationSchema.shape.id,
      ok: z.literal(false).describe('The inference request failed.'),
      error: z.string().describe('The validation or inference failure message.'),
    }),
  ])
  .describe('A checked local inference result or failure, correlated by request ID.');

export type ModelSettings = z.infer<typeof settingsSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;
