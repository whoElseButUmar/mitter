import { createPopover, uiId } from './popover.js';
import { createIcon } from './icons.js';
import type { CodeSelection, FollowupRequest } from '../../protocol/src/requests.js';

export type SelectionEditorOptions = {
  workerId: string;
  path: string;
  content: string;
  hash: string;
  submit(
    request: Pick<FollowupRequest, 'id' | 'instruction'> & {
      selection: CodeSelection;
    },
  ): Promise<unknown>;
  submitted?(): void;
};

/** Capture once before focusing the prompt. Never replace the target with a later
 * live selection or changed source preview. */
export function captureCodeSelection(
  root: HTMLElement,
  options: Pick<SelectionEditorOptions, 'path' | 'content' | 'hash'>,
): CodeSelection | undefined {
  const selection = root.ownerDocument.getSelection();

  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return undefined;
  }

  const range = selection.getRangeAt(0);

  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return undefined;
  }

  const prefix = range.cloneRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  const text = range.toString();
  const end = start + text.length;

  if (!text.length || text.length > 16000 || options.content.slice(start, end) !== text) {
    return undefined;
  }

  return { path: options.path, hash: options.hash, start, end, text };
}

export function mountSelectionEditor(root: HTMLElement, options: SelectionEditorOptions) {
  const document = root.ownerDocument;
  let captured: CodeSelection | undefined;
  let alive = true;
  let busy = false;
  let anchor: { x: number; y: number } | undefined;
  let requestKey = '';
  let requestId = '';
  let savedInstruction = '';
  const panel = document.createElement('form');
  panel.className = 'selection-editor';
  panel.tabIndex = -1;
  panel.setAttribute('aria-label', 'Change selected code');
  const title = document.createElement('strong');
  title.textContent = 'Change selected code';
  const header = document.createElement('header');
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'icon-button';
  dismiss.append(createIcon(document, 'close'));
  dismiss.setAttribute('aria-label', 'Close selection prompt');
  header.append(title, dismiss);
  const metadata = document.createElement('div');
  metadata.className = 'selection-location';
  const label = document.createElement('label');
  label.className = 'field';
  label.textContent = 'What would you like changed here?';
  const input = document.createElement('textarea');
  input.rows = 3;
  input.maxLength = 4000;
  input.required = true;
  input.placeholder = 'Describe the change…';
  input.id = uiId('selection-instruction');
  label.htmlFor = input.id;
  label.append(input);
  const status = document.createElement('p');
  status.className = 'selection-error';
  status.setAttribute('role', 'status');
  status.hidden = true;
  const hint = document.createElement('small');
  hint.textContent = 'Same task and chat · file checked before editing';
  const send = document.createElement('button');
  send.className = 'primary';
  send.type = 'submit';
  send.textContent = 'Send';
  const footer = document.createElement('footer');
  footer.append(hint, send);
  panel.append(header, metadata, label, status, footer);
  const popup = createPopover(root, panel, {
    role: 'dialog',
    decorateTrigger: false,
    minWidth: 300,
    maxHeight: 300,
    anchor: () => {
      const rectangle = root.getBoundingClientRect();
      const x = anchor?.x ?? rectangle.left + 16;
      const y = anchor?.y ?? rectangle.top + 16;
      return { left: x, right: x, top: y, bottom: y, width: 0 };
    },
    onOpen: () => {
      input.value = savedInstruction;
      input.focus({ preventScroll: true });
    },
    onClose: () => {
      savedInstruction = input.value;
    },
  });

  function open(point?: { x: number; y: number }, selection = captureCodeSelection(root, options)): boolean {
    if (!alive || busy || !selection) {
      return false;
    }

    const changed = !captured || captured.start !== selection.start || captured.end !== selection.end;
    popup.close('superseded');

    if (changed) {
      requestKey = '';
      requestId = '';
      savedInstruction = '';
    }

    captured = Object.freeze({ ...selection });
    anchor = point;
    const first = options.content.slice(0, selection.start).split('\n').length;
    const last = options.content.slice(0, selection.end).split('\n').length;
    let location = 'lines ' + first + '–' + last;

    if (first === last) {
      location = 'line ' + first;
    }

    metadata.textContent = options.path + ' · ' + location;
    status.hidden = true;
    popup.open();
    return true;
  }

  const pointer = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }

    queueMicrotask(() => {
      if (alive && !popup.isOpen()) {
        open({ x: event.clientX + 8, y: event.clientY + 8 });
      }
    });
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      return;
    }

    if (event.altKey && event.key === 'Enter') {
      event.preventDefault();
      open();
    }
  };
  const submit = async (event: Event) => {
    event.preventDefault();

    if (busy || !captured || !input.value.trim()) {
      return;
    }

    const instruction = input.value.trim();
    const selection = { ...captured };
    const fingerprint = JSON.stringify({ instruction, selection });

    if (requestKey !== fingerprint) {
      requestKey = fingerprint;
      requestId = crypto.randomUUID();
    }

    busy = true;
    send.disabled = true;
    input.readOnly = true;
    send.textContent = 'Sending…';
    status.hidden = true;

    try {
      await options.submit({ id: requestId, instruction, selection });

      if (!alive) {
        return;
      }

      savedInstruction = '';
      input.value = '';
      popup.close('selection');
      options.submitted?.();
    } catch (reason) {
      if (alive) {
        status.textContent = String(reason);

        if (reason instanceof Error) {
          status.textContent = reason.message;
        }

        status.hidden = false;
        popup.position();
      }
    } finally {
      busy = false;

      if (alive) {
        send.disabled = false;
        input.readOnly = false;
        send.textContent = 'Send';
      }
    }
  };
  const inputKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      panel.requestSubmit();
    }
  };
  root.addEventListener('pointerup', pointer);
  root.addEventListener('keydown', key);
  panel.addEventListener('submit', submit);
  input.addEventListener('keydown', inputKey);
  dismiss.onclick = () => popup.close('toggle');

  return {
    open,
    selection: () => captureCodeSelection(root, options),
    dispose() {
      alive = false;
      root.removeEventListener('pointerup', pointer);
      root.removeEventListener('keydown', key);
      panel.removeEventListener('submit', submit);
      input.removeEventListener('keydown', inputKey);
      dismiss.onclick = null;
      popup.dispose();
    },
  };
}
