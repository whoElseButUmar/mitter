import { requireElement } from './ui/dom';
import { onMount, onCleanup, Show, type JSX } from 'solid-js';
import { Icon } from './icons';
import { closeActivePopover, uiId } from '../../../packages/ui/src/popover';

export function Modal(props: {
  title: string;
  children: JSX.Element;
  close: () => void;
  wide?: boolean;
  closeDisabled?: boolean;
}) {
  const titleId = uiId('dialog-title');

  let dialog: HTMLDialogElement | undefined;
  let opener: HTMLElement | null = null;
  onMount(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      opener = activeElement;
    }
    closeActivePopover(document, 'superseded');
    requireElement(dialog, 'components dialog').showModal();
  });

  onCleanup(() => {
    if (!dialog) {
      return;
    }

    closeActivePopover(document, 'dispose');
    dialog.close();
    if (opener?.isConnected && !document.querySelector('dialog[open]')) {
      opener.focus({
        preventScroll: true,
      });
    }
  });

  return (
    <dialog
      aria-labelledby={titleId}
      ref={(element) => {
        dialog = element;
      }}
      classList={{
        wide: props.wide ?? false,
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!props.closeDisabled) {
          props.close();
        }
      }}
    >
      <div class="modal-head">
        <h2 id={titleId}>{props.title}</h2>
        <button
          type="button"
          class="icon-button"
          title="Close dialog"
          aria-label="Close dialog"
          disabled={props.closeDisabled}
          onClick={props.close}
        >
          <Icon name="close" />
        </button>
      </div>
      <div class="modal-body">{props.children}</div>
    </dialog>
  );
}

export function Field(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      {props.children}
      <Show when={props.hint}>{(hint) => <small>{hint()}</small>}</Show>
    </label>
  );
}

export function Empty(props: { title: string; text: string; children?: JSX.Element }) {
  return (
    <div class="empty">
      <h2>{props.title}</h2>
      <p>{props.text}</p>
      {props.children}
    </div>
  );
}

export function Status(props: { value: string }) {
  return <span class={`status status-${props.value}`}>{props.value.replaceAll('_', ' ')}</span>;
}
