import { isElement, isHTMLElement, isNode, requireWindow } from '../dom/elements.js';
import { ToastCenter } from './toast-center.js';
import { createIcon } from '../icons.js';

type ToastCard = {
  node: HTMLElement;
  badge: HTMLElement;
  message: HTMLElement;
  action: HTMLButtonElement;
  returnTo: Element | null;
};

/** Move controls into an open dialog's focus boundary without closing it or focusing the app behind it. */
export function mountToasts(document: Document, center: ToastCenter): () => void {
  const window = requireWindow(document);
  const root = document.createElement('section');
  root.className = 'miter-toasts';
  root.setAttribute('aria-label', 'Notifications');
  root.dataset.miterUi = 'toasts';
  const hovered = new Set<string>();
  const cards = new Map<string, ToastCard>();

  function hover(id: string, on: boolean): void {
    if (on) {
      hovered.add(id);
    } else {
      hovered.delete(id);
    }

    center.pause(id, 'hover', on);
  }

  // Top-layer moves and entry animations can suppress boundary leave events.
  // Reconcile only hovered cards on movement; there is no polling timer.
  const pointer = (event: PointerEvent) => {
    for (const id of hovered) {
      const card = cards.get(id);

      if (!card || !isNode(document, event.target) || !card.node.contains(event.target)) {
        hover(id, false);
      }
    }
  };
  const clearHover = () => {
    for (const id of [...hovered]) {
      hover(id, false);
    }
  };
  document.addEventListener('pointermove', pointer, {
    capture: true,
    passive: true,
  });
  document.addEventListener('pointercancel', clearHover, true);
  window.addEventListener('blur', clearHover);

  const relocate = () => {
    const dialogs = Array.from(document.querySelectorAll('dialog[open]'));
    const host = dialogs.at(-1) || document.body;

    if (root.parentElement !== host) {
      host.append(root);
    }
  };
  relocate();
  const observer = new window.MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          (record.type === 'attributes' && record.target instanceof window.HTMLDialogElement) ||
          (record.type === 'childList' &&
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                isElement(document, node) && (node.matches('dialog') || !!node.querySelector('dialog')),
            )),
      )
    ) {
      relocate();
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open'],
  });
  const unsubscribe = center.subscribe((items) => {
    const ids = new Set(items.map((entry) => entry.id));

    for (const [id, card] of cards) {
      if (!ids.has(id)) {
        const hadFocus = card.node.contains(document.activeElement);
        card.node.remove();
        cards.delete(id);
        hovered.delete(id);

        if (hadFocus && isHTMLElement(document, card.returnTo) && card.returnTo.isConnected) {
          card.returnTo.focus({ preventScroll: true });
        }
      }
    }

    for (const entry of items) {
      let card = cards.get(entry.id);

      if (!card) {
        const node = document.createElement('article');
        node.className = 'miter-toast';
        node.dataset.toastId = entry.id;
        const badge = document.createElement('span');
        badge.className = 'miter-toast-icon';
        node.append(badge);
        const text = document.createElement('div');
        text.className = 'miter-toast-content';
        const message = document.createElement('p');
        message.setAttribute('role', 'status');
        message.setAttribute('aria-live', 'polite');
        message.setAttribute('aria-atomic', 'true');
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'miter-toast-action';
        action.onclick = () => void center.invoke(entry.id);
        text.append(message, action);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'miter-toast-close';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.title = 'Dismiss notification';
        close.append(createIcon(document, 'close'));
        close.onclick = () => center.dismiss(entry.id);
        node.append(text, close);
        node.onpointerenter = () => hover(entry.id, true);
        node.onpointerleave = () => hover(entry.id, false);
        node.addEventListener('focusin', () => center.pause(entry.id, 'focus', true));
        node.addEventListener('focusout', (event) => {
          if (!isNode(document, event.relatedTarget) || !node.contains(event.relatedTarget)) {
            center.pause(entry.id, 'focus', false);
          }
        });
        node.onkeydown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            center.dismiss(entry.id);
          }
        };
        card = {
          node,
          badge,
          message,
          action,
          returnTo: document.activeElement,
        };
        cards.set(entry.id, card);
        root.append(node);
      }

      if (card.node.dataset.kind !== entry.kind) {
        card.node.dataset.kind = entry.kind;
        card.badge.replaceChildren(createIcon(document, entry.kind));
      }

      if (card.message.textContent !== entry.message) {
        card.message.textContent = entry.message;
      }

      card.action.hidden = !entry.action;
      card.action.textContent = entry.action?.label || '';

      if (entry.busy) {
        card.action.textContent = 'Working…';
      }

      card.action.disabled = entry.busy;
    }

    root.hidden = !items.length;
  });
  const visibility = () => center.pauseAll('hidden', document.hidden);
  document.addEventListener('visibilitychange', visibility);
  visibility();

  return () => {
    unsubscribe();
    observer.disconnect();
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('pointermove', pointer, true);
    document.removeEventListener('pointercancel', clearHover, true);
    window.removeEventListener('blur', clearHover);
    hovered.clear();
    root.remove();
    cards.clear();
    center.dispose();
  };
}
