import { z } from 'zod';

export const BUNDLED_FONT = 'FiraCode Nerd Font Mono';

export const FontFamilySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\p{L}\p{N} _.+-]+$/u)
  .describe('A font family name, up to 100 characters, without CSS punctuation.');

export const InstalledFontSchema = z
  .looseObject({
    fontId: FontFamilySchema,
    displayName: z.string().describe('The font name shown in the font picker.'),
  })
  .describe('A font reported by Chrome on this computer.');

export type InstalledFont = z.infer<typeof InstalledFontSchema>;

export const FontListSchema = z
  .array(InstalledFontSchema.optional().catch(undefined))
  .transform((entries) => entries.filter((entry) => entry !== undefined))
  .describe('Fonts reported by Chrome, with malformed entries removed before measuring font widths.');
