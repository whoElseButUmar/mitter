import type { RewriteRequest } from '../../protocol/src/rewrite.js';
import type { FollowupRequest } from '../../protocol/src/requests.js';
import { mountDraftRewrite } from './draft-rewrite.js';
import { mountImageAttachments } from './image-attachments.js';

type ComposerRequest = Pick<FollowupRequest, 'id' | 'instruction' | 'autoStart' | 'imageAttachments'>;

export type FollowupComposerOptions = {
  workerId: string;
  running: boolean;
  disabled?: boolean;
  canAttachImages?: boolean;
  send(request: ComposerRequest, beforeSave?: () => Promise<void>): Promise<unknown>;
  steer?(request: ComposerRequest): Promise<unknown>;
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
  const attachmentRoot = document.createElement('div');
  attachmentRoot.className = 'image-attachments';
  footer.append(hint);
  form.append(label, attachmentRoot, rewriteRoot, footer, status);
  root.append(form);
  const attachments = mountImageAttachments(attachmentRoot, input, render, footer);
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
    const imagesAllowed = options.canAttachImages !== false;
    const submissionDisabled =
      blocked ||
      rewrite.open ||
      !input.value.trim() ||
      attachments.busy ||
      (!imagesAllowed && attachments.hasImages);
    input.disabled = blocked;
    footer.hidden = rewrite.open;
    send.disabled = submissionDisabled;
    steer.hidden = !options.running || !options.steer;
    steer.disabled = submissionDisabled;
    rewrite.setDisabled(blocked);
    attachments.setAvailability(imagesAllowed, blocked);

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
    attachments.setScope('followup:' + next.workerId);
    render();
  }

  const submit = async (event: Event, kind: 'queue' | 'steer' = 'queue') => {
    event.preventDefault();

    if (
      busy ||
      rewrite.open ||
      options.disabled ||
      !input.value.trim() ||
      attachments.busy ||
      (options.canAttachImages === false && attachments.hasImages)
    ) {
      return;
    }

    const generation = taskGeneration;
    const instruction = input.value.trim();
    const submission = attachments.submission();
    const requestKey = JSON.stringify([kind, instruction, submission?.images.map(({ id }) => id)]);

    if (key !== requestKey) {
      key = requestKey;
      id = crypto.randomUUID();
      if (submission?.previousAttempt?.key === requestKey) {
        id = submission.previousAttempt.id;
      }
    }
    const request: ComposerRequest = {
      id,
      instruction,
      autoStart: true,
      ...(submission && { imageAttachments: submission.images }),
    };

    busy = true;
    status.hidden = true;
    render();

    try {
      const reserveImages = async () => {
        await submission?.reserve({ id: request.id, key: requestKey });
        if (!alive || generation !== taskGeneration) {
          throw new Error('This follow-up composer is closed. Reopen it before sending.');
        }
      };
      if (kind === 'steer') {
        if (!options.steer) {
          throw new Error('Steering is unavailable.');
        }
        if (submission) {
          await reserveImages();
        }
        await options.steer(request);
      } else if (submission) {
        // send() acquires ChatGPT access in the original click before awaiting
        // reservation. The native follow-up is only saved once the bytes are pinned.
        await options.send(request, reserveImages);
      } else {
        await options.send(request);
      }
      if (submission) {
        await submission.confirm();
      }

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
  update(options);

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
      attachments.dispose();
      rewrite.dispose();
      form.removeEventListener('submit', submit);
      steer.removeEventListener('click', steerClick);
      input.removeEventListener('keydown', keydown);
      input.removeEventListener('input', changed);
      root.replaceChildren();
    },
  };
}
