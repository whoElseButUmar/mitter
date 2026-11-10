export {
  COLOR_KEYS,
  HexColorSchema,
  TerminalColorsSchema,
  TerminalThemeSchema,
  TerminalPreferencesSchema,
} from './appearance/types.js';

export type { TerminalColors, TerminalTheme, TerminalPreferences } from './appearance/types.js';

export { BUILTIN_THEMES } from './appearance/builtin-themes.js';
export { parseTheme, resolvedTheme } from './appearance/themes.js';
export { DEFAULT_TERMINAL_PREFERENCES, parsePreferences } from './appearance/preferences.js';
export { BUNDLED_FONT } from './fonts/schemas.js';

export {
  MAX_FONT_BYTES,
  MAX_IMPORTED_FONT_BYTES,
  FontBytesSchema,
  validateFontBytes,
} from './fonts/files.js';
