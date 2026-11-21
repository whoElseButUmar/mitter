import { parseRewriteRequest, structureLocally, type RewriteRequest } from '../../protocol/src/rewrite.js';
import type { FollowupRequest } from '../../protocol/src/requests.js';
import { createRewritePanel } from './forms/rewrite-panel.js';
import { rewriteTextSchema } from '../../protocol/src/schemas/rewrite.js';
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
  steer.textContent = 'Steer now';
  steer.title = 'Stop the pending plan and use this instruction now. Completed work stays.';
  const controls = createRewritePanel(document, 'Rewrite follow-up', 'Cancel');
  const { toggle: rewriteToggle, panel, preview, cancel, generate, apply } = controls;
  footer.append(hint, rewriteToggle, steer, send);
  form.append(label, panel, footer, status);
  root.append(form);
  const selects = enhanceSelects(controls.fields);

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
    steer.hidden = !next.running || !next.steer;
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

    hint.hidden = !next.running;
    hint.textContent = '';

    if (next.running) {
      hint.textContent = 'Runs after the current work.';

      if (next.steer) {
        hint.textContent = 'Queue waits. Steer changes the current plan.';
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
        mode: controls.mode.value,
        provider: controls.provider.value,
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

      const draft = rewriteTextSchema.safeParse(result);
      if (!draft.success) {
        throw new Error('The rewrite did not return a valid draft.');
      }

      previewText = draft.data;
      preview.value = previewText;
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
      controls.dispose();
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
