import { z } from 'zod';

export const NATIVE_PART_EVENT = 'miter.native-part/1';
export const MAX_NATIVE_TRANSFER = 32 * 1024 * 1024;
export const PART_CHARS = 128_000;

const message = 'Invalid native response fragment.';

/** Legacy fragments ignore extension keys; unlike action input, this outgoing
 * response carrier never used a strict allowed-key gate. */
export const nativeFragmentSchema = z
  .object({
    event: z.literal(NATIVE_PART_EVENT, { error: message }).describe('Outgoing native-fragment event.'),
    transferId: z
      .string({ error: message })
      .regex(/^[\w-]{1,100}$/, { error: message })
      .describe('Transfer identifier, 1–100 ASCII word/hyphen characters.'),
    index: z
      .number({ error: message })
      .int({ error: message })
      .nonnegative({ error: message })
      .describe('Zero-based ordered fragment index.'),
    parts: z
      .number({ error: message })
      .int({ error: message })
      .min(2, { error: message })
      .max(263, { error: message })
      .describe('Two through 263 fragments.'),
    characters: z
      .number({ error: message })
      .int({ error: message })
      .min(1, { error: message })
      .max(MAX_NATIVE_TRANSFER, { error: message })
      .describe('Total UTF-16 payload length.'),
    text: z
      .string({ error: message })
      .max(PART_CHARS, { error: message })
      .describe('At most 128,000 UTF-16 code units of exact JSON payload.'),
  })
  .refine((value) => value.index < value.parts, { error: message })
  .describe('Bounded outgoing native-response fragment; not an enlarged action-input channel.');

export type NativeFragment = z.infer<typeof nativeFragmentSchema>;
