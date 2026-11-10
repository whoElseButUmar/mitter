import { z } from 'zod';

export const MAX_FONT_BYTES = 4 * 1024 * 1024;
export const MAX_IMPORTED_FONT_BYTES = 6 * 1024 * 1024;

function hasSupportedSignature(bytes: Uint8Array): boolean {
  const signature = String.fromCharCode(...bytes.slice(0, 4));
  const isTrueType = bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0;

  return isTrueType || ['OTTO', 'wOFF', 'wOF2'].includes(signature);
}

export const FontBytesSchema = z
  .instanceof(Uint8Array)
  .refine(
    (bytes) => bytes.length >= 12 && bytes.length <= MAX_FONT_BYTES,
    'Choose a font no larger than 4 MB.',
  )
  .refine(hasSupportedSignature, 'Supported font files: TTF, OTF, WOFF, WOFF2.')
  .describe('Font-file bytes, up to 4 MB, with a TTF, OTF, WOFF, or WOFF2 header.');

export function validateFontBytes(bytes: Uint8Array): void {
  const result = FontBytesSchema.safeParse(bytes);

  if (!result.success) {
    const messages = result.error.issues.map((issue) => issue.message);

    throw new Error(messages.join(' '));
  }
}
