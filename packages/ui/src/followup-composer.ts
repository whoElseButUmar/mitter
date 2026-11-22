import type { RewriteRequest } from '../../protocol/src/rewrite.js';
import type { FollowupRequest } from '../../protocol/src/requests.js';
import { mountDraftRewrite } from './draft-rewrite.js';

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
  const rewriteRoot = document.createElement('div');
  footer.append(hint);
  form.append(label, rewriteRoot, footer, status);
  root.append(form);
  const rewrite = mountDraftRewrite(
    rewriteRoot,
    input,
    {
      get rewrite() {
        return options.rewrite;
      },
      openChanged: () => render(),
    },
    footer,
  );
  footer.append(steer, send);

  function render(): void {
    const blocked = !!options.disabled || busy;
    const submissionDisabled = blocked || rewrite.open || !input.value.trim();
    input.disabled = blocked;
    footer.hidden = rewrite.open;
    send.disabled = submissionDisabled;
    steer.hidden = !options.running || !options.steer;
    steer.disabled = submissionDisabled;
    rewrite.setDisabled(blocked);

    send.textContent = 'Send';

    if (busy) {
      send.textContent = 'Sending…';
    } else if (options.running) {
      send.textContent = 'Queue follow-up';
    }

    hint.hidden = !options.running;
    hint.textContent = '';

    if (options.running) {
      hint.textContent = 'Runs after the current work.';

      if (options.steer) {
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

  function update(next: FollowupComposerOptions): void {
    if (next.workerId !== options.workerId) {
      taskGeneration += 1;
      key = '';
      rewrite.close();
    }
    options = next;
    render();
  }

  const submit = async (event: Event, kind: 'queue' | 'steer' = 'queue') => {
    event.preventDefault();

    if (busy || rewrite.open || options.disabled || !input.value.trim()) {
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
    render();

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
        rewrite.close();
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
        render();
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
    render();
  };
  form.addEventListener('submit', submit);
  input.addEventListener('keydown', keydown);
  input.addEventListener('input', changed);
  render();

  return {
    update,
    focus(text?: string) {
      if (text) {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }

      input.focus();
    },
    dispose() {
      alive = false;
      rewrite.dispose();
      form.removeEventListener('submit', submit);
      steer.removeEventListener('click', steerClick);
      input.removeEventListener('keydown', keydown);
      input.removeEventListener('input', changed);
      root.replaceChildren();
    },
  };
}
