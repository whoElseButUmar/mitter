import { z } from 'zod';
import { BUNDLED_FONT } from '../fonts/schemas.js';
import { DataObjectSchema } from '../validation.js';
import { parseTheme, resolvedTheme } from './themes.js';
import {
  CustomThemeIdSchema,
  TerminalPreferencesSchema,
  TerminalThemeSchema,
  type TerminalPreferences,
} from './types.js';

export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  version: 1,
  themeId: 'graphite',
  fontFamily: BUNDLED_FONT,
  useSystemFonts: false,
  fontSize: 13,
  lineHeight: 1.2,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 3000,
  customThemes: [],
};

const fields = TerminalPreferencesSchema.shape;

export const SavedCustomThemeSchema = z
  .preprocess((entry) => {
    const objectResult = DataObjectSchema.safeParse(entry);

    if (!objectResult.success) {
      return undefined;
    }

    const idResult = CustomThemeIdSchema.safeParse(objectResult.data.id);

    if (!idResult.success) {
      return undefined;
    }

    try {
      return parseTheme(entry, idResult.data);
    } catch {
      return undefined;
    }
  }, TerminalThemeSchema.optional())
  .describe('A saved custom theme migrated from flat, colors, or theme fields; corrupt entries are omitted.');

export const SavedPreferencesSchema = TerminalPreferencesSchema.extend({
  themeId: fields.themeId
    .catch(DEFAULT_TERMINAL_PREFERENCES.themeId)
    .describe('The saved selected theme identifier, with graphite as the corrupt-field default.'),
  fontFamily: fields.fontFamily
    .catch(BUNDLED_FONT)
    .describe('A saved safe font family name, with the bundled font as the corrupt-field default.'),
  useSystemFonts: fields.useSystemFonts
    .optional()
    .catch(undefined)
    .describe('Older settings omit this field; the selected font then determines the choice.'),
  fontSize: fields.fontSize
    .catch(DEFAULT_TERMINAL_PREFERENCES.fontSize)
    .describe('The saved text size in pixels, from 10 to 28; corrupt values use 13 pixels.'),
  lineHeight: fields.lineHeight
    .catch(DEFAULT_TERMINAL_PREFERENCES.lineHeight)
    .describe('Saved line spacing from 1 to 1.8 times the text height; corrupt values use 1.2.'),
  cursorStyle: fields.cursorStyle
    .catch(DEFAULT_TERMINAL_PREFERENCES.cursorStyle)
    .describe('The saved block, bar, or underline cursor shape; corrupt values use block.'),
  cursorBlink: fields.cursorBlink
    .catch(DEFAULT_TERMINAL_PREFERENCES.cursorBlink)
    .describe('The saved cursor blink preference; corrupt values enable blinking.'),
  scrollback: fields.scrollback
    .catch(DEFAULT_TERMINAL_PREFERENCES.scrollback)
    .describe('Saved output history from 500 to 10000 lines; corrupt values retain 3000 lines.'),
  customThemes: z
    .array(SavedCustomThemeSchema)
    .catch([])
    .transform((entries) => entries.slice(0, 20).filter((entry) => entry !== undefined))
    .describe('The first 20 saved theme entries, with corrupt entries omitted after migration.'),
}).describe('Version-one saved settings, with independent defaults for malformed fields.');

export function parsePreferences(raw: unknown): TerminalPreferences {
  const result = SavedPreferencesSchema.safeParse(raw);

  if (!result.success) {
    return {
      ...DEFAULT_TERMINAL_PREFERENCES,
      customThemes: [],
    };
  }

  const saved = result.data;

  let fontFamily = saved.fontFamily;
  let useSystemFonts = saved.useSystemFonts;

  const importedFont = fontFamily.startsWith('MiterFont_');

  if (useSystemFonts === undefined) {
    useSystemFonts = fontFamily !== BUNDLED_FONT && !importedFont;
  }

  if (!useSystemFonts && !importedFont) {
    fontFamily = BUNDLED_FONT;
  }

  const preferences = { ...saved, fontFamily, useSystemFonts };
  preferences.themeId = resolvedTheme(preferences).id;

  return preferences;
}
