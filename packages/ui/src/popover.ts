/** Shared, dependency-free popup lifetime. Used by menus, selects and info panels.
 * Dismissal never steals focus from a control clicked outside the popup. */
export type CloseReason = 'escape'|'selection'|'toggle'|'outside'|'blur'|'superseded'|'disabled'|'dispose'|'tab';
export interface PopoverOptions {
  role?: 'menu'|'listbox'|'dialog';
  align?: 'start'|'end';
  matchWidth?: boolean;
  minWidth?: number;
  maxHeight?: number;
  anchor?: () => {left:number;right:number;top:number;bottom:number;width:number};
  decorateTrigger?: boolean;
  onOpen?: () => void;
  onClose?: (reason: CloseReason) => void;
}
export interface PopoverHandle {
  open(): void;
  close(reason?: CloseReason): void;
  toggle(): void;
  isOpen(): boolean;
  position(): void;
  dispose(): void;
}
let sequence = 0;
const activeByDocument = new WeakMap<Document, PopoverHandle>();
export function uiId(prefix: string): string { return `mitter-${prefix}-${++sequence}`; }
export function closeActivePopover(doc: Document, reason: CloseReason = 'outside'): void {
  activeByDocument.get(doc)?.close(reason);
}
export function createPopover(trigger: HTMLElement, panel: HTMLElement, options: PopoverOptions = {}): PopoverHandle {
  const doc = trigger.ownerDocument, win = doc.defaultView! as Window & typeof globalThis;
  let opened = false, disposed = false, frame = 0;
  panel.id ||= uiId('popup');
  panel.classList.add('mitter-popup');
  panel.setAttribute('role', options.role || 'menu');
  panel.setAttribute('popover', 'manual');
  panel.hidden = true;
  const attrs=['aria-haspopup','aria-expanded','aria-controls'];
  const previous=attrs.map(name=>trigger.getAttribute(name));
  if(options.decorateTrigger!==false){trigger.setAttribute('aria-haspopup', options.role || 'menu');trigger.setAttribute('aria-expanded', 'false');trigger.setAttribute('aria-controls', panel.id);}
  // In a modal, this also keeps the popup inside the dialog's focus boundary.
  (trigger.closest('dialog') || doc.body).append(panel);
  const contains = (target: EventTarget | null) => target instanceof win.Node && (trigger.contains(target as Node) || panel.contains(target as Node));
  const anchorVisible = () => trigger.isConnected && trigger.getClientRects().length > 0 && !trigger.closest('[hidden]');
  function position() {
    if (!opened) return;
    if (!anchorVisible() || trigger.getAttribute('aria-disabled') === 'true' || trigger.hasAttribute('disabled')) { close('disabled'); return; }
    const rect = options.anchor?.() || trigger.getBoundingClientRect(), view = win.visualViewport;
    const leftEdge = (view?.offsetLeft || 0) + 8, topEdge = (view?.offsetTop || 0) + 8;
    const rightEdge = leftEdge + (view?.width || win.innerWidth) - 16;
    const bottomEdge = topEdge + (view?.height || win.innerHeight) - 16;
    const width = Math.min(Math.max(100, options.matchWidth ? rect.width : Math.max(rect.width, options.minWidth || 218)), rightEdge - leftEdge);
    panel.style.width = `${width}px`;
    const desired = Math.min(options.maxHeight || 320, panel.scrollHeight || 320);
    const below = Math.max(0, bottomEdge - rect.bottom - 4), above = Math.max(0, rect.top - topEdge - 4);
    const upward = below < Math.min(desired, 120) && above > below;
    const height = Math.max(0, Math.min(options.maxHeight || 320, upward ? above : below));
    panel.style.maxHeight = `${height}px`;
    panel.dataset.placement = upward ? 'top' : 'bottom';
    const left = Math.max(leftEdge, Math.min(options.align === 'end' ? rect.right - width : rect.left, rightEdge - width));
    const measured = Math.min(panel.scrollHeight + 2, height);
    const top = upward ? Math.max(topEdge, rect.top - measured - 4) : Math.max(topEdge, Math.min(rect.bottom + 4, bottomEdge - measured));
    panel.style.left = `${left}px`; panel.style.top = `${top}px`;
  }
  const schedulePosition = () => { if (opened && !frame) frame = win.requestAnimationFrame(() => { frame = 0; position(); }); };
  function open() {
    if (disposed || opened || !anchorVisible() || trigger.hasAttribute('disabled') || trigger.getAttribute('aria-disabled') === 'true') return;
    activeByDocument.get(doc)?.close('superseded');
    opened = true; activeByDocument.set(doc, handle);
    panel.hidden = false; trigger.dataset.open = 'true'; if(options.decorateTrigger!==false)trigger.setAttribute('aria-expanded', 'true');
    if (typeof panel.showPopover === 'function') {
      try { panel.showPopover(); } catch { panel.removeAttribute('popover'); }
    } else panel.removeAttribute('popover');
    position();
    doc.addEventListener('pointerdown', onOutside, true);
    doc.addEventListener('focusin', onFocus, true);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('scroll', onScroll, true);
    doc.addEventListener('toggle', schedulePosition, true);
    win.addEventListener('resize', schedulePosition);
    win.addEventListener('blur', onWindowBlur);
    win.visualViewport?.addEventListener('resize', schedulePosition);
    win.visualViewport?.addEventListener('scroll', schedulePosition);
    options.onOpen?.();
  }
  function close(reason: CloseReason = 'outside') {
    if (!opened) return;
    opened = false;
    if (activeByDocument.get(doc) === handle) activeByDocument.delete(doc);
    if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('focusin', onFocus, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('scroll', onScroll, true);
    doc.removeEventListener('toggle', schedulePosition, true);
    win.removeEventListener('resize', schedulePosition);
    win.removeEventListener('blur', onWindowBlur);
    win.visualViewport?.removeEventListener('resize', schedulePosition);
    win.visualViewport?.removeEventListener('scroll', schedulePosition);
    if (typeof panel.hidePopover === 'function') { try { panel.hidePopover(); } catch {} }
    panel.hidden = true; delete trigger.dataset.open; if(options.decorateTrigger!==false)trigger.setAttribute('aria-expanded', 'false');
    if (['escape','selection','toggle'].includes(reason) && trigger.isConnected && !trigger.hasAttribute('disabled')) trigger.focus({preventScroll:true});
    options.onClose?.(reason);
  }
  function onOutside(event: Event) { if (!contains(event.target)) close('outside'); }
  function onFocus(event: FocusEvent) { if (!contains(event.target)) close('blur'); }
  function onWindowBlur() { close('blur'); }
  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close('escape'); }
  }
  function onScroll(event: Event) { if (!panel.contains(event.target as Node)) schedulePosition(); }
  // Disabling/unmounting a trigger cannot leave an interactive orphan menu.
  const observer = new win.MutationObserver(() => { if (opened) schedulePosition(); });
  observer.observe(trigger, {attributes:true, attributeFilter:['disabled','aria-disabled','hidden']});
  const handle: PopoverHandle = {open, close, toggle:() => opened ? close('toggle') : open(), isOpen:() => opened, position,
    dispose:() => { if (disposed) return; close('dispose'); disposed = true; observer.disconnect(); panel.remove(); attrs.forEach((name,i)=>previous[i]===null?trigger.removeAttribute(name):trigger.setAttribute(name,previous[i]!)); }};
  return handle;
}

/** Read-only information panels (for example completion checks) use the same
 * dismissal rules, but expose a labelled non-modal dialog rather than a menu. */
export function bindInfoPopover(trigger:HTMLElement,panel:HTMLElement):PopoverHandle {
  const pop=createPopover(trigger,panel,{role:'dialog',align:'end',minWidth:270,onOpen:()=>panel.focus({preventScroll:true})});
  const click=()=>pop.toggle();
  const key=(event:KeyboardEvent)=>{if(event.key==='Tab'){pop.close('tab');trigger.focus({preventScroll:true});}};
  trigger.addEventListener('click',click);panel.addEventListener('keydown',key);
  return {...pop,dispose(){trigger.removeEventListener('click',click);panel.removeEventListener('keydown',key);pop.dispose();}};
}
