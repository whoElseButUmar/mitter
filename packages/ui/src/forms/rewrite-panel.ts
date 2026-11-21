import { textElement } from '../dom/elements.js';
import { REWRITE_MODES } from '../../../protocol/src/rewrite.js';

/** Shared native rewrite controls; each composer owns its own draft and async lifetime. */
export function createRewritePanel(document: Document, panelLabel: string, cancelLabel: string) {
  const fields = document.createElement('div');
  fields.className = 'rewrite-fields';

  function field(title: string, entries: [string, string][]): HTMLSelectElement {
    const label = document.createElement('label');
    label.className = 'field';
    const name = document.createElement('span');
    name.textContent = title;
    const select = document.createElement('select');
    select.setAttribute('aria-label', title);

    for (const [value, text] of entries) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }

    label.append(name, select);
    fields.append(label);
    return select;
  }

  const mode = field(
    'Rewrite style',
    Object.entries(REWRITE_MODES).map(([key, value]) => [key, value.label]),
  );
  const provider = field('Rewrite engine', [
    ['chatgpt', 'ChatGPT · rewrite the wording'],
    ['local', 'Local · structure instantly'],
  ]);
  const toggle = textElement(document, 'button', 'Rewrite…', 'rewrite-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('section');
  panel.className = 'rewrite-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', panelLabel);
  const privacy = textElement(document, 'p', '', 'muted small');
  const preview = document.createElement('textarea');
  preview.className = 'rewrite-preview';
  preview.rows = 5;
  preview.readOnly = true;
  preview.hidden = true;
  preview.setAttribute('aria-label', 'Rewrite preview');

  const buttons = document.createElement('div');
  buttons.className = 'button-row end';
  const cancel = textElement(document, 'button', cancelLabel);
  const generate = textElement(document, 'button', 'Preview rewrite');
  const apply = textElement(document, 'button', 'Apply to draft', 'primary');
  cancel.type = 'button';
  generate.type = 'button';
  apply.type = 'button';
  apply.hidden = true;
  buttons.append(cancel, generate, apply);
  panel.append(fields, privacy, preview, buttons);

  function showProviderHelp(): void {
    if (provider.value === 'local') {
      privacy.textContent = 'Adds a local template and keeps your original wording.';
    } else {
      privacy.textContent = 'Shares this draft in a separate ChatGPT chat for you to review.';
    }
  }

  showProviderHelp();
  provider.addEventListener('change', showProviderHelp);
  return {
    panel,
    toggle,
    fields,
    mode,
    provider,
    preview,
    cancel,
    generate,
    apply,
    dispose() {
      provider.removeEventListener('change', showProviderHelp);
    },
  };
}
