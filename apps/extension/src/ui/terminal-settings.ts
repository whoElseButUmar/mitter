import type { ITheme } from '@xterm/xterm';
import {
  BUNDLED_FONT,
  COLOR_KEYS,
  resolvedTheme,
  type TerminalColors,
  type TerminalPreferences,
} from '../../../../packages/terminal/src/appearance';

export function terminalTheme(colors: TerminalColors): ITheme {
  const theme: ITheme = {};

  for (const key of COLOR_KEYS) {
    const color = colors[key];

    if (color !== undefined) {
      theme[key] = color;
    }
  }

  return theme;
}

export function terminalSettings(preferences: TerminalPreferences) {
  return {
    theme: terminalTheme(resolvedTheme(preferences).colors),
    fontFamily:
      JSON.stringify(preferences.fontFamily) +
      ', ' +
      JSON.stringify(BUNDLED_FONT) +
      ', Menlo, Monaco, Consolas, monospace',
    fontSize: preferences.fontSize,
    lineHeight: preferences.lineHeight,
    cursorStyle: preferences.cursorStyle,
    cursorBlink: preferences.cursorBlink,
    scrollback: preferences.scrollback,
  };
}
