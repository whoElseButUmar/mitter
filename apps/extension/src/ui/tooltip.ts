import { isNode, requireWindow } from '../../../../packages/ui/src/dom/elements';

const active = new WeakMap<Document, () => void>();

/** Hover/focus hints stay separate from menu ownership and never move focus. */
export function bindTooltip(trigger: HTMLButtonElement, label: () => string) {
  const document = trigger.ownerDocument;
  const window = requireWindow(document);
  const panel = document.createElement('span');
  const text = document.createElement('span');
  let hovering = false;
  let focused = false;
  let dismissed = false;
  let opened = false;
  let disposed = false;

  panel.className = 'button-tooltip';
  panel.setAttribute('role', 'tooltip');
  panel.setAttribute('popover', 'hint');
  panel.hidden = true;
  panel.append(text);
  // Top-layer painting escapes clipping while the DOM keeps its landmark and dialog scope.
  trigger.after(panel);

  function close(): void {
    if (!opened) {
      return;
    }
    opened = false;
    if (active.get(document) === dismiss) {
      active.delete(document);
    }
    document.removeEventListener('keydown', key, true);
    document.removeEventListener('scroll', position, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('blur', dismiss);
    window.visualViewport?.removeEventListener('resize', position);
    window.visualViewport?.removeEventListener('scroll', position);
    panel.hidePopover();
    panel.hidden = true;
  }

  function dismiss(): void {
    dismissed = hovering || focused;
    close();
  }

  function position(): void {
    if (!opened) {
      return;
    }
    if (!trigger.isConnected || !trigger.getClientRects().length || trigger.disabled) {
      dismiss();
      return;
    }
    const anchor = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const bounds = panel.getBoundingClientRect();
    const x = Math.max(
      left + 8,
      Math.min(anchor.left + (anchor.width - bounds.width) / 2, left + width - bounds.width - 8),
    );
    let y = anchor.top - bounds.height;
    if (y < top + 8) {
      y = Math.min(anchor.bottom, top + height - bounds.height - 8);
    }
    panel.style.left = `${x}px`;
    panel.style.top = `${Math.max(top + 8, y)}px`;
  }

  function refresh(): void {
    text.textContent = label();
    position();
  }

  function update(): void {
    if (!hovering && !focused) {
      dismissed = false;
      close();
      return;
    }
    if (
      disposed ||
      dismissed ||
      opened ||
      trigger.disabled ||
      !trigger.isConnected ||
      !trigger.getClientRects().length
    ) {
      return;
    }
    active.get(document)?.();
    active.set(document, dismiss);
    refresh();
    panel.hidden = false;
    panel.showPopover();
    opened = true;
    position();
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    window.addEventListener('blur', dismiss);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
  }

  function key(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    }
  }

  function enter(): void {
    hovering = true;
    update();
  }

  function leave(event: PointerEvent): void {
    const next = event.relatedTarget;
    hovering = isNode(document, next) && (trigger.contains(next) || panel.contains(next));
    update();
  }

  function focus(): void {
    focused = true;
    update();
  }

  function blur(): void {
    focused = false;
    update();
  }

  function toggle(): void {
    if (opened && !panel.matches(':popover-open')) {
      dismiss();
    }
  }

  trigger.addEventListener('pointerenter', enter);
  trigger.addEventListener('pointerleave', leave);
  trigger.addEventListener('focus', focus);
  trigger.addEventListener('blur', blur);
  trigger.addEventListener('click', dismiss);
  panel.addEventListener('pointerenter', enter);
  panel.addEventListener('pointerleave', leave);
  panel.addEventListener('toggle', toggle);

  return {
    refresh,
    dismiss,
    dispose() {
      disposed = true;
      close();
      trigger.removeEventListener('pointerenter', enter);
      trigger.removeEventListener('pointerleave', leave);
      trigger.removeEventListener('focus', focus);
      trigger.removeEventListener('blur', blur);
      trigger.removeEventListener('click', dismiss);
      panel.removeEventListener('pointerenter', enter);
      panel.removeEventListener('pointerleave', leave);
      panel.removeEventListener('toggle', toggle);
      panel.remove();
    },
  };
}
