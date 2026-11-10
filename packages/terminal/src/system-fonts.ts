import { installedMonospaceFonts, type InstalledFont } from './fonts.js';
import { FontListSchema } from './fonts/schemas.js';

export type SystemFontListAPI = {
  getFontList(): Promise<unknown>;
};

/**
 * Call only when Use system fonts is enabled.
 * Chrome requires the fontSettings permission at installation.
 * The font list stays in memory in this view.
 */
export async function listSystemMonospaceFonts(
  api: SystemFontListAPI | undefined,
  documentRoot: Document = document,
): Promise<InstalledFont[]> {
  if (!api || typeof api.getFontList !== 'function') {
    throw new Error(
      'System font discovery is unavailable. Reload the updated Miter extension and check its permissions. Bundled and imported fonts remain available.',
    );
  }

  const response = await api.getFontList();
  const result = FontListSchema.safeParse(response);

  if (!result.success) {
    throw new Error('Chrome returned an invalid font list. Bundled and imported fonts remain available.', {
      cause: result.error,
    });
  }

  return installedMonospaceFonts(result.data, documentRoot);
}
