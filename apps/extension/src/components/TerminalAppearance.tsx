import { terminalSettings } from '../ui/terminal-settings';
import { For, Show, type Accessor } from 'solid-js';
import { SelectSurface } from '../controls';
import { Modal } from '../components';
import { Icon } from '../icons';
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
        <div class="settings-page terminal-appearance">
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
          <div class="terminal-settings-grid">
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
            <label class="field">
              <span>Font size</span>
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
          </div>
          <div
            class="terminal-theme-preview"
            style={{
              background: resolvedTheme(prefs()).colors.background,
              color: resolvedTheme(prefs()).colors.foreground,
              'font-family': terminalSettings(prefs()).fontFamily,
              'font-size': prefs().fontSize + 'px',
              'line-height': String(prefs().lineHeight),
            }}
          >
            <span style={{ color: resolvedTheme(prefs()).colors.green }}>~/Projects</span>{' '}
            <span style={{ color: resolvedTheme(prefs()).colors.cursor }}>❯</span> pwd
            <br />
            <span>Aa Bb 0123456789</span>
          </div>
          <details class="form-advanced terminal-appearance-options">
            <summary>
              <Icon name="down" />
              Advanced options
            </summary>
            <div class="terminal-appearance-group">
              <h3>Font sources</h3>
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
                Adds installed monospace fonts. Font names stay on this computer; Chrome’s font settings are
                unchanged. Missing fonts fall back to FiraCode Nerd Font Mono or another monospace font.
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
                  <button type="button" onClick={() => void removeFont().catch(fail)}>
                    Remove font
                  </button>
                </Show>
              </div>
            </div>
            <div class="terminal-appearance-group">
              <h3>Theme files</h3>
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
                    type="button"
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
              <p class="muted small">
                Theme files use JSON. Imported themes and fonts stay in this Chrome profile; nothing is
                uploaded.
              </p>
            </div>
            <div class="terminal-appearance-group">
              <h3>Terminal behavior</h3>
              <div class="terminal-settings-grid">
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
            </div>
            <button
              type="button"
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
          </details>
          <Show when={error()}>
            <p class="error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="button-row settings-footer">
            <span class="muted small">Changes save automatically.</span>
            <button type="button" class="primary" onClick={() => props.close()}>
              Done
            </button>
          </div>
        </div>
      </SelectSurface>
    </Modal>
  );
}
