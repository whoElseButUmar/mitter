import type { DataResetState } from '../../bridge/src/data-reset.js';
import { requireElement, requireWindow } from './dom/elements.js';
import { resetTemplate } from './forms/templates.js';

export function mountResetForm(
  root: HTMLElement,
  options: { clear(confirmation: string): Promise<unknown>; close(): void },
) {
  const window = requireWindow(root.ownerDocument);
  root.innerHTML = resetTemplate;
  const form = requireElement(root, 'form', window.HTMLFormElement);
  const input = requireElement(root, '[data-confirm]', window.HTMLInputElement);
  const clear = requireElement(root, '[data-clear]', window.HTMLButtonElement);
  const cancel = requireElement(root, '[data-cancel]', window.HTMLButtonElement);
  const progress = requireElement(root, '.reset-progress', window.HTMLElement);
  const error = requireElement(root, '.reset-failure', window.HTMLElement);
  const connection = requireElement(root, '.reset-connection', window.HTMLElement);
  const copy = requireElement(root, '[data-copy]', window.HTMLButtonElement);
  let alive = true;
  let connected = true;
  let requestPending = false;
  let state: DataResetState = { phase: 'idle' };

  function refresh(): void {
    const busy = requestPending || ['stopping', 'clearing'].includes(state.phase);
    form.setAttribute('aria-busy', String(busy));
    clear.disabled = !connected || busy || state.phase === 'complete' || input.value !== 'CLEAR';
    input.disabled = busy || state.phase === 'complete';
    cancel.disabled = busy || state.phase !== 'idle';
    clear.textContent = 'Clear all Miter data';

    if (state.phase === 'complete') {
      clear.textContent = 'Data cleared';
    } else if (state.phase === 'failed') {
      clear.textContent = 'Retry clearing all data';
    } else if (busy) {
      clear.textContent = 'Clearing…';
    }
  }

  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(error.textContent || '');

      if (alive) {
        copy.textContent = 'Details copied';
      }
    } catch {
      if (alive) {
        copy.textContent = 'Select and copy the details above';
      }
    }
  };
  input.oninput = refresh;
  cancel.onclick = () => {
    if (!cancel.disabled) {
      options.close();
    }
  };

  function update(next: DataResetState): void {
    state = next;
    copy.hidden = !next.error;
    copy.textContent = 'Copy error details';
    error.hidden = !next.error;
    error.textContent = next.error || '';
    progress.hidden = next.phase === 'idle';
    progress.textContent =
      'Stopping workers, terminals, and open views… ' +
      'No native records are deleted until all writers confirm.';

    if (next.phase === 'complete') {
      progress.textContent = 'Miter data cleared. Restarting into first-run state…';
    } else if (next.phase === 'failed') {
      progress.textContent = 'Reset incomplete. Miter stays locked. Resolve the failures below and retry.';
    } else if (next.phase === 'clearing') {
      progress.textContent = 'Removing and verifying browser-local data…';

      if (next.step === 'native') {
        progress.textContent = 'All writers stopped. Removing and verifying native application data…';
      } else if (next.step === 'commit') {
        progress.textContent = 'Verifying both stores and preparing the first-run restart…';
      }
    }

    refresh();
  }

  form.onsubmit = async (event) => {
    event.preventDefault();

    if (clear.disabled) {
      return;
    }

    requestPending = true;
    error.hidden = true;
    copy.hidden = true;
    refresh();

    try {
      await options.clear(input.value);
    } catch (reason) {
      if (alive) {
        let message = String(reason);

        if (reason instanceof Error) {
          message = reason.message;
        }

        update({ phase: 'failed', error: message });
      }
    } finally {
      requestPending = false;

      if (alive) {
        refresh();
      }
    }
  };

  queueMicrotask(() => {
    if (alive) {
      input.focus();
    }
  });

  return {
    update,
    setConnected(value: boolean) {
      connected = value;
      connection.hidden = value;
      refresh();
    },
    dispose() {
      alive = false;
      form.onsubmit = null;
      input.oninput = null;
      cancel.onclick = null;
      copy.onclick = null;
      root.replaceChildren();
    },
  };
}
