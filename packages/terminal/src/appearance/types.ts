import { z } from 'zod';
import { FontFamilySchema } from '../fonts/schemas.js';

export const HexColorSchema = z
  .string()
  .regex(/^#(?:[a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$/i)
  .describe('A hexadecimal color, such as #fff or #112233. An alpha channel is allowed.');

export const TerminalColorsSchema = z
  .strictObject({
    foreground: HexColorSchema.describe('Text color.'),
    background: HexColorSchema.describe('Terminal background color.'),
    cursor: HexColorSchema.optional().describe('Cursor color. Omit it to use the terminal default.'),
    cursorAccent: HexColorSchema.optional().describe(
      'Text color underneath the cursor. Omit it to use the terminal default.',
    ),
    selectionBackground: HexColorSchema.optional().describe(
      'Background color of selected text. Omit it to use the terminal default.',
    ),
    selectionForeground: HexColorSchema.optional().describe(
      'Color of selected text. Omit it to use the terminal default.',
    ),
    black: HexColorSchema.optional().describe(
      'The black color used by terminal programs. Omit it to use the terminal default.',
    ),
    red: HexColorSchema.optional().describe(
      'The red color used by terminal programs. Omit it to use the terminal default.',
    ),
    green: HexColorSchema.optional().describe(
      'The green color used by terminal programs. Omit it to use the terminal default.',
    ),
    yellow: HexColorSchema.optional().describe(
      'The yellow color used by terminal programs. Omit it to use the terminal default.',
    ),
    blue: HexColorSchema.optional().describe(
      'The blue color used by terminal programs. Omit it to use the terminal default.',
    ),
    magenta: HexColorSchema.optional().describe(
      'The magenta color used by terminal programs. Omit it to use the terminal default.',
    ),
    cyan: HexColorSchema.optional().describe(
      'The cyan color used by terminal programs. Omit it to use the terminal default.',
    ),
    white: HexColorSchema.optional().describe(
      'The white color used by terminal programs. Omit it to use the terminal default.',
    ),
    brightBlack: HexColorSchema.optional().describe(
      'The bright black color used by terminal programs. Omit it to use the terminal default.',
    ),
    brightRed: HexColorSchema.optional().describe(
      'The bright red color used by terminal programs. Omit it to use the terminal default.',
    ),
    brightGreen: HexColorSchema.optional().describe(
      'The bright green color used by terminal programs. Omit it to use the terminal default.',
    ),
    brightYellow: HexColorSchema.optional().describe(
      'The bright yellow color used by terminal programs. Omit it to use the terminal default.',
    ),
    brightBlue: HexColorSchema.optional().describe(
      'The bright blue color used by terminal programs. Omit it to use the terminal default.',
    ),
    brightMagenta: HexColorSchema.optional().describe(
      'The bright magenta color used by terminal programs. Omit it to use the terminal default.',
    ),
    brightCyan: HexColorSchema.optional().describe(
      'The bright cyan color used by terminal programs. Omit it to use the terminal default.',
    ),
    brightWhite: HexColorSchema.optional().describe(
      'The bright white color used by terminal programs. Omit it to use the terminal default.',
    ),
  })
  .describe('Terminal colors. Text and background colors are required.');

export const COLOR_KEYS = TerminalColorsSchema.keyof().options;

export const ThemeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\x00-\x1f]*$/)
  .describe('A theme name with up to 60 characters and no control characters.');

export const CustomThemeIdSchema = z
  .string()
  .regex(/^custom-[A-Za-z0-9_-]+$/)
  .describe('The saved identifier for an imported theme.');

export const TerminalThemeSchema = z
  .object({
    id: z.string().min(1).describe('The identifier used to select this theme.'),
    name: ThemeNameSchema,
    colors: TerminalColorsSchema,
    custom: z.boolean().describe('True for an imported theme. False for a built-in theme.'),
  })
  .describe('A terminal theme with its name, colors, and source.');

export const TerminalPreferencesSchema = z
  .object({
    version: z.literal(1).describe('The saved settings format version.'),
    themeId: z.string().describe('The identifier of the selected theme.'),
    fontFamily: FontFamilySchema,
    useSystemFonts: z.boolean().describe('Whether to look for installed fonts on this computer.'),
    fontSize: z.number().int().min(10).max(28).describe('Text size in pixels, from 10 to 28.'),
    lineHeight: z
      .number()
      .min(1)
      .max(1.8)
      .describe('Line spacing as a multiple of the text height, from 1 to 1.8.'),
    cursorStyle: z.enum(['block', 'bar', 'underline']).describe('The shape of the terminal cursor.'),
    cursorBlink: z.boolean().describe('Whether the cursor blinks.'),
    scrollback: z
      .number()
      .int()
      .min(500)
      .max(10000)
      .describe('How many previous output lines to keep, from 500 to 10000.'),
    customThemes: z
      .array(TerminalThemeSchema)
      .max(20)
      .describe('Up to 20 imported themes saved in this extension.'),
  })
  .describe('Saved settings for terminal appearance and output history.');

export type TerminalColors = z.infer<typeof TerminalColorsSchema>;
export type TerminalTheme = z.infer<typeof TerminalThemeSchema>;
export type TerminalPreferences = z.infer<typeof TerminalPreferencesSchema>;
