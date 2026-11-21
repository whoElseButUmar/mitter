import { parseRewriteRequest, structureLocally, type RewriteRequest } from '../../protocol/src/rewrite.js';
import { createRewritePanel } from './forms/rewrite-panel.js';
import { rewriteTextSchema } from '../../protocol/src/schemas/rewrite.js';
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
  const controls = createRewritePanel(document, 'Rewrite new task', 'Cancel rewrite');
  const { toggle, panel, preview, cancel, generate, apply } = controls;
  const status = document.createElement('p');
  status.className = 'followup-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  root.append(toggle, panel, status);
  const selects = enhanceSelects(controls.fields);

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
        mode: controls.mode.value,
        provider: controls.provider.value,
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

      const draft = rewriteTextSchema.safeParse(rewritten);
      if (!draft.success) {
        throw new Error('The rewrite did not return a valid draft.');
      }

      result = draft.data;
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
      controls.dispose();
      toggle.onclick = null;
      cancel.onclick = null;
      generate.onclick = null;
      apply.onclick = null;
      selects.dispose();
      root.replaceChildren();
    },
  };
}
