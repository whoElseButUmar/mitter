import {
  parseRewriteRequest,
  structureLocally,
  type RewriteProvider,
  type RewriteRequest,
} from '../../protocol/src/rewrite.js';
import { rewriteTextSchema } from '../../protocol/src/schemas/rewrite.js';
import { createRewritePanel } from './forms/rewrite-panel.js';
import { enhanceSelects } from './select.js';

export type DraftRewriteOptions = {
  rewrite?: ((request: RewriteRequest, signal: AbortSignal) => Promise<string>) | undefined;
  openChanged?(open: boolean): void;
  hideEmptyTrigger?: boolean;
};

/** Reviews a draft before applying it. The parent form owns submission. */
export function mountDraftRewrite(
  root: HTMLElement,
  input: HTMLTextAreaElement,
  options: DraftRewriteOptions,
  actions = root,
) {
  const {
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
  } = createRewritePanel(root.ownerDocument);
  let disabled = false;
  let request: AbortController | undefined;
  let source = '';
  let result = '';

  actions.append(toggle);
  root.append(panel);
  const selects = enhanceSelects(settings);
  let primaryProvider: RewriteProvider = 'chatgpt';
  if (!options.rewrite) {
    primaryProvider = 'local';
    generate.textContent = local.textContent;
    privacy.hidden = true;
    local.hidden = true;
  }

  function render(): void {
    const empty = !input.value.trim();
    toggle.hidden = !panel.hidden || (!!options.hideEmptyTrigger && empty);
    toggle.disabled = disabled || empty;
    settings.hidden = Boolean(request || result);
    output.hidden = !result;
    apply.hidden = !result;
    apply.disabled = disabled || input.value !== source;
    cancel.textContent = 'Cancel';
    if (result) {
      cancel.textContent = 'Keep original';
    }
    generate.hidden = Boolean(request || result);
    generate.disabled = local.disabled = disabled || !input.value.trim();
  }

  function close(): void {
    const open = !panel.hidden;
    const previous = request;
    request = undefined;
    previous?.abort();
    panel.hidden = true;
    details.open = false;
    toggle.setAttribute('aria-expanded', 'false');
    preview.value = '';
    status.textContent = '';
    source = result = '';
    render();
    if (open) {
      options.openChanged?.(false);
    }
  }

  async function rewrite(provider: RewriteProvider): Promise<void> {
    if (disabled || panel.hidden || request || !input.value.trim()) {
      return;
    }

    source = input.value;
    const current = new AbortController();
    request = current;
    status.textContent = '';
    if (provider === 'chatgpt') {
      status.textContent = 'Waiting for ChatGPT…';
    }
    render();
    cancel.focus();

    try {
      const draftRequest = parseRewriteRequest({ instruction: source, mode: mode.value, provider });
      let text: string | undefined;
      if (provider === 'local') {
        text = structureLocally(draftRequest);
      } else {
        text = await options.rewrite?.(draftRequest, current.signal);
      }

      if (request !== current) {
        return;
      }

      const draft = rewriteTextSchema.safeParse(text);
      if (!draft.success) {
        throw new Error('ChatGPT did not return a valid rewrite. Try again.');
      }
      result = draft.data;
      preview.value = result;
      reviewStatus();
    } catch (reason) {
      if (request === current) {
        status.textContent = String(reason);
        if (reason instanceof Error) {
          status.textContent = reason.message;
        }
      }
    } finally {
      if (request === current) {
        request = undefined;
        render();
      }
    }
  }

  toggle.onclick = () => {
    if (disabled || !panel.hidden || !input.value.trim()) {
      return;
    }
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    render();
    options.openChanged?.(true);
    generate.focus();
  };
  cancel.onclick = () => {
    close();
    if (toggle.disabled) {
      input.focus();
    } else {
      toggle.focus();
    }
  };
  generate.onclick = () => rewrite(primaryProvider);
  local.onclick = () => rewrite('local');
  apply.onclick = () => {
    if (disabled || !result || input.value !== source) {
      return;
    }
    input.value = result;
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  function reviewStatus(): void {
    if (result) {
      status.textContent = 'Rewrite ready to review.';
      if (input.value !== source) {
        status.textContent = 'Draft changed. Copy from the preview or close it and rewrite again.';
      }
    }
  }
  const changed = () => {
    reviewStatus();
    render();
  };
  input.addEventListener('input', changed);
  render();

  return {
    trigger: toggle,
    get open() {
      return !panel.hidden;
    },
    close,
    setDisabled(value: boolean) {
      disabled = value;
      render();
    },
    dispose() {
      const previous = request;
      request = undefined;
      previous?.abort();
      input.removeEventListener('input', changed);
      toggle.onclick = cancel.onclick = generate.onclick = local.onclick = apply.onclick = null;
      selects.dispose();
      toggle.remove();
      panel.remove();
    },
  };
}
