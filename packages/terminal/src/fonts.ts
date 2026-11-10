import { BUNDLED_FONT, FontFamilySchema, InstalledFontSchema, type InstalledFont } from './fonts/schemas.js';

export { BUNDLED_FONT, FontFamilySchema, InstalledFontSchema } from './fonts/schemas.js';
export type { InstalledFont } from './fonts/schemas.js';

export function isValidFontFamily(value: unknown): value is string {
  return FontFamilySchema.safeParse(value).success;
}

export function isMonospaceFont(fontId: string, documentRoot: Document = document): boolean {
  if (!isValidFontFamily(fontId)) {
    return false;
  }

  const context = documentRoot.createElement('canvas').getContext('2d');

  if (!context) {
    return false;
  }

  // A serif fallback prevents a missing font from passing the monospace check.
  context.font = '32px ' + JSON.stringify(fontId) + ', serif';
  context.fontKerning = 'none';

  const sample = ' iWm.@0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const widths = Array.from(sample, (character) => context.measureText(character).width);
  const referenceWidth = widths[0];

  if (referenceWidth === undefined) {
    return false;
  }

  return widths.every((width) => width > 0 && Math.abs(width - referenceWidth) < 0.05);
}

export function installedMonospaceFonts(
  fonts: unknown[],
  documentRoot: Document = document,
): InstalledFont[] {
  const fontsById = new Map<string, InstalledFont>();

  for (const entry of fonts) {
    const result = InstalledFontSchema.safeParse(entry);

    if (!result.success) {
      continue;
    }

    const font = result.data;

    if (font.fontId === BUNDLED_FONT) {
      continue;
    }

    if (!isMonospaceFont(font.fontId, documentRoot)) {
      continue;
    }

    fontsById.set(font.fontId, font);
  }

  const sortedFonts = [...fontsById.values()];

  sortedFonts.sort((first, second) => first.displayName.localeCompare(second.displayName));

  return sortedFonts;
}
