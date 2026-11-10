export type PopupAnchor = { left: number; right: number; top: number; bottom: number; width: number };
export type PopupPositionOptions = {
  align?: 'start' | 'end';
  matchWidth?: boolean;
  minWidth?: number;
  maxHeight?: number;
};

/** Keep the same viewport margins and above/below placement in native and fallback popups. */
export function positionPopup(
  window: Window,
  panel: HTMLElement,
  anchor: PopupAnchor,
  options: PopupPositionOptions,
): void {
  const viewport = window.visualViewport;
  const leftEdge = (viewport?.offsetLeft || 0) + 8;
  const topEdge = (viewport?.offsetTop || 0) + 8;
  const rightEdge = leftEdge + (viewport?.width || window.innerWidth) - 16;
  const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - 16;
  let requestedWidth = Math.max(anchor.width, options.minWidth || 218);

  if (options.matchWidth) {
    requestedWidth = anchor.width;
  }

  const width = Math.min(Math.max(100, requestedWidth), rightEdge - leftEdge);
  panel.style.width = `${width}px`;
  const desired = Math.min(options.maxHeight || 320, panel.scrollHeight || 320);
  const below = Math.max(0, bottomEdge - anchor.bottom - 4);
  const above = Math.max(0, anchor.top - topEdge - 4);
  const upward = below < Math.min(desired, 120) && above > below;
  let availableHeight = below;
  let placement = 'bottom';

  if (upward) {
    availableHeight = above;
    placement = 'top';
  }

  const height = Math.max(0, Math.min(options.maxHeight || 320, availableHeight));
  panel.style.maxHeight = `${height}px`;
  panel.dataset.placement = placement;
  let alignedLeft = anchor.left;

  if (options.align === 'end') {
    alignedLeft = anchor.right - width;
  }

  const left = Math.max(leftEdge, Math.min(alignedLeft, rightEdge - width));
  const measured = Math.min(panel.scrollHeight + 2, height);
  let top = Math.max(topEdge, Math.min(anchor.bottom + 4, bottomEdge - measured));

  if (upward) {
    top = Math.max(topEdge, anchor.top - measured - 4);
  }

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}
