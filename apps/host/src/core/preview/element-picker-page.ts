// Runs in Chrome's isolated world before the project's own scripts.
export function mountElementPicker(origin: string, captureLimit: number) {
  if (window !== window.top || location.origin !== origin) {
    return;
  }
  const notify = Reflect.get(globalThis, 'miterPick');
  if (typeof notify !== 'function') {
    return;
  }

  const plane = document.createElement('miter-picker-layer');
  plane.setAttribute('aria-hidden', 'true');
  plane.style.cssText =
    'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;cursor:crosshair!important;';
  const toolbar = document.createElement('miter-picker-toolbar');
  toolbar.style.cssText =
    'all:initial!important;position:fixed!important;right:12px!important;bottom:12px!important;max-width:calc(100vw - 24px)!important;z-index:2147483647!important;';
  const shadow = toolbar.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { color-scheme:dark }
    .bar { display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px;background:#282925;color:#eeeee6;border:1px solid #777a6d;border-radius:8px;font:14px/1.45 system-ui,sans-serif }
    .status { flex:1 1 220px }
    button { min-height:32px;font:inherit;color:inherit;background:#383934;border:1px solid #777a6d;border-radius:5px;padding:5px 10px;cursor:pointer }
    button:focus-visible { outline:2px solid #dfbd82;outline-offset:2px }
    button:disabled { opacity:.5;cursor:default }
    .done { background:#dfbd82;color:#262017;border-color:#dfbd82 }
    .outline { position:fixed;box-sizing:border-box;border:2px solid #dfbd82;background:#dfbd8233;pointer-events:none }
    .label { position:fixed;box-sizing:border-box;max-width:100vw;padding:3px 7px;border-radius:4px;background:#262017;color:#fff3dd;font:12px/18px system-ui,sans-serif;white-space:nowrap;pointer-events:none }
  `;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Miter element picker');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'done';
  done.textContent = 'Done';
  done.disabled = true;
  const status = document.createElement('span');
  status.className = 'status';
  status.setAttribute('role', 'status');
  const outline = document.createElement('div');
  outline.className = 'outline';
  outline.hidden = true;
  outline.setAttribute('aria-hidden', 'true');
  const label = document.createElement('div');
  label.className = 'label';
  label.hidden = true;
  label.setAttribute('aria-hidden', 'true');
  bar.append(status, cancel, done);
  shadow.append(style, outline, label, bar);

  let count = 0;
  let interacting = false;
  let selected: Element | undefined;
  let privacyMask: HTMLStyleElement | undefined;
  let pointer: { x: number; y: number } | undefined;
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

  function updateStatus(message = '') {
    done.disabled = count === 0 || !!selected;
    if (message) {
      status.textContent = message;
    } else if (count >= captureLimit) {
      status.textContent = count + ' captured. Choose Done to review.';
    } else if (count > 0) {
      status.textContent = count + ' captured. Click another element or choose Done.';
    } else {
      status.textContent =
        'Click to capture. Option/Alt-click to use the app. Tab and Enter to capture by keyboard.';
    }
  }

  function stop(event: Event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function boundedRect(element: Element) {
    const rect = element.getBoundingClientRect();
    return {
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      right: Math.min(innerWidth, rect.right),
      bottom: Math.min(innerHeight, rect.bottom),
    };
  }

  function unsafe(element: Element) {
    if (
      !element.isConnected ||
      element === document.body ||
      element === document.documentElement ||
      element === plane ||
      element === toolbar ||
      element.closest(privateFields + ',iframe,object,embed') ||
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

  function highlighted(element?: Element | null) {
    if (!element || interacting || selected || count >= captureLimit || unsafe(element)) {
      outline.hidden = true;
      label.hidden = true;
      return;
    }
    const { left, top, right, bottom } = boundedRect(element);
    const width = right - left;
    const height = bottom - top;
    outline.style.cssText =
      'left:' + left + 'px;top:' + top + 'px;width:' + width + 'px;height:' + height + 'px';
    label.style.top = Math.max(0, top - 25) + 'px';
    label.textContent = element.localName + ' · ' + Math.round(width) + ' × ' + Math.round(height);
    label.hidden = false;
    label.style.left = Math.min(left, innerWidth - label.offsetWidth) + 'px';
    outline.hidden = false;
  }

  function elementAt(x: number, y: number) {
    plane.style.setProperty('pointer-events', 'none', 'important');
    const element = document.elementFromPoint(x, y);
    plane.style.setProperty('pointer-events', 'auto', 'important');
    return element;
  }

  function interact(enabled: boolean) {
    interacting = enabled;
    let display = 'block';
    if (enabled) {
      display = 'none';
    }
    plane.style.setProperty('display', display, 'important');
    if (enabled || !pointer) {
      highlighted();
      return;
    }
    highlighted(elementAt(pointer.x, pointer.y));
  }

  function select(element: Element | null) {
    if (selected || count >= captureLimit) {
      return;
    }
    if (!element || unsafe(element)) {
      updateStatus('Choose a visible area away from private fields.');
      return;
    }
    // Mask sensitive inputs throughout the viewport until Chrome finishes the capture.
    privacyMask = document.createElement('style');
    privacyMask.textContent =
      privateFields +
      ',iframe,object,embed {visibility:hidden!important;opacity:0!important}' +
      'input:not([type=button],[type=submit],[type=reset]),textarea,select,[contenteditable] {color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}';
    document.documentElement.append(privacyMask);
    selected = element;
    highlighted();
    toolbar.style.setProperty('display', 'none', 'important');
    notify('selected');
  }

  Reflect.set(globalThis, 'miterSettleCapture', (total: number, message: string) => {
    count = total;
    privacyMask?.remove();
    privacyMask = undefined;
    selected = undefined;
    toolbar.style.removeProperty('display');
    updateStatus(message);
    if (pointer) {
      highlighted(elementAt(pointer.x, pointer.y));
    }
  });
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

  function placeControls() {
    // A native modal makes the rest of its document inert, including fixed overlays.
    const dialogs = [...document.querySelectorAll('dialog:modal')];
    const surface =
      document.activeElement?.closest('dialog:modal') ?? dialogs.at(-1) ?? document.documentElement;
    if (plane.parentElement !== surface) {
      surface.append(plane, toolbar);
    }
  }

  function mount() {
    placeControls();
    updateStatus();
    notify('ready');
  }
  if (document.documentElement) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }
  document.addEventListener(
    'toggle',
    (event) => {
      if (event.target instanceof HTMLDialogElement) {
        placeControls();
      }
    },
    true,
  );
  cancel.addEventListener('click', (event) => {
    if (event.isTrusted) {
      notify('cancel');
    }
  });
  done.addEventListener('click', (event) => {
    if (event.isTrusted && !done.disabled) {
      notify('done');
    }
  });
  window.addEventListener('blur', () => {
    pointer = undefined;
    interact(false);
  });
  window.addEventListener(
    'scroll',
    () => {
      if (pointer && !interacting && !selected) {
        highlighted(elementAt(pointer.x, pointer.y));
      }
    },
    true,
  );
  window.addEventListener('focusin', (event) => {
    if (event.composedPath().includes(toolbar)) {
      highlighted();
    } else if (event.target instanceof Element) {
      highlighted(event.target);
    }
  });

  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted) {
        return;
      }
      if (event.key === 'Alt' && !selected) {
        interact(true);
        stop(event);
        return;
      }
      if (event.key === 'Escape' && !event.altKey) {
        stop(event);
        notify('cancel');
        return;
      }
      if (!selected && (event.altKey || event.composedPath().includes(toolbar))) {
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
  window.addEventListener(
    'keyup',
    (event) => {
      if (!event.isTrusted) {
        return;
      }
      if (event.key === 'Alt') {
        interact(false);
        stop(event);
      } else if (selected || (!event.altKey && !event.composedPath().includes(toolbar))) {
        stop(event);
      }
    },
    true,
  );

  for (const name of [
    'pointermove',
    'pointerover',
    'pointerout',
    'mousemove',
    'mouseover',
    'mouseout',
    'pointerdown',
    'mousedown',
    'pointerup',
    'mouseup',
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
  ]) {
    window.addEventListener(
      name,
      (event) => {
        if (!event.isTrusted || !(event instanceof MouseEvent) || event.composedPath().includes(toolbar)) {
          return;
        }
        if (name === 'pointermove') {
          pointer = { x: event.clientX, y: event.clientY };
        } else if (name === 'pointerout' && event.relatedTarget === null) {
          pointer = undefined;
          highlighted();
        }
        if (!selected && event.altKey && interacting) {
          // Chrome treats Alt-click on a link as a download. Follow it as a regular app link.
          if (name === 'click' && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
            if (link instanceof HTMLAnchorElement && link.hasAttribute('href')) {
              stop(event);
              link.click();
            }
          }
          return;
        }
        stop(event);
        if (name === 'pointermove') {
          highlighted(elementAt(event.clientX, event.clientY));
        } else if (name === 'click' && event.button === 0) {
          select(elementAt(event.clientX, event.clientY));
        }
      },
      true,
    );
  }
}
