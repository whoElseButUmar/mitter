import { REWRITE_MODES } from '../../../protocol/src/rewrite.js';

/** Shared native rewrite controls; each composer owns its own draft and async lifetime. */
export function createRewriteFields(document: Document) {
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
  return { fields, mode, provider };
}
