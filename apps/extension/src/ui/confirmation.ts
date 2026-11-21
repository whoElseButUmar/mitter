import { closeActivePopover, uiId } from '../../../../packages/ui/src/popover';

/** A styled confirmation tied to the view or terminal that requested it. */
export function showConfirmation(options: {
  title: string;
  message: string;
  confirmLabel: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}): Promise<boolean> {
  if (options.signal.aborted || !options.isCurrent() || document.querySelector('[data-miter-confirmation]')) {
    return Promise.resolve(false);
  }

  return new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirmation-dialog';
    dialog.dataset.miterConfirmation = '';
    const title = document.createElement('h2');
    title.id = uiId('confirmation');
    title.textContent = options.title;
    dialog.setAttribute('aria-labelledby', title.id);
    const header = document.createElement('div');
    header.className = 'modal-head';
    header.append(title);
    const body = document.createElement('div');
    body.className = 'modal-body';
    const message = document.createElement('p');
    message.id = uiId('confirmation-message');
    message.textContent = options.message;
    dialog.setAttribute('aria-describedby', message.id);
    body.append(message);
    const footer = document.createElement('div');
    footer.className = 'confirmation-actions button-row end';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.autofocus = true;
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary';
    confirm.textContent = options.confirmLabel;
    footer.append(cancel, confirm);
    dialog.append(header, body, footer);
    let settled = false;

    const cleanup = () => {
      settled = true;
      options.signal.removeEventListener('abort', abort);
      dialog.removeEventListener('close', abort);
      cancel.removeEventListener('click', decline);
      confirm.removeEventListener('click', accept);
      dialog.close();
      dialog.remove();
    };
    const finish = (accepted: boolean) => {
      if (settled) {
        return;
      }
      const current = options.isCurrent() && !options.signal.aborted;
      cleanup();
      resolve(accepted && current);
    };
    const abort = () => finish(false);
    const decline = () => finish(false);
    const accept = () => finish(true);
    cancel.addEventListener('click', decline);
    confirm.addEventListener('click', accept);
    dialog.addEventListener('close', abort);
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      closeActivePopover(document, 'superseded');
      if (options.signal.aborted || !options.isCurrent()) {
        finish(false);
        return;
      }
      document.body.append(dialog);
      dialog.showModal();
    } catch (error) {
      if (settled) {
        return;
      }
      cleanup();
      reject(new Error('Could not open the confirmation. No action was approved.', { cause: error }));
    }
  });
}
