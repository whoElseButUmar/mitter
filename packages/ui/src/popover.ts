/** Shared popup lifetime. Dismissal never steals focus from a control clicked outside the popup. */
import { isNode, requireWindow } from './dom/elements.js';
import { positionPopup, type PopupAnchor } from './native/position.js';

export type CloseReason =
  'escape' | 'selection' | 'toggle' | 'outside' | 'blur' | 'superseded' | 'disabled' | 'dispose' | 'tab';

export type PopoverOptions = {
  role?: 'menu' | 'listbox' | 'dialog';
  align?: 'start' | 'end';
  matchWidth?: boolean;
  minWidth?: number;
  maxHeight?: number;
  anchor?: () => PopupAnchor;
  decorateTrigger?: boolean;
  onOpen?: () => void;
  onClose?: (reason: CloseReason) => void;
};

export type PopoverHandle = {
  open(): void;
  close(reason?: CloseReason): void;
  toggle(): void;
  isOpen(): boolean;
  position(): void;
  dispose(): void;
};

let sequence = 0;
const activeByDocument = new WeakMap<Document, PopoverHandle>();

export function uiId(prefix: string): string {
  sequence += 1;
  return `mitter-${prefix}-${sequence}`;
}

export function closeActivePopover(document: Document, reason: CloseReason = 'outside'): void {
  activeByDocument.get(document)?.close(reason);
}

export function createPopover(
  trigger: HTMLElement,
  panel: HTMLElement,
  options: PopoverOptions = {},
): PopoverHandle {
  const document = trigger.ownerDocument;
  const window = requireWindow(document);
  let opened = false;
  let disposed = false;
  let frame = 0;
  panel.id ||= uiId('popup');
  panel.classList.add('mitter-popup');
  panel.setAttribute('role', options.role || 'menu');
  panel.setAttribute('popover', 'manual');
  panel.hidden = true;
  const previous = ['aria-haspopup', 'aria-expanded', 'aria-controls'].map((name) => ({
    name,
    value: trigger.getAttribute(name),
  }));

  if (options.decorateTrigger !== false) {
    trigger.setAttribute('aria-haspopup', options.role || 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', panel.id);
  }

  // In a modal, this also keeps the popup inside the dialog's focus boundary.
  (trigger.closest('dialog') || document.body).append(panel);

  const contains = (target: EventTarget | null) =>
    isNode(document, target) && (trigger.contains(target) || panel.contains(target));
  const anchorAvailable = () =>
    trigger.isConnected &&
    trigger.getClientRects().length > 0 &&
    !trigger.closest('[hidden]') &&
    !trigger.hasAttribute('disabled') &&
    trigger.getAttribute('aria-disabled') !== 'true';

  function position(): void {
    if (!opened) {
      return;
    }

    if (!anchorAvailable()) {
      close('disabled');
      return;
    }

    positionPopup(window, panel, options.anchor?.() || trigger.getBoundingClientRect(), options);
  }

  const schedulePosition = () => {
    if (opened && !frame) {
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        position();
      });
    }
  };

  function open(): void {
    if (disposed || opened || !anchorAvailable()) {
      return;
    }

    activeByDocument.get(document)?.close('superseded');
    opened = true;
    activeByDocument.set(document, handle);
    panel.hidden = false;
    trigger.dataset.open = 'true';

    if (options.decorateTrigger !== false) {
      trigger.setAttribute('aria-expanded', 'true');
    }

    if (typeof panel.showPopover === 'function') {
      try {
        panel.showPopover();
      } catch {
        panel.removeAttribute('popover');
      }
    } else {
      panel.removeAttribute('popover');
    }

    position();
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('toggle', schedulePosition, true);
    window.addEventListener('resize', schedulePosition);
    window.addEventListener('blur', onWindowBlur);
    window.visualViewport?.addEventListener('resize', schedulePosition);
    window.visualViewport?.addEventListener('scroll', schedulePosition);
    options.onOpen?.();
  }

  function close(reason: CloseReason = 'outside'): void {
    if (!opened) {
      return;
    }

    opened = false;

    if (activeByDocument.get(document) === handle) {
      activeByDocument.delete(document);
    }

    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }

    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('toggle', schedulePosition, true);
    window.removeEventListener('resize', schedulePosition);
    window.removeEventListener('blur', onWindowBlur);
    window.visualViewport?.removeEventListener('resize', schedulePosition);
    window.visualViewport?.removeEventListener('scroll', schedulePosition);

    if (typeof panel.hidePopover === 'function') {
      try {
        panel.hidePopover();
      } catch {
        // A fallback panel or a previously hidden top-layer panel needs no native dismissal.
      }
    }

    panel.hidden = true;
    delete trigger.dataset.open;

    if (options.decorateTrigger !== false) {
      trigger.setAttribute('aria-expanded', 'false');
    }

    if (
      ['escape', 'selection', 'toggle'].includes(reason) &&
      trigger.isConnected &&
      !trigger.hasAttribute('disabled')
    ) {
      trigger.focus({ preventScroll: true });
    }

    options.onClose?.(reason);
  }

  function onOutside(event: Event): void {
    if (!contains(event.target)) {
      close('outside');
    }
  }

  function onFocus(event: FocusEvent): void {
    if (!contains(event.target)) {
      close('blur');
    }
  }

  function onWindowBlur(): void {
    close('blur');
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close('escape');
    }
  }

  function onScroll(event: Event): void {
    if (!isNode(document, event.target) || !panel.contains(event.target)) {
      schedulePosition();
    }
  }

  // Disabling/unmounting a trigger cannot leave an interactive orphan menu.
  const observer = new window.MutationObserver(schedulePosition);
  observer.observe(trigger, {
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'hidden'],
  });

  const handle: PopoverHandle = {
    open,
    close,
    toggle() {
      if (opened) {
        close('toggle');
      } else {
        open();
      }
    },
    isOpen: () => opened,
    position,
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;

      try {
        close('dispose');
      } finally {
        observer.disconnect();
        panel.remove();

        for (const attribute of previous) {
          if (attribute.value === null) {
            trigger.removeAttribute(attribute.name);
          } else {
            trigger.setAttribute(attribute.name, attribute.value);
          }
        }
      }
    },
  };

  return handle;
}

/** Read-only information panels expose a labelled non-modal dialog rather than a menu. */
export function bindInfoPopover(trigger: HTMLElement, panel: HTMLElement): PopoverHandle {
  const popup = createPopover(trigger, panel, {
    role: 'dialog',
    align: 'end',
    minWidth: 270,
    onOpen: () => panel.focus({ preventScroll: true }),
  });
  const click = () => popup.toggle();
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Tab') {
      popup.close('tab');
      trigger.focus({ preventScroll: true });
    }
  };
  trigger.addEventListener('click', click);
  panel.addEventListener('keydown', key);

  return {
    ...popup,
    dispose() {
      trigger.removeEventListener('click', click);
      panel.removeEventListener('keydown', key);
      popup.dispose();
    },
  };
}
