import { DataObjectSchema } from '../validation.js';
import { BUILTIN_THEMES, DEFAULT_THEME } from './builtin-themes.js';
import {
  TerminalColorsSchema,
  TerminalThemeSchema,
  type TerminalPreferences,
  type TerminalTheme,
} from './types.js';

const ThemeIdentitySchema = TerminalThemeSchema.pick({ id: true, name: true }).describe(
  'Imported theme identifier and name; colors are validated separately.',
);

/** Imported themes contain hexadecimal colors only. */
export function parseTheme(raw: unknown, id = 'custom-' + crypto.randomUUID()): TerminalTheme {
  const themeResult = DataObjectSchema.safeParse(raw);

  if (!themeResult.success) {
    throw new Error('Choose a theme JSON object.');
  }

  const theme = themeResult.data;
  const nestedColors = theme.colors ?? theme.theme;
  let colorInput: unknown;

  if (nestedColors !== undefined) {
    if (!DataObjectSchema.safeParse(nestedColors).success) {
      throw new Error('Invalid theme colors.');
    }

    const allowedFields = ['name', 'colors', 'theme', 'id', 'custom'];

    for (const field of Object.keys(theme)) {
      if (!allowedFields.includes(field)) {
        throw new Error('Theme contains unsupported fields.');
      }
    }

    colorInput = nestedColors;
  } else {
    const colorEntries = Object.entries(theme).filter(([field]) => !['name', 'id', 'custom'].includes(field));

    colorInput = Object.fromEntries(colorEntries);
  }

  const colorsResult = TerminalColorsSchema.safeParse(colorInput);

  if (!colorsResult.success) {
    throw new Error(
      'Choose valid hexadecimal theme colors, including foreground and background. CSS, scripts and URLs are not supported.',
    );
  }

  let name = 'Imported theme';

  if (typeof theme.name === 'string') {
    name = theme.name;
  }

  const result = ThemeIdentitySchema.safeParse({ id, name });

  if (!result.success) {
    throw new Error('Invalid theme name.');
  }

  return { ...result.data, colors: colorsResult.data, custom: true };
}

export function resolvedTheme(preferences: TerminalPreferences): TerminalTheme {
  return (
    BUILTIN_THEMES.find((theme) => theme.id === preferences.themeId) ??
    preferences.customThemes.find((theme) => theme.id === preferences.themeId) ??
    DEFAULT_THEME
  );
}
