import { addDisclosureMarkers } from '../../ui/src/icons.js';
import { requiredElement } from './sheets/required-element.js';
import { replyPreviewSchema, type ReplyPreview } from './reply-recovery.js';
import { replySheetTemplate } from './sheets/reply-template.js';

export type ReplySheetDependencies = {
  workerId: string;
  preview(params: { workerId: string; source: 'chat' | 'clipboard'; text?: string }): Promise<unknown>;
  apply(params: { workerId: string; ticket: string; confirm: true }): Promise<unknown>;
  readClipboard(): Promise<string>;
  close(): void;
  applied(): void;
};

/** Actual production recovery UI. All reply content uses textContent. */
export function mountReplySheet(root: HTMLElement, deps: ReplySheetDependencies): () => void {
  root.innerHTML = replySheetTemplate;
  addDisclosureMarkers(root);

  const status = requiredElement(root, '.reply-status', HTMLDivElement);
  const previewPanel = requiredElement(root, '.reply-preview', HTMLElement);
  const summary = requiredElement(root, '.reply-summary', HTMLParagraphElement);
  const taskName = requiredElement(root, '.reply-task', HTMLParagraphElement);
  const actionList = requiredElement(root, '.reply-actions', HTMLUListElement);
  const pastedReply = requiredElement(root, 'textarea', HTMLTextAreaElement);
  const applyButton = requiredElement(root, '[data-reply="apply"]', HTMLButtonElement);
  const clipboardButton = requiredElement(root, '[data-reply="clipboard"]', HTMLButtonElement);
  const cancelButton = requiredElement(root, '[data-reply="cancel"]', HTMLButtonElement);
  const validateButton = requiredElement(root, '[data-reply="validate"]', HTMLButtonElement);

  let selectedPreview: ReplyPreview | undefined;
  let busy = false;
  let disposed = false;
  let previewSequence = 0;

  function setStatus(message: string, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
  }

  function setBusy(value: boolean) {
    busy = value;
    applyButton.disabled = value || !selectedPreview;
    clipboardButton.disabled = value;
    validateButton.disabled = value;
    cancelButton.disabled = value && !!selectedPreview;
  }

  function renderPreview(preview: ReplyPreview) {
    selectedPreview = preview;
    taskName.textContent = preview.taskName;
    summary.textContent = preview.summary;
    actionList.replaceChildren(
      ...preview.actions.map((label) => {
        const item = document.createElement('li');
        item.textContent = label;
        return item;
      }),
    );
    previewPanel.hidden = false;

    if (preview.source === 'chat') {
      setStatus('Read directly from the linked chat. Review, then continue.');
    } else {
      setStatus('Read from your clipboard or pasted text. Review, then continue.');
    }
  }

  async function readPreview(source: 'chat' | 'clipboard', text?: string) {
    const requestSequence = ++previewSequence;
    selectedPreview = undefined;
    previewPanel.hidden = true;
    setBusy(true);
    if (source === 'chat') {
      setStatus('Reading the code reply…');
    } else {
      setStatus('Validating the copied reply…');
    }

    try {
      if (source === 'clipboard' && text === undefined) {
        text = await deps.readClipboard();
      }

      const params: Parameters<ReplySheetDependencies['preview']>[0] = {
        workerId: deps.workerId,
        source,
      };
      if (text !== undefined) {
        params.text = text;
      }

      const response = await deps.preview(params);
      if (disposed || requestSequence !== previewSequence) {
        return;
      }
      const parsed = replyPreviewSchema.safeParse(response);
      if (!parsed.success) {
        throw new Error('The reply preview is invalid. Select the reply again; nothing was applied.', {
          cause: parsed.error,
        });
      }
      const preview = parsed.data;
      if (preview.workerId !== deps.workerId) {
        throw new Error('This reply preview belongs to a different task. Nothing was applied.');
      }
      if (preview.source !== source) {
        throw new Error(
          'This reply preview came from a different source. Select the reply again; nothing was applied.',
        );
      }
      renderPreview(preview);
    } catch (error) {
      if (!disposed && requestSequence === previewSequence) {
        if (error instanceof Error) {
          setStatus(error.message, true);
        } else {
          setStatus(String(error), true);
        }
      }
    } finally {
      if (!disposed && requestSequence === previewSequence) {
        setBusy(false);
      }
    }
  }

  function applySelectedReply() {
    if (busy || !selectedPreview) {
      return;
    }

    if (Date.now() > selectedPreview.expiresAt) {
      selectedPreview = undefined;
      setBusy(false);
      setStatus('The preview expired. Use copied reply to select it again.', true);
      return;
    }

    const ticket = selectedPreview.ticket;
    setBusy(true);
    setStatus('Applying the selected reply…');

    void deps
      .apply({ workerId: deps.workerId, ticket, confirm: true })
      .then(() => {
        if (!disposed) {
          deps.applied();
        }
      })
      .catch((error) => {
        if (disposed) {
          return;
        }

        selectedPreview = undefined;
        previewPanel.hidden = true;
        if (error instanceof Error) {
          setStatus(error.message, true);
        } else {
          setStatus(String(error), true);
        }
        setBusy(false);
      });
  }

  clipboardButton.onclick = () => {
    if (!busy) {
      void readPreview('clipboard');
    }
  };
  validateButton.onclick = () => {
    if (!busy) {
      void readPreview('clipboard', pastedReply.value);
    }
  };
  cancelButton.onclick = () => {
    if (!cancelButton.disabled) {
      deps.close();
    }
  };
  applyButton.onclick = applySelectedReply;

  void readPreview('chat');

  return function disposeReplySheet() {
    disposed = true;
    previewSequence++;
    root.replaceChildren();
  };
}
