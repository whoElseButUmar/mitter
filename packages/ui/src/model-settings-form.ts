import type { Settings } from '../../protocol/src/index.js';
import { parseModelSettings } from '../../protocol/src/model-settings.js';
import { enhanceSelects } from './select.js';

export interface ModelSettingsFormOptions {
  settings: Settings;
  save: (value: { settings: Settings }) => Promise<unknown>;
  close: () => void;
  reset: () => void;
  busyChanged?: (busy: boolean) => void;
}

/** Small, independently testable settings editor. Neither rendering nor saving
 * runs a model; a separate explicit task action starts local inference. */
export function mountModelSettingsForm(root: HTMLElement, options: ModelSettingsFormOptions) {
  root.innerHTML = `<form class="model-settings-form" aria-label="Local coding model settings">
    <p class="muted">Optional local coding model. ChatGPT tasks do not need these settings. Choose a GGUF file already on this computer.</p>
    <fieldset class="model-settings-fields">
      <label class="field"><span>Coding model (.gguf)</span><input name="coderModelPath" placeholder="/absolute/path/coder.gguf" spellcheck="false" maxlength="2000" autocomplete="off"></label>
      <label class="field"><span>Compute</span><select name="gpu"><option value="auto">Auto-detect GPU</option><option value="cpu">CPU only</option></select></label>
      <div class="form-row">
        <label class="field"><span>Context tokens</span><input name="contextSize" type="number" min="2048" max="32768" step="1" required></label>
        <label class="field"><span>Output token cap</span><input name="maxTokens" type="number" min="256" max="8192" step="1" required></label>
      </div>
    </fieldset>
    <p class="notice">The runtime is installed separately; no weights are downloaded automatically. One shared inference process generates proposals. File validation, hash checks, command approvals and completion checks always apply.</p>
    <p class="error" role="alert" hidden></p>
    <button class="primary full" type="submit">Save model settings</button>
    <section class="reset-danger-zone"><h3>Application data</h3><p class="muted small">Permanently remove Miter’s projects, tasks, history, terminal imports, approvals, and settings. Your actual project folders and files stay untouched.</p><button type="button" class="danger" data-reset>Clear all Miter data…</button></section>
  </form>`;
  const form = root.querySelector<HTMLFormElement>('form')!;
  const fields = root.querySelector<HTMLFieldSetElement>('fieldset')!;
  const error = root.querySelector<HTMLElement>('[role="alert"]')!;
  const submitButton = root.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const resetButton = root.querySelector<HTMLButtonElement>('[data-reset]')!;
  const input = (key: keyof Settings) => form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement;
  for (const key of ['coderModelPath', 'gpu', 'contextSize', 'maxTokens'] as const) input(key).value = String(options.settings[key]);
  const selects = enhanceSelects(root);
  let busy = false, disposed = false;

  const setBusy = (value: boolean) => {
    busy = value;
    fields.disabled = value;
    // Custom select controls mirror explicit disabled attributes, not fieldset inheritance.
    for (const key of ['coderModelPath', 'gpu', 'contextSize', 'maxTokens'] as const) input(key).disabled = value;
    submitButton.disabled = value;
    resetButton.disabled = value;
    submitButton.textContent = value ? 'Saving…' : 'Save model settings';
    form.setAttribute('aria-busy', String(value));
    options.busyChanged?.(value);
  };
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || disposed || !form.reportValidity()) return;
    error.hidden = true;
    error.textContent = '';
    try {
      const settings = parseModelSettings({
        coderModelPath: input('coderModelPath').value,
        gpu: input('gpu').value,
        contextSize: Number(input('contextSize').value),
        maxTokens: Number(input('maxTokens').value),
      });
      setBusy(true);
      await options.save({ settings });
      if (!disposed) {
        setBusy(false);
        options.close();
      }
    } catch (reason) {
      if (!disposed) {
        error.textContent = reason instanceof Error ? reason.message : String(reason);
        error.hidden = false;
      }
    } finally {
      if (!disposed && busy) setBusy(false);
    }
  };
  const reset = () => { if (!busy && !disposed) options.reset(); };
  form.addEventListener('submit', submit);
  resetButton.addEventListener('click', reset);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      form.removeEventListener('submit', submit);
      resetButton.removeEventListener('click', reset);
      selects.dispose();
      root.replaceChildren();
    },
  };
}
