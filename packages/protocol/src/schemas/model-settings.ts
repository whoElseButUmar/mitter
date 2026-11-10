import { z } from 'zod';
import { integerSchema, textSchema } from './primitives.js';

export const settingsSchema = z
  .strictObject({
    coderModelPath: textSchema('model path', 2000, true),
    contextSize: integerSchema('context', 2048, 32_768),
    maxTokens: integerSchema('output tokens', 256, 8192),
    gpu: z
      .enum(['auto', 'cpu'], { error: 'Choose auto or cpu.' })
      .describe('Automatic GPU selection or CPU-only inference.'),
  })
  .refine((value) => value.maxTokens < value.contextSize, {
    error: 'Output token limit must be smaller than context size.',
  })
  .describe('Bounded local inference settings; output tokens must fit inside context.');

export type Settings = z.infer<typeof settingsSchema>;
