import { z } from 'zod';
import { settingsSchema, type Settings } from '../../protocol/src/index.js';
import { parseModelSettings } from '../../protocol/src/model-settings.js';
import { enhanceSelects } from './select.js';
import { requireElement, requireWindow } from './dom/elements.js';
import { modelSettingsTemplate } from './forms/templates.js';
import { addDisclosureMarkers } from './icons.js';

export const ModelSettingsSaveSchema = z
  .object({ settings: settingsSchema })
  .describe('Explicit model settings save; never starts a model or task.');
export type ModelSettingsSave = z.infer<typeof ModelSettingsSaveSchema>;

export type ModelSettingsFormOptions = {
  settings: Settings;
  save: (value: ModelSettingsSave) => Promise<unknown>;
  close: () => void;
  reset: () => void;
  busyChanged?: (busy: boolean) => void;
};

/** Neither rendering nor saving runs a model; a separate explicit task action starts local inference. */
export function mountModelSettingsForm(root: HTMLElement, options: ModelSettingsFormOptions) {
  const window = requireWindow(root.ownerDocument);
  root.innerHTML = modelSettingsTemplate;
  addDisclosureMarkers(root);
  const form = requireElement(root, 'form', window.HTMLFormElement);
  const fields = requireElement(root, 'fieldset', window.HTMLFieldSetElement);
  const error = requireElement(root, '[role="alert"]', window.HTMLElement);
  const submitButton = requireElement(root, '[type="submit"]', window.HTMLButtonElement);
  const resetButton = requireElement(root, '[data-reset]', window.HTMLButtonElement);
  const inputs = {
    coderModelPath: requireElement(form, '[name="coderModelPath"]', window.HTMLInputElement),
    gpu: requireElement(form, '[name="gpu"]', window.HTMLSelectElement),
    contextSize: requireElement(form, '[name="contextSize"]', window.HTMLInputElement),
    maxTokens: requireElement(form, '[name="maxTokens"]', window.HTMLInputElement),
  };

  for (const key of ['coderModelPath', 'gpu', 'contextSize', 'maxTokens'] as const) {
    inputs[key].value = String(options.settings[key]);
  }

  const selects = enhanceSelects(root);
  let busy = false;
  let disposed = false;
  const isCurrent = () => !disposed && root.isConnected;

  function reveal(element: HTMLElement): void {
    if (!isCurrent()) {
      return;
    }
    let disclosure = element.closest('details');
    while (disclosure && root.contains(disclosure)) {
      disclosure.setAttribute('open', '');
      disclosure = disclosure.parentElement?.closest('details') ?? null;
    }
  }

  const invalid = (event: Event) => {
    if (!busy && event.target instanceof window.HTMLElement && form.contains(event.target)) {
      reveal(event.target);
    }
  };

  function setBusy(value: boolean): void {
    busy = value;
    fields.disabled = value;

    // Custom select controls mirror explicit disabled attributes, not fieldset inheritance.
    for (const input of Object.values(inputs)) {
      input.disabled = value;
    }

    submitButton.disabled = value;
    resetButton.disabled = value;
    submitButton.textContent = 'Save model settings';

    if (value) {
      submitButton.textContent = 'Saving…';
    }

    form.setAttribute('aria-busy', String(value));
    options.busyChanged?.(value);
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();

    if (busy || !isCurrent() || !form.reportValidity()) {
      return;
    }

    error.hidden = true;
    error.textContent = '';

    try {
      const settings = parseModelSettings({
        coderModelPath: inputs.coderModelPath.value,
        gpu: inputs.gpu.value,
        contextSize: Number(inputs.contextSize.value),
        maxTokens: Number(inputs.maxTokens.value),
      });
      setBusy(true);
      await options.save({ settings });

      if (isCurrent()) {
        setBusy(false);
        options.close();
      }
    } catch (reason) {
      if (isCurrent()) {
        reveal(error);
        error.textContent = String(reason);

        if (reason instanceof Error) {
          error.textContent = reason.message;
        }

        error.hidden = false;
      }
    } finally {
      if (isCurrent() && busy) {
        setBusy(false);
      }
    }
  };

  const reset = () => {
    if (!busy && isCurrent()) {
      options.reset();
    }
  };
  // Native invalid events do not bubble; open the disclosure before the browser focuses its input.
  form.addEventListener('invalid', invalid, true);
  form.addEventListener('submit', submit);
  resetButton.addEventListener('click', reset);

  return {
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      form.removeEventListener('invalid', invalid, true);
      form.removeEventListener('submit', submit);
      resetButton.removeEventListener('click', reset);
      selects.dispose();
      root.replaceChildren();
    },
  };
}
