import { terminalSettings } from '../ui/terminal-settings';
import { For, Show, type Accessor } from 'solid-js';
import { SelectSurface } from '../controls';
import { Modal } from '../components';
import {
  BUNDLED_FONT,
  BUILTIN_THEMES,
  DEFAULT_TERMINAL_PREFERENCES,
  resolvedTheme,
  TerminalPreferencesSchema,
  type TerminalPreferences,
} from '../../../../packages/terminal/src/appearance';
import type { InstalledFont } from '../../../../packages/terminal/src/fonts';
import type { SavedFont } from '../ui/view-data';

type TerminalAppearanceProps = {
  prefs: Accessor<TerminalPreferences>;
  fonts: Accessor<SavedFont[]>;
  systemFonts: Accessor<InstalledFont[]>;
  ready: Accessor<boolean>;
  fontBusy: Accessor<boolean>;
  error: Accessor<string>;
  apply: (preferences: TerminalPreferences) => Promise<void>;
  fail: (error: unknown) => void;
  importTheme: (file?: File) => Promise<void>;
  importFont: (file?: File) => Promise<void>;
  removeFont: () => Promise<void>;
  useSystemFonts: (enabled: boolean) => Promise<void>;
  close: () => void;
};

function parseCursorStyle(value: string) {
  return TerminalPreferencesSchema.shape.cursorStyle.parse(value);
}

export function TerminalAppearance(props: TerminalAppearanceProps) {
  const {
    prefs,
    fonts,
    systemFonts,
    ready,
    fontBusy,
    error,
    apply,
    fail,
    importTheme,
    importFont,
    removeFont,
    useSystemFonts,
  } = props;
  return (
    <Modal title="Terminal appearance" close={() => props.close()}>
      <SelectSurface>
        <label class="field">
          <span>Theme</span>
          <select
            disabled={!ready()}
            value={prefs().themeId}
            onChange={(event) =>
              void apply({
                ...prefs(),
                themeId: event.currentTarget.value,
              }).catch(fail)
            }
          >
            <For each={[...BUILTIN_THEMES, ...prefs().customThemes]}>
              {(theme) => <option value={theme.id}>{theme.name}</option>}
            </For>
          </select>
        </label>
        <div
          class="terminal-theme-preview"
          style={{
            background: resolvedTheme(prefs()).colors.background,
            color: resolvedTheme(prefs()).colors.foreground,
            'font-family': terminalSettings(prefs()).fontFamily,
          }}
        >
          <span
            style={{
              color: resolvedTheme(prefs()).colors.green,
            }}
          >
            ~/Projects
          </span>{' '}
          <span
            style={{
              color: resolvedTheme(prefs()).colors.cursor,
            }}
          >
            ❯
          </span>{' '}
          pwd
          <br />
          <span
            style={{
              color: resolvedTheme(prefs()).colors.brightBlack,
            }}
          >
            Aa Bb 0123456789 (appearance preview)
          </span>
        </div>
        <div class="button-row">
          <label class="file-import">
            Install theme…
            <input
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                void importTheme(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
          </label>
          <Show when={prefs().themeId.startsWith('custom-')}>
            <button
              disabled={!ready()}
              onClick={() =>
                void apply({
                  ...prefs(),
                  themeId: 'graphite',
                  customThemes: prefs().customThemes.filter((theme) => theme.id !== prefs().themeId),
                }).catch(fail)
              }
            >
              Remove theme
            </button>
          </Show>
        </div>
        <label class="field">
          <span>Font</span>
          <select
            disabled={!ready()}
            value={prefs().fontFamily}
            onChange={(event) =>
              void apply({
                ...prefs(),
                fontFamily: event.currentTarget.value,
              }).catch(fail)
            }
          >
            <option value={BUNDLED_FONT}>{BUNDLED_FONT}</option>
            <Show when={prefs().useSystemFonts}>
              <For each={systemFonts()}>
                {(font) => <option value={font.fontId}>{font.displayName}</option>}
              </For>
            </Show>
            <For each={fonts()}>{(font) => <option value={font.family}>{font.name}</option>}</For>
          </select>
        </label>
        <label class="checkline">
          <input
            type="checkbox"
            checked={prefs().useSystemFonts}
            disabled={fontBusy() || !ready()}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              event.currentTarget.checked = prefs().useSystemFonts;
              void useSystemFonts(enabled);
            }}
          />
          <span>Use system fonts</span>
        </label>
        <p class="muted small">
          Off: bundled and imported fonts only. On: also show installed monospace fonts. Missing fonts fall
          back to FiraCode Nerd Font Mono or another monospace font. Chrome grants font access when Miter is
          installed. This switch controls local font discovery; Miter never changes Chrome’s font settings or
          uploads the font list.
        </p>
        <div class="button-row">
          <label class="file-import">
            Install font…
            <input
              type="file"
              accept=".ttf,.otf,.woff,.woff2"
              onChange={(event) => {
                void importFont(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
          </label>
          <Show when={fonts().some((font) => font.family === prefs().fontFamily)}>
            <button onClick={() => void removeFont().catch(fail)}>Remove font</button>
          </Show>
        </div>
        <div class="terminal-settings-grid">
          <label class="field">
            <span>Size</span>
            <input
              type="number"
              disabled={!ready()}
              min="10"
              max="28"
              value={prefs().fontSize}
              onChange={(event) =>
                void apply({
                  ...prefs(),
                  fontSize: Number(event.currentTarget.value),
                }).catch(fail)
              }
            />
          </label>
          <label class="field">
            <span>Line height</span>
            <input
              type="number"
              disabled={!ready()}
              min="1"
              max="1.8"
              step="0.1"
              value={prefs().lineHeight}
              onChange={(event) =>
                void apply({
                  ...prefs(),
                  lineHeight: Number(event.currentTarget.value),
                }).catch(fail)
              }
            />
          </label>
          <label class="field">
            <span>Cursor</span>
            <select
              disabled={!ready()}
              value={prefs().cursorStyle}
              onChange={(event) =>
                void apply({
                  ...prefs(),
                  cursorStyle: parseCursorStyle(event.currentTarget.value),
                }).catch(fail)
              }
            >
              <option value="block">Block</option>
              <option value="bar">Bar</option>
              <option value="underline">Underline</option>
            </select>
          </label>
        </div>
        <label class="checkline">
          <input
            type="checkbox"
            disabled={!ready()}
            checked={prefs().cursorBlink}
            onChange={(event) =>
              void apply({
                ...prefs(),
                cursorBlink: event.currentTarget.checked,
              }).catch(fail)
            }
          />
          <span>Blink cursor</span>
        </label>
        <label class="field">
          <span>Scrollback lines</span>
          <input
            type="number"
            disabled={!ready()}
            min="500"
            max="10000"
            step="500"
            value={prefs().scrollback}
            onChange={(event) =>
              void apply({
                ...prefs(),
                scrollback: Number(event.currentTarget.value),
              }).catch(fail)
            }
          />
        </label>
        <p class="muted small">
          Themes are local JSON color files. Fonts are stored only inside this extension; none are uploaded.
        </p>
        <Show when={error()}>
          <p class="error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="button-row end">
          <button
            disabled={!ready()}
            onClick={() =>
              void apply({
                ...DEFAULT_TERMINAL_PREFERENCES,
                customThemes: prefs().customThemes,
              }).catch(fail)
            }
          >
            Reset appearance
          </button>
          <button class="primary" onClick={() => props.close()}>
            Done
          </button>
        </div>
      </SelectSurface>
    </Modal>
  );
}
