import { terminalAppearanceStorageSchema, type SavedFont } from '../ui/view-data';
import { persistLocal } from '../data-view';
import { createSignal, onMount, onCleanup } from 'solid-js';
import {
  BUNDLED_FONT,
  MAX_FONT_BYTES,
  MAX_IMPORTED_FONT_BYTES,
  DEFAULT_TERMINAL_PREFERENCES,
  parsePreferences,
  parseTheme,
  validateFontBytes,
  type TerminalPreferences,
} from '../../../../packages/terminal/src/appearance';
import type { InstalledFont } from '../../../../packages/terminal/src/fonts';
import { listSystemMonospaceFonts } from '../../../../packages/terminal/src/system-fonts';

const PREF = 'miter.terminal.appearance.v1';

const FONTS = 'miter.terminal.fonts.v1';

export function createTerminalAppearance(
  changed: (preferences: TerminalPreferences) => void,
  fail: (error: unknown) => void,
  setError: (message: string) => void,
) {
  let alive = true;
  const [prefs, setPrefs] = createSignal<TerminalPreferences>({
    ...DEFAULT_TERMINAL_PREFERENCES,
    customThemes: [],
  });

  const [fonts, setFonts] = createSignal<SavedFont[]>([]);

  const [ready, setReady] = createSignal(false);

  const [systemFonts, setSystemFonts] = createSignal<InstalledFont[]>([]);

  const [fontBusy, setFontBusy] = createSignal(false);

  const faces = new Map<string, FontFace>();

  let fontInstalling = false;
  let themeImports = 0;
  let preferenceWrites: Promise<void> = Promise.resolve();
  let preferenceRevision = 0;
  let storageLoaded = false;

  const apply = async (next: TerminalPreferences) => {
    if (!alive) {
      return;
    }
    if (!storageLoaded) {
      throw new Error(
        'Saved terminal settings are unavailable. Reload this Miter view before changing them.',
      );
    }
    const preferences = parsePreferences(next);
    preferenceRevision++;
    setPrefs(preferences);
    changed(preferences);

    const write = preferenceWrites
      .catch(() => {})
      .then(() => {
        if (!alive) {
          return;
        }
        return persistLocal({ [PREF]: preferences });
      });
    preferenceWrites = write;

    try {
      await write;
    } catch (error) {
      if (alive) {
        throw error;
      }
    }
  };

  async function importTheme(file?: File) {
    if (!alive || !file) {
      return;
    }
    let reserved = false;

    try {
      if (file.size > 32768) {
        throw Error('Theme files must be smaller than 32 KB.');
      }
      await initialized;
      if (!alive) {
        return;
      }
      if (!storageLoaded) {
        throw new Error(
          'Saved terminal settings are unavailable. Reload this Miter view before importing a theme.',
        );
      }
      if (prefs().customThemes.length + themeImports >= 20) {
        throw Error('Remove a custom theme before adding another.');
      }
      themeImports++;
      reserved = true;

      const text = await file.text();
      if (!alive) {
        return;
      }
      const theme = parseTheme(JSON.parse(text));
      if (prefs().customThemes.length >= 20) {
        throw Error('Remove a custom theme before adding another.');
      }
      const writing = apply({
        ...prefs(),
        themeId: theme.id,
        customThemes: [...prefs().customThemes, theme],
      });
      themeImports--;
      reserved = false;
      await writing;

      if (alive) {
        setError('');
      }
    } catch (event) {
      if (alive) {
        fail(event);
      }
    } finally {
      if (reserved) {
        themeImports--;
      }
    }
  }

  async function loadFont(family: string, bytes: Uint8Array<ArrayBuffer>) {
    if (!alive) {
      return;
    }
    const face = new FontFace(family, bytes);
    await face.load();
    if (!alive) {
      return;
    }
    document.fonts.add(face);
    faces.set(family, face);
  }
  async function importFont(file?: File) {
    if (!alive || !file || fontInstalling) {
      return;
    }
    fontInstalling = true;

    const installing = fontOperations
      .catch(() => {})
      .then(async () => {
        if (!alive) {
          return;
        }
        let family = '';
        let stored = false;

        try {
          if (!storageLoaded) {
            throw new Error(
              'Saved terminal settings are unavailable. Reload this Miter view before importing a font.',
            );
          }
          if (file.size > MAX_FONT_BYTES) {
            throw Error('Choose a font no larger than 4 MB.');
          }
          const importedBytes = fonts().reduce((totalBytes, fontEntry) => {
            let byteCount = Math.floor((fontEntry.data.length * 3) / 4);
            if (fontEntry.data.endsWith('==')) {
              byteCount -= 2;
            } else if (fontEntry.data.endsWith('=')) {
              byteCount--;
            }
            return totalBytes + byteCount;
          }, 0);
          if (importedBytes + file.size > MAX_IMPORTED_FONT_BYTES) {
            throw Error('Imported fonts may use at most 6 MB in total. Remove a font first.');
          }
          if (fonts().length >= 2) {
            throw Error('Remove an imported font before adding another (maximum 2).');
          }

          const buffer = await file.arrayBuffer();
          if (!alive) {
            return;
          }
          const bytes = new Uint8Array(buffer);
          validateFontBytes(bytes);
          if (importedBytes + bytes.length > MAX_IMPORTED_FONT_BYTES) {
            throw Error('Imported fonts may use at most 6 MB in total. Remove a font first.');
          }
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 8192) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          }
          const font: SavedFont = {
            family: 'MiterFont_' + crypto.randomUUID().replaceAll('-', ''),
            name: file.name.slice(0, 80),
            data: btoa(binary),
          };
          family = font.family;
          await loadFont(family, bytes);
          if (!alive) {
            return;
          }

          const next = [...fonts(), font];
          await persistLocal({ [FONTS]: next });
          if (!alive) {
            return;
          }
          stored = true;
          setFonts(next);
          await apply({ ...prefs(), fontFamily: family });
          if (alive) {
            setError('');
          }
        } catch (event) {
          if (!alive) {
            return;
          }
          if (family && !stored) {
            const face = faces.get(family);
            if (face) {
              document.fonts.delete(face);
            }
            faces.delete(family);
          }
          fail(event);
        }
      });
    fontOperations = installing;

    try {
      await installing;
    } finally {
      fontInstalling = false;
    }
  }

  async function removeFont() {
    if (!alive) {
      return;
    }
    const family = prefs().fontFamily;

    const removing = fontOperations
      .catch(() => {})
      .then(async () => {
        if (!alive || !fonts().some((font) => font.family === family)) {
          return;
        }
        try {
          if (prefs().fontFamily === family) {
            await apply({ ...prefs(), fontFamily: BUNDLED_FONT });
            if (!alive) {
              return;
            }
          }
          const next = fonts().filter((font) => font.family !== family);
          await persistLocal({ [FONTS]: next });
          if (!alive) {
            return;
          }
          setFonts(next);

          const face = faces.get(family);
          if (face) {
            document.fonts.delete(face);
            faces.delete(family);
          }
        } catch (event) {
          if (alive) {
            throw event;
          }
        }
      });
    fontOperations = removing;
    await removing;
  }
  async function loadBundledFont() {
    const face = new FontFace(
      BUNDLED_FONT,
      'url(' + JSON.stringify(chrome.runtime.getURL('fonts/FiraCodeNerdFontMono-Regular.ttf')) + ')',
      {
        weight: '400',
        style: 'normal',
      },
    );
    await face.load();
    if (!alive) {
      return;
    }
    document.fonts.add(face);
    faces.set(BUNDLED_FONT, face);
  }

  async function useSystemFonts(enabled: boolean) {
    if (!alive || fontBusy()) {
      return;
    }
    setFontBusy(true);
    try {
      if (!enabled) {
        setSystemFonts([]);
        await apply({
          ...prefs(),
          useSystemFonts: false,
        });
        return;
      }
      // Chrome requires fontSettings at installation. The checkbox gates local
      // enumeration, not a runtime permission prompt. Never change browser fonts.
      const available = await listSystemMonospaceFonts(chrome.fontSettings);
      if (!alive) {
        return;
      }
      setSystemFonts(available);
      await apply({
        ...prefs(),
        useSystemFonts: true,
      });
      if (alive) {
        setError('');
      }
    } catch (event) {
      if (alive) {
        fail(event);
      }
    } finally {
      if (alive) {
        setFontBusy(false);
      }
    }
  }

  async function restore() {
    const restoringRevision = preferenceRevision;
    try {
      await loadBundledFont();
    } catch {
      if (alive) {
        fail(
          Error(
            'The bundled FiraCode Nerd Font Mono could not load. A safe monospace fallback is active. Rebuild the extension with prepare:font to restore it.',
          ),
        );
      }
    }
    if (!alive) {
      return;
    }
    const data = terminalAppearanceStorageSchema.parse(await chrome.storage.local.get([PREF, FONTS]));
    if (!alive) {
      return;
    }
    storageLoaded = true;
    let preferences = data[PREF];
    const saved = data[FONTS];
    const valid: SavedFont[] = [];
    let importedBytes = 0;
    for (const font of saved) {
      if (!alive) {
        return;
      }
      if (valid.some((entry) => entry.family === font.family)) {
        continue;
      }
      try {
        const bytes = Uint8Array.from(atob(font.data), (character) => character.charCodeAt(0));
        validateFontBytes(bytes);
        if (importedBytes + bytes.length > MAX_IMPORTED_FONT_BYTES) {
          continue;
        }
        await loadFont(font.family, bytes);
        if (!alive) {
          return;
        }
        importedBytes += bytes.length;
        valid.push(font);
      } catch (error) {
        if (alive) {
          console.warn('Miter saved font could not be restored.', error);
        }
      }
    }
    if (!alive) {
      return;
    }
    setFonts(valid);
    if (
      preferences.fontFamily.startsWith('MiterFont_') &&
      !valid.some((font) => font.family === preferences.fontFamily)
    ) {
      preferences = {
        ...preferences,
        fontFamily: BUNDLED_FONT,
      };
    }
    if (preferenceRevision !== restoringRevision) {
      preferences = prefs();
    }
    if (preferences.useSystemFonts) {
      try {
        const available = await listSystemMonospaceFonts(chrome.fontSettings);
        if (!alive) {
          return;
        }
        setSystemFonts(available);
        if (
          preferences.fontFamily !== BUNDLED_FONT &&
          !valid.some((font) => font.family === preferences.fontFamily) &&
          !available.some((font) => font.fontId === preferences.fontFamily)
        ) {
          fail(Error('The selected system font is missing. FiraCode Nerd Font Mono is being used instead.'));
          preferences = {
            ...preferences,
            fontFamily: BUNDLED_FONT,
          };
        }
      } catch (event) {
        if (!alive) {
          return;
        }
        fail(event);
        preferences = parsePreferences({
          ...preferences,
          useSystemFonts: false,
        });
      }
    }
    if (alive) {
      if (preferenceRevision === restoringRevision) {
        setPrefs(preferences);
      }
      setReady(true);
    }
  }

  const initialized = new Promise<void>((resolve) => {
    onMount(() => {
      void restore()
        .catch((event) => {
          if (alive) {
            fail(
              new Error(
                'Saved terminal appearance could not be read. Reload this Miter view before changing settings or importing files.',
                { cause: event },
              ),
            );
          }
        })
        .finally(resolve);
    });
  });
  let fontOperations = initialized;

  onCleanup(() => {
    alive = false;
    for (const face of faces.values()) {
      try {
        document.fonts.delete(face);
      } catch (event) {
        console.warn('Miter terminal font could not be removed.', event);
      }
    }
    faces.clear();
    setFonts([]);
    setSystemFonts([]);
    setFontBusy(false);
  });

  return {
    prefs,
    fonts,
    ready,
    systemFonts,
    fontBusy,

    apply,
    importTheme,
    importFont,
    removeFont,
    useSystemFonts,
  };
}
