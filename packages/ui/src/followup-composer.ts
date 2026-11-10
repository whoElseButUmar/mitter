import { parseRewriteRequest, structureLocally, type RewriteRequest } from '../../protocol/src/rewrite.js';
import type { FollowupRequest } from '../../protocol/src/requests.js';
import { createRewriteFields } from './forms/rewrite-fields.js';
import { enhanceSelects } from './select.js';

export type FollowupComposerOptions = {
  workerId: string;
  running: boolean;
  disabled?: boolean;
  send(request: Pick<FollowupRequest, 'id' | 'instruction' | 'autoStart'>): Promise<unknown>;
  steer?(request: Pick<FollowupRequest, 'id' | 'instruction' | 'autoStart'>): Promise<unknown>;
  rewrite?(request: RewriteRequest, signal: AbortSignal): Promise<string>;
};

/** One draft, explicit preview/apply, then a separate Send. Rewriting never sends;
 * an async result cannot replace a subsequently edited draft. */
export function mountFollowupComposer(root: HTMLElement, options: FollowupComposerOptions) {
  const document = root.ownerDocument;
  let busy = false;
  let alive = true;
  let key = '';
  let id = '';
  let taskGeneration = 0;
  let rewriting = false;
  let abort: AbortController | undefined;
  let original = '';
  let previewText = '';
  const form = document.createElement('form');
  form.className = 'followup-composer';
  const label = document.createElement('label');
  label.className = 'followup-label';
  label.textContent = 'Follow up';
  const input = document.createElement('textarea');
  input.placeholder = 'What would you like to change next?';
  input.rows = 2;
  input.maxLength = 4000;
  input.required = true;
  input.setAttribute('aria-label', 'Follow-up instruction');
  label.append(input);
  const footer = document.createElement('div');
  footer.className = 'followup-footer';
  const hint = document.createElement('small');
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'primary';
  const status = document.createElement('p');
  status.className = 'followup-status';
  status.hidden = true;
  status.setAttribute('role', 'status');
  const steer = document.createElement('button');
  steer.type = 'button';
  steer.className = 'steer-button';
  steer.textContent = 'Steer';
  steer.title = 'Stop the pending plan and use this instruction now. Completed work stays.';
  const rewriteToggle = document.createElement('button');
  rewriteToggle.type = 'button';
  rewriteToggle.textContent = 'Rewrite…';
  rewriteToggle.className = 'rewrite-toggle';
  rewriteToggle.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('section');
  panel.className = 'rewrite-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Rewrite follow-up');
  const fields = createRewriteFields(document);
  const privacy = document.createElement('p');
  privacy.className = 'muted small';
  const preview = document.createElement('textarea');
  preview.className = 'rewrite-preview';
  preview.rows = 5;
  preview.readOnly = true;
  preview.hidden = true;
  preview.setAttribute('aria-label', 'Rewrite preview');
  const buttons = document.createElement('div');
  buttons.className = 'button-row end';
  const generate = document.createElement('button');
  generate.type = 'button';
  generate.textContent = 'Preview rewrite';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'primary';
  apply.textContent = 'Apply to draft';
  apply.hidden = true;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  buttons.append(cancel, generate, apply);
  panel.append(fields.fields, privacy, preview, buttons);
  footer.append(hint, rewriteToggle, steer, send);
  form.append(label, panel, footer, status);
  root.append(form);
  const selects = enhanceSelects(fields.fields);

  function help(): void {
    privacy.textContent =
      'Adds a local instruction template, without an AI model or network request. ' +
      'Your original wording is retained.';

    if (fields.provider.value === 'chatgpt') {
      privacy.textContent =
        'Shares only this draft in a separate ChatGPT chat. ' +
        'The result is a preview; nothing is executed.';
    }
  }

  fields.provider.addEventListener('change', help);
  help();

  function update(next: FollowupComposerOptions): void {
    if (next.workerId !== options.workerId) {
      taskGeneration += 1;
      key = '';
      abort?.abort();
      previewText = '';
      preview.hidden = true;
      apply.hidden = true;
    }

    options = next;
    input.disabled = !!next.disabled || busy;
    send.disabled = !!next.disabled || busy || rewriting;
    steer.hidden = !next.steer;
    steer.disabled = !!next.disabled || busy || rewriting;
    rewriteToggle.disabled = !!next.disabled || busy;
    generate.disabled = !!next.disabled || busy || rewriting;
    generate.textContent = 'Preview rewrite';

    if (rewriting) {
      generate.textContent = 'Rewriting…';
    }

    send.textContent = 'Send';

    if (busy) {
      send.textContent = 'Sending…';
    } else if (next.running) {
      send.textContent = 'Queue follow-up';
    }

    hint.textContent = 'Same task and chat · up to 15 more turns';

    if (next.running) {
      hint.textContent = 'Runs after the current work.';

      if (next.steer) {
        hint.textContent = 'Queue later · Steer now';
      }
    }
  }

  function showError(reason: unknown): void {
    status.textContent = String(reason);

    if (reason instanceof Error) {
      status.textContent = reason.message;
    }

    status.hidden = false;
  }

  function hideRewrite(): void {
    abort?.abort();
    panel.hidden = true;
    rewriteToggle.setAttribute('aria-expanded', 'false');
  }

  rewriteToggle.onclick = () => {
    if (panel.hidden) {
      panel.hidden = false;
      rewriteToggle.setAttribute('aria-expanded', 'true');
    } else {
      hideRewrite();
    }
  };
  cancel.onclick = hideRewrite;
  generate.onclick = async () => {
    if (rewriting || busy || !input.value.trim() || options.disabled) {
      return;
    }

    original = input.value;
    previewText = '';
    preview.hidden = true;
    apply.hidden = true;
    status.hidden = true;
    rewriting = true;
    abort = new AbortController();
    const controller = abort;
    const workerId = options.workerId;
    update(options);

    try {
      const request = parseRewriteRequest({
        instruction: original,
        mode: fields.mode.value,
        provider: fields.provider.value,
      });
      let result: string | undefined;

      if (request.provider === 'local') {
        result = structureLocally(request);
      } else {
        result = await options.rewrite?.(request, controller.signal);
      }

      if (!alive || controller.signal.aborted || options.workerId !== workerId) {
        return;
      }

      if (typeof result !== 'string' || !result.trim() || result.length > 4000) {
        throw new Error('The rewrite did not return a valid draft.');
      }

      previewText = result;
      preview.value = result;
      preview.hidden = false;
      apply.hidden = false;
      status.textContent = 'Rewrite ready. Apply it to your draft, then Send when ready.';
      status.hidden = false;
    } catch (reason) {
      if (alive && !controller.signal.aborted) {
        showError(reason);
      }
    } finally {
      rewriting = false;

      if (alive) {
        update(options);
      }
    }
  };
  apply.onclick = () => {
    if (input.value !== original) {
      showError(
        new Error(
          'Your draft changed while rewriting. ' +
            'Copy any useful text from the preview or rewrite the current draft.',
        ),
      );
      return;
    }

    if (!previewText) {
      return;
    }

    input.value = previewText;
    key = '';
    previewText = '';
    hideRewrite();
    status.textContent = 'Rewrite applied to the draft. Nothing has been sent.';
    status.hidden = false;
    input.focus();
  };

  const submit = async (event: Event, kind: 'queue' | 'steer' = 'queue') => {
    event.preventDefault();

    if (busy || rewriting || options.disabled || !input.value.trim()) {
      return;
    }

    const generation = taskGeneration;
    const instruction = input.value.trim();
    const requestKey = kind + ':' + instruction;

    if (key !== requestKey) {
      key = requestKey;
      id = crypto.randomUUID();
    }

    busy = true;
    status.hidden = true;
    update(options);

    try {
      let action = options.send;

      if (kind === 'steer') {
        if (!options.steer) {
          throw new Error('Steering is unavailable.');
        }

        action = options.steer;
      }

      await action({ id, instruction, autoStart: true });

      if (alive && generation === taskGeneration) {
        input.value = '';
        key = '';
        hideRewrite();
        status.textContent = 'Follow-up saved in this task.';

        if (kind === 'steer') {
          status.textContent = 'Steering instruction saved. Continuing from completed work.';
        }

        status.hidden = false;
      }
    } catch (reason) {
      if (alive && generation === taskGeneration) {
        showError(reason);
      }
    } finally {
      busy = false;

      if (alive) {
        update(options);
      }
    }
  };
  const steerClick = (event: Event) => void submit(event, 'steer');
  steer.addEventListener('click', steerClick);
  const keydown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
  const changed = () => {
    status.hidden = true;
  };
  form.addEventListener('submit', submit);
  input.addEventListener('keydown', keydown);
  input.addEventListener('input', changed);
  update(options);

  return {
    update,
    focus(text?: string) {
      if (text) {
        input.value = text;
      }

      input.focus();
    },
    dispose() {
      alive = false;
      abort?.abort();
      fields.provider.removeEventListener('change', help);
      selects.dispose();
      form.removeEventListener('submit', submit);
      steer.removeEventListener('click', steerClick);
      input.removeEventListener('keydown', keydown);
      input.removeEventListener('input', changed);
      rewriteToggle.onclick = null;
      cancel.onclick = null;
      generate.onclick = null;
      apply.onclick = null;
      root.replaceChildren();
    },
  };
}
