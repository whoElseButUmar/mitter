import type { TerminalTheme } from './types.js';

const basePalette = {
  black: '#191919',
  red: '#df7777',
  green: '#a9c580',
  yellow: '#ebcc87',
  blue: '#8aafd1',
  magenta: '#be9acb',
  cyan: '#8ebec1',
  white: '#d5d2c8',
  brightBlack: '#777772',
  brightRed: '#ef9696',
  brightGreen: '#bed99a',
  brightYellow: '#f4dda5',
  brightBlue: '#a7c8e7',
  brightMagenta: '#d2b2dc',
  brightCyan: '#a8d5d6',
  brightWhite: '#fffbee',
};

export const DEFAULT_THEME: TerminalTheme = {
  id: 'graphite',
  name: 'Miter Graphite',
  custom: false,
  colors: {
    ...basePalette,
    background: '#191b1d',
    foreground: '#dddcd2',
    cursor: '#e6c88d',
    cursorAccent: '#191b1d',
    selectionBackground: '#50534d',
  },
};

export const BUILTIN_THEMES: TerminalTheme[] = [
  DEFAULT_THEME,
  {
    id: 'amber',
    name: 'Classic Amber',
    custom: false,
    colors: {
      ...basePalette,
      background: '#18150e',
      foreground: '#e8bd70',
      cursor: '#ffcf75',
      cursorAccent: '#18150e',
      selectionBackground: '#59462b',
    },
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    custom: false,
    colors: {
      ...basePalette,
      background: '#101913',
      foreground: '#a8d4a2',
      cursor: '#c6efab',
      cursorAccent: '#101913',
      selectionBackground: '#304b35',
    },
  },
  {
    id: 'paper',
    name: 'Studio Paper',
    custom: false,
    colors: {
      ...basePalette,
      background: '#f3efe4',
      foreground: '#343631',
      cursor: '#8a6128',
      cursorAccent: '#f3efe4',
      selectionBackground: '#d5c9ae',
      black: '#232623',
      white: '#7d786f',
      brightWhite: '#3c403b',
      yellow: '#80611e',
      green: '#356235',
      cyan: '#276567',
      blue: '#3c5f93',
    },
  },
  {
    id: 'ocean',
    name: 'Night Ocean',
    custom: false,
    colors: {
      ...basePalette,
      background: '#13202b',
      foreground: '#cbd7de',
      cursor: '#92c6da',
      cursorAccent: '#13202b',
      selectionBackground: '#354b60',
    },
  },
];
