import { textElement } from '../dom/elements.js';
import { REWRITE_MODES } from '../../../protocol/src/rewrite.js';

export function createRewritePanel(document: Document) {
  const toggle = textElement(document, 'button', 'Rewrite…', 'rewrite-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('section');
  panel.className = 'rewrite-panel';
  panel.id = 'rewrite-' + crypto.randomUUID();
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Rewrite draft');
  toggle.setAttribute('aria-controls', panel.id);

  const settings = document.createElement('div');
  settings.className = 'rewrite-settings';
  const privacy = textElement(document, 'p', 'Sends your draft to a separate ChatGPT chat.', 'muted small');
  const details = document.createElement('details');
  details.className = 'rewrite-options';
  const summary = textElement(document, 'summary', 'Rewrite options');
  const label = document.createElement('label');
  label.className = 'field';
  label.append(textElement(document, 'span', 'Style'));
  const mode = document.createElement('select');

  for (const [value, { label: name }] of Object.entries(REWRITE_MODES)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = name;
    mode.append(option);
  }

  label.append(mode);
  const local = textElement(document, 'button', 'Format on this device');
  local.type = 'button';
  details.append(summary, label, local);
  settings.append(privacy, details);

  const output = document.createElement('label');
  output.className = 'rewrite-output';
  output.textContent = 'Rewrite preview';
  output.hidden = true;
  const preview = document.createElement('textarea');
  preview.className = 'rewrite-preview';
  preview.rows = 4;
  preview.readOnly = true;
  output.append(preview);

  const status = document.createElement('p');
  status.className = 'rewrite-status';
  status.setAttribute('role', 'status');
  const buttons = document.createElement('div');
  buttons.className = 'button-row end';
  const cancel = textElement(document, 'button', 'Cancel');
  const generate = textElement(document, 'button', 'Rewrite with ChatGPT', 'primary');
  const apply = textElement(document, 'button', 'Use rewrite', 'primary');
  cancel.type = 'button';
  generate.type = 'button';
  apply.type = 'button';
  apply.hidden = true;
  buttons.append(cancel, generate, apply);
  panel.append(settings, output, status, buttons);

  return {
    toggle,
    panel,
    settings,
    privacy,
    details,
    mode,
    local,
    output,
    preview,
    status,
    cancel,
    generate,
    apply,
  };
}
