import { parseRewriteRequest, structureLocally, type RewriteRequest } from '../../protocol/src/rewrite.js';
import { createRewriteFields } from './forms/rewrite-fields.js';
import { enhanceSelects } from './select.js';

export type DraftRewriteOptions = {
  rewrite?(request: RewriteRequest, signal: AbortSignal): Promise<string>;
  busyChanged?(busy: boolean): void;
};

/** Preview/apply only. No task create, start, send or executor capability is passed into this component. */
export function mountDraftRewrite(
  root: HTMLElement,
  input: HTMLTextAreaElement,
  options: DraftRewriteOptions,
) {
  const document = root.ownerDocument;
  let alive = true;
  let disabled = false;
  let busy = false;
  let controller: AbortController | undefined;
  let original = '';
  let result = '';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'rewrite-toggle';
  toggle.textContent = 'Rewrite…';
  toggle.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('section');
  panel.className = 'rewrite-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Rewrite new task');
  const fields = createRewriteFields(document);
  const privacy = document.createElement('p');
  privacy.className = 'muted small';
  const preview = document.createElement('textarea');
  preview.className = 'rewrite-preview';
  preview.rows = 5;
  preview.readOnly = true;
  preview.hidden = true;
  preview.setAttribute('aria-label', 'Rewrite preview');
  const status = document.createElement('p');
  status.className = 'followup-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  const buttons = document.createElement('div');
  buttons.className = 'button-row end';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel rewrite';
  const generate = document.createElement('button');
  generate.type = 'button';
  generate.textContent = 'Preview rewrite';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'primary';
  apply.textContent = 'Apply to draft';
  apply.hidden = true;
  buttons.append(cancel, generate, apply);
  panel.append(fields.fields, privacy, preview, buttons);
  root.append(toggle, panel, status);
  const selects = enhanceSelects(fields.fields);

  function help(): void {
    privacy.textContent =
      'Shares only this draft in a separate ChatGPT chat. ' +
      'Preview and Apply do not create or start a task.';

    if (fields.provider.value === 'local') {
      privacy.textContent =
        'Adds a local template without an AI model or network request. ' +
        'Your original wording is retained.';
    }
  }

  fields.provider.addEventListener('change', help);
  help();

  function message(text: string): void {
    status.textContent = text;
    status.hidden = false;
  }

  function update(): void {
    toggle.disabled = disabled;
    generate.disabled = disabled || busy;
    apply.disabled = disabled || busy;
    generate.textContent = 'Preview rewrite';

    if (busy) {
      generate.textContent = 'Rewriting…';
    }
  }

  function hide(): void {
    controller?.abort();
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.onclick = () => {
    if (panel.hidden) {
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
    } else {
      hide();
    }
  };
  cancel.onclick = hide;
  generate.onclick = async () => {
    if (busy || disabled) {
      return;
    }

    if (!input.value.trim()) {
      message('Enter a task draft before rewriting.');
      input.focus();
      return;
    }

    original = input.value;
    result = '';
    preview.hidden = true;
    apply.hidden = true;
    status.hidden = true;
    controller = new AbortController();
    const signal = controller.signal;
    busy = true;
    options.busyChanged?.(true);
    update();

    try {
      const request = parseRewriteRequest({
        instruction: original,
        mode: fields.mode.value,
        provider: fields.provider.value,
      });
      let rewritten: string | undefined;

      if (request.provider === 'local') {
        rewritten = structureLocally(request);
      } else {
        rewritten = await options.rewrite?.(request, signal);
      }

      if (!alive || signal.aborted) {
        return;
      }

      if (
        typeof rewritten !== 'string' ||
        !rewritten.trim() ||
        rewritten.length > 4000 ||
        rewritten.includes('\0')
      ) {
        throw new Error('The rewrite did not return a valid draft.');
      }

      result = rewritten;
      preview.value = result;
      preview.hidden = false;
      apply.hidden = false;
      message('Preview ready. Apply it to the draft, then start the task when ready.');
    } catch (reason) {
      if (alive && !signal.aborted) {
        let text = String(reason);

        if (reason instanceof Error) {
          text = reason.message;
        }

        message(text);
      }
    } finally {
      busy = false;

      if (alive) {
        options.busyChanged?.(false);
        update();
      }
    }
  };
  apply.onclick = () => {
    if (disabled || busy || !result) {
      return;
    }

    if (input.value !== original) {
      message(
        'Your draft changed while rewriting. Rewrite the current draft ' +
          'or copy useful text from the preview.',
      );
      return;
    }

    input.value = result;
    result = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    hide();
    message('Rewrite applied. No task has been created or started.');
    input.focus();
  };

  return {
    get busy() {
      return busy;
    },
    setDisabled(value: boolean) {
      disabled = value;
      update();
    },
    dispose() {
      alive = false;
      controller?.abort();
      fields.provider.removeEventListener('change', help);
      toggle.onclick = null;
      cancel.onclick = null;
      generate.onclick = null;
      apply.onclick = null;
      selects.dispose();
      root.replaceChildren();
    },
  };
}
