// Runs in Chrome's isolated world before the project's own scripts.
export function mountElementPicker(origin: string) {
  if (window !== window.top || location.origin !== origin) {
    return;
  }
  const notify = Reflect.get(globalThis, 'miterPick');
  if (typeof notify !== 'function') {
    return;
  }
  const toolbar = document.createElement('div');
  toolbar.style.cssText =
    'all:initial!important;position:fixed!important;right:12px!important;bottom:12px!important;z-index:2147483647!important;';
  const shadow = toolbar.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { color-scheme:light; } div {display:flex;align-items:center;gap:8px;padding:6px 8px;background:#242424;color:#fff;border:1px solid #666;border-radius:8px;font:14px/1.45 system-ui,sans-serif}
    button {font:inherit;color:inherit;background:#383838;border:1px solid #777;border-radius:5px;padding:5px 10px;cursor:pointer}
    button:focus-visible {outline:2px solid #fff;outline-offset:2px}
  `;
  const bar = document.createElement('div');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Miter element picker');
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.textContent = 'Select element';
  choose.setAttribute('aria-keyshortcuts', 'Alt+Shift+P');
  choose.title = 'Select element (Alt+Shift+P)';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  bar.append(status, choose, cancel);
  shadow.append(style, bar);

  let armed = false;
  let selected: Element | undefined;
  const privateFields = [
    'input[type=password]',
    'input[type=file]',
    'input[type=hidden]',
    '[data-private]',
    '[autocomplete*=password i]',
    '[autocomplete*=one-time-code i]',
    '[autocomplete*=cc- i]',
    '[name*=password i]',
    '[id*=password i]',
    '[aria-label*=password i]',
    '[name*=secret i]',
    '[name*=token i]',
    '[id*=secret i]',
    '[id*=token i]',
    '[name*=credit i]',
    '[name*=cvv i]',
    '[name*=cvc i]',
    '[aria-label*=security\\ code i]',
  ].join(',');
  function arm() {
    armed = true;
    choose.hidden = true;
    status.textContent = 'Click an element, or Tab and press Enter. Esc cancels.';
    toolbar.style.setProperty('pointer-events', 'none', 'important');
    cancel.hidden = true;
  }
  function stop(event: Event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function boundedRect(element: Element) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    return {
      left,
      top,
      right: Math.min(innerWidth, rect.right, left + 640),
      bottom: Math.min(innerHeight, rect.bottom, top + 320),
    };
  }
  function unsafe(element: Element) {
    if (
      !element.isConnected ||
      element === document.body ||
      element === document.documentElement ||
      element.closest(privateFields) ||
      element.querySelector(privateFields)
    ) {
      return true;
    }
    const clip = boundedRect(element);
    if (clip.right - clip.left < 1 || clip.bottom - clip.top < 1) {
      return true;
    }
    for (const control of document.querySelectorAll(privateFields + ',iframe,object,embed')) {
      const rect = control.getBoundingClientRect();
      if (
        rect.width &&
        rect.height &&
        rect.right > clip.left &&
        rect.left < clip.right &&
        rect.bottom > clip.top &&
        rect.top < clip.bottom
      ) {
        return true;
      }
    }
    return false;
  }
  function select(element: Element) {
    if (unsafe(element)) {
      status.textContent = 'Choose a smaller element outside private fields.';
      return;
    }
    // Stronger than masking the selected control: conceal private fields elsewhere
    // during capture, including fields moved by the app between input and screenshot.
    const shield = document.createElement('style');
    shield.textContent =
      privateFields +
      ',iframe,object,embed {visibility:hidden!important;opacity:0!important}' +
      'input:not([type=button],[type=submit],[type=reset]),textarea,select,[contenteditable] {color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}';
    document.documentElement.append(shield);
    selected = element;
    toolbar.style.setProperty('display', 'none', 'important');
    notify('selected');
  }
  Reflect.set(globalThis, 'miterSelectedElement', () => selected);
  Reflect.set(globalThis, 'miterSelectedClip', () => {
    if (!selected || unsafe(selected)) {
      return;
    }
    const { left, top, right, bottom } = boundedRect(selected);
    let node: Element | null = selected;
    const parts: string[] = [];
    while (node && node !== document.documentElement) {
      const parent: Element | null = node.parentElement;
      if (!parent) {
        return;
      }
      const tag = CSS.escape(node.localName);
      const peers = [...parent.children].filter((child) => child.localName === node?.localName);
      let part = tag;
      if (peers.length > 1) {
        part += ':nth-of-type(' + (peers.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      const selector = parts.join(' > ');
      if (selector.length > 300) {
        return;
      }
      if (document.querySelectorAll(selector).length === 1) {
        return {
          selector,
          pathname: location.pathname,
          viewport: { width: innerWidth, height: innerHeight },
          clip: { x: left + scrollX, y: top + scrollY, width: right - left, height: bottom - top },
        };
      }
      node = parent;
    }
    return;
  });
  function mount() {
    document.documentElement.append(toolbar);
  }
  if (document.documentElement) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }
  choose.addEventListener('click', (event) => {
    if (event.isTrusted) {
      arm();
    }
  });
  cancel.addEventListener('click', (event) => {
    if (event.isTrusted) {
      notify('cancel');
    }
  });
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted) {
        return;
      }
      if (event.code === 'KeyP' && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        stop(event);
        arm();
        return;
      }
      if (event.key === 'Escape') {
        stop(event);
        notify('cancel');
        return;
      }
      if (!armed || event.composedPath().includes(toolbar)) {
        return;
      }
      event.stopImmediatePropagation();
      if (event.key !== 'Tab') {
        event.preventDefault();
      }
      if (event.key === 'Enter' && event.target instanceof Element) {
        select(event.target);
      }
    },
    true,
  );
  for (const name of [
    'pointerdown',
    'mousedown',
    'pointerup',
    'mouseup',
    'click',
    'auxclick',
    'contextmenu',
    'keyup',
  ]) {
    window.addEventListener(
      name,
      (event) => {
        if (!event.isTrusted || !armed || event.composedPath().includes(toolbar)) {
          return;
        }
        stop(event);
        if (name === 'click' && event.target instanceof Element && !selected) {
          select(event.target);
        }
      },
      true,
    );
  }
}
