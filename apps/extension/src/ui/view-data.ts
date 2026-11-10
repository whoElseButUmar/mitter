import { z } from 'zod';
export { rewriteOperationResultSchema as rewriteViewSchema } from '../schemas/local-results.js';
export {
  changedFileSchema,
  teamSchema as teamViewSchema,
  type ChangedFile,
  type Team as TeamView,
} from '../../../../packages/protocol/src/rpc.js';
import {
  MAX_FONT_BYTES,
  parsePreferences,
  TerminalPreferencesSchema,
} from '../../../../packages/terminal/src/appearance.js';

export const renameTargetSchema = z
  .object({
    kind: z.enum(['project', 'task']).describe('The entity whose display name is changing.'),
    id: z.string().describe('The saved entity identifier.'),
  })
  .describe('The captured target of a display-name edit.');

export type RenameTarget = z.infer<typeof renameTargetSchema>;

export const savedFontSchema = z
  .object({
    family: z
      .string()
      .regex(/^MiterFont_[a-f0-9]+$/)
      .describe('The generated local CSS font family.'),
    name: z.string().max(80).describe('The original imported font filename.'),
    data: z
      .string()
      .max(Math.ceil(MAX_FONT_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((data) => data.length % 4 === 0)
      .describe('The bounded base64-encoded local font bytes; the font signature is checked before loading.'),
  })
  .describe('An imported font saved only in extension storage.');

export type SavedFont = z.infer<typeof savedFontSchema>;

export const savedFontsSchema = z
  .array(savedFontSchema.optional().catch(undefined))
  .catch([])
  .transform((entries) => entries.slice(0, 2).filter((entry) => entry !== undefined))
  .describe('The first two imported font records, with malformed rows omitted during restoration.');

export function savedFonts(value: unknown): SavedFont[] {
  return savedFontsSchema.parse(value);
}

export const terminalAppearanceStorageSchema = z
  .object({
    'miter.terminal.appearance.v1': z
      .preprocess(parsePreferences, TerminalPreferencesSchema)
      .describe('Version-one terminal settings restored through the compatibility migration.'),
    'miter.terminal.fonts.v1': savedFontsSchema,
  })
  .describe(
    'The local storage response for terminal appearance; a malformed envelope cannot authorize writes.',
  );
