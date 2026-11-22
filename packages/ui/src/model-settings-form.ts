import { z } from 'zod';
import { settingsSchema, type Settings } from '../../protocol/src/index.js';
import { parseModelSettings } from '../../protocol/src/model-settings.js';
import type { ModelPickerResult } from '../../protocol/src/rpc.js';
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
  pick: () => Promise<ModelPickerResult>;
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
  const pickButton = requireElement(root, '[data-pick-model]', window.HTMLButtonElement);
  const clearButton = requireElement(root, '[data-clear-model]', window.HTMLButtonElement);
  const selection = requireElement(root, '[data-model-selection]', window.HTMLElement);
  const inputs = {
    gpu: requireElement(form, '[name="gpu"]', window.HTMLSelectElement),
    contextSize: requireElement(form, '[name="contextSize"]', window.HTMLInputElement),
    maxTokens: requireElement(form, '[name="maxTokens"]', window.HTMLInputElement),
  };

  for (const key of ['gpu', 'contextSize', 'maxTokens'] as const) {
    inputs[key].value = String(options.settings[key]);
  }

  const selects = enhanceSelects(root);
  let modelPath = options.settings.coderModelPath;
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

  function showSelection(): void {
    if (modelPath) {
      selection.textContent = modelPath;
      pickButton.textContent = 'Change model file…';
    } else {
      selection.textContent = 'No model selected.';
      pickButton.textContent = 'Choose model file…';
    }
    clearButton.hidden = !modelPath;
  }

  function clearError(): void {
    error.hidden = true;
    error.textContent = '';
  }

  function showError(reason: unknown): void {
    reveal(error);
    error.textContent = String(reason);
    if (reason instanceof Error) {
      error.textContent = reason.message;
    }
    error.hidden = false;
  }

  function setBusy(operation?: 'pick' | 'save'): void {
    busy = operation !== undefined;
    fields.disabled = busy;

    // Custom select controls mirror explicit disabled attributes, not fieldset inheritance.
    for (const input of Object.values(inputs)) {
      input.disabled = busy;
    }

    pickButton.disabled = busy;
    clearButton.disabled = busy;
    submitButton.disabled = busy;
    resetButton.disabled = busy;
    submitButton.textContent = 'Save model settings';
    showSelection();

    if (operation === 'save') {
      submitButton.textContent = 'Saving…';
    } else if (operation === 'pick') {
      pickButton.textContent = 'Choosing file…';
    }

    form.setAttribute('aria-busy', String(busy));
    options.busyChanged?.(operation === 'save');
  }

  const pick = async () => {
    if (busy || !isCurrent()) {
      return;
    }

    clearError();
    setBusy('pick');
    try {
      const result = await options.pick();
      if (isCurrent() && !result.cancelled) {
        modelPath = result.path;
      }
    } catch (reason) {
      if (isCurrent()) {
        showError(reason);
      }
    } finally {
      if (isCurrent()) {
        setBusy();
        if (form.ownerDocument.activeElement === form.ownerDocument.body) {
          pickButton.focus();
        }
      }
    }
  };

  const clear = () => {
    if (!busy && isCurrent()) {
      modelPath = '';
      clearError();
      showSelection();
      pickButton.focus();
    }
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();

    if (busy || !isCurrent() || !form.reportValidity()) {
      return;
    }

    clearError();

    try {
      const settings = parseModelSettings({
        coderModelPath: modelPath,
        gpu: inputs.gpu.value,
        contextSize: Number(inputs.contextSize.value),
        maxTokens: Number(inputs.maxTokens.value),
      });
      setBusy('save');
      await options.save({ settings });

      if (isCurrent()) {
        setBusy();
        options.close();
      }
    } catch (reason) {
      if (isCurrent()) {
        showError(reason);
      }
    } finally {
      if (isCurrent() && busy) {
        setBusy();
      }
    }
  };

  const reset = () => {
    if (!busy && isCurrent()) {
      options.reset();
    }
  };
  showSelection();
  pickButton.addEventListener('click', pick);
  clearButton.addEventListener('click', clear);
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
      pickButton.removeEventListener('click', pick);
      clearButton.removeEventListener('click', clear);
      resetButton.removeEventListener('click', reset);
      selects.dispose();
      root.replaceChildren();
    },
  };
}
