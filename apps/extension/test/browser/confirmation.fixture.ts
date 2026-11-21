import { showConfirmation } from '../../src/ui/confirmation';
import { errorMessage } from '../../src/schemas/primitives';

/** Exercises the production native dialog; no shell or host is attached. */
export function createConfirmationFixture() {
  let opener: HTMLButtonElement | undefined;
  let lifetime: AbortController | undefined;
  let current = true;
  let pending = false;
  let result: boolean | null = null;
  let failure = '';

  const options = (long: boolean) => {
    if (!lifetime) {
      throw new Error('Open the confirmation fixture before requesting its options.');
    }
    let message =
      'Paste multiple lines or control characters into the real shell? This may execute commands.';
    if (long) {
      message += '\n' + 'A long terminal link or warning must remain readable.\n'.repeat(120);
    }
    return {
      title: 'Paste into shell',
      message,
      confirmLabel: 'Paste into shell',
      signal: lifetime.signal,
      isCurrent: () => current,
    };
  };

  function open(long = false) {
    if (pending) {
      throw new Error('Finish the pending confirmation before opening another fixture.');
    }
    lifetime?.abort();
    lifetime = new AbortController();
    current = true;
    pending = true;
    result = null;
    failure = '';
    if (!opener) {
      opener = document.createElement('button');
      opener.type = 'button';
      opener.textContent = 'Open confirmation fixture';
      opener.dataset.confirmationOpener = '';
    }
    document.body.append(opener);
    opener.focus();
    void showConfirmation(options(long)).then(
      (accepted) => {
        result = accepted;
        pending = false;
      },
      (error) => {
        failure = errorMessage(error);
        pending = false;
      },
    );
  }

  function failOpen() {
    const original = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = () => {
      throw new Error('Controlled native dialog failure.');
    };
    try {
      open();
    } finally {
      HTMLDialogElement.prototype.showModal = original;
    }
  }

  function inspect() {
    const dialog = document.querySelector('[data-miter-confirmation]');
    const body = dialog?.querySelector('.modal-body');
    const footer = dialog?.querySelector('.confirmation-actions');
    const bounds = dialog?.getBoundingClientRect();
    const footerBounds = footer?.getBoundingClientRect();
    return {
      count: document.querySelectorAll('[data-miter-confirmation]').length,
      modal: dialog?.matches(':modal') ?? false,
      title: dialog?.querySelector('h2')?.textContent ?? '',
      message: dialog?.querySelector('p')?.textContent ?? '',
      focused: document.activeElement?.textContent ?? '',
      openerFocused: document.activeElement === opener,
      pending,
      result,
      failure,
      fitsViewport:
        !!bounds &&
        bounds.left >= 0 &&
        bounds.right <= innerWidth &&
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight,
      footerVisible: !!footerBounds && footerBounds.top >= 0 && footerBounds.bottom <= innerHeight,
      bodyScrolls:
        !!body && body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY === 'auto',
      labelled: !!dialog && dialog.getAttribute('aria-labelledby') === dialog.querySelector('h2')?.id,
      described: !!dialog && dialog.getAttribute('aria-describedby') === dialog.querySelector('p')?.id,
    };
  }

  return {
    open,
    failOpen,
    inspect,
    duplicate: () => showConfirmation(options(false)),
    invalidate: () => {
      current = false;
    },
    abort: () => lifetime?.abort(),
    dispose: () => {
      current = false;
      lifetime?.abort();
      opener?.remove();
      opener = undefined;
    },
  };
}
