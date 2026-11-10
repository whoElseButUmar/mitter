import { z } from 'zod';
import { createPopover, uiId, type PopoverHandle } from './popover.js';
import { isElement, requireWindow } from './dom/elements.js';
import { MenuItemSchema } from './native/schemas.js';
import { createTypeahead, navigationIndex } from './native/keyboard.js';

export { MenuItemSchema } from './native/schemas.js';
export type MenuItem = z.infer<typeof MenuItemSchema> & { run(): void };
export type MenuHandle = {
  trigger: HTMLElement;
  popup: PopoverHandle;
  update(items: MenuItem[], disabled?: boolean): void;
  dispose(): void;
};

type MenuContext = { trigger: HTMLElement; items: () => MenuItem[] };

/** The same lifetime/dismissal model as select-only comboboxes. */
export function mountMenu(
  root: HTMLElement,
  label: string,
  initial: MenuItem[],
  context?: MenuContext,
): MenuHandle {
  const document = root.ownerDocument;
  const window = requireWindow(document);
  let trigger: HTMLElement;
  let ownedTrigger: HTMLButtonElement | undefined;

  if (context) {
    trigger = context.trigger;
  } else {
    ownedTrigger = document.createElement('button');
    ownedTrigger.type = 'button';
    ownedTrigger.id = uiId('menu-button');
    ownedTrigger.className = 'menu-trigger';
    ownedTrigger.textContent = label;
    const caret = document.createElement('span');
    caret.className = 'control-caret';
    caret.setAttribute('aria-hidden', 'true');
    ownedTrigger.append(caret);
    trigger = ownedTrigger;
    root.append(trigger);
  }

  const panel = document.createElement('div');
  panel.className = 'menu-popup';

  if (context) {
    panel.setAttribute('aria-label', label);
  } else {
    panel.setAttribute('aria-labelledby', trigger.id);
  }

  root.append(panel);
  let point: { x: number; y: number } | undefined;
  let items = initial;
  let disposed = false;
  let buttons: HTMLButtonElement[] = [];

  const typeahead = createTypeahead();

  function focus(index: number): void {
    const button = buttons[index];

    if (index < 0 || !button || button.disabled) {
      return;
    }

    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: 'nearest' });
  }

  function enabled(): number[] {
    const indices: number[] = [];

    for (const [index, button] of buttons.entries()) {
      if (!button.disabled) {
        indices.push(index);
      }
    }

    return indices;
  }

  let align: 'start' | 'end' = 'end';

  if (context) {
    align = 'start';
  }

  const popup = createPopover(trigger, panel, {
    role: 'menu',
    align,
    minWidth: 222,
    decorateTrigger: !context,
    anchor: () => {
      if (context && point) {
        return {
          left: point.x,
          right: point.x,
          top: point.y,
          bottom: point.y,
          width: 0,
        };
      }

      return trigger.getBoundingClientRect();
    },
    onOpen: () => {
      typeahead.reset();
      focus(enabled()[0] ?? -1);
    },
  });

  const shape = (values: MenuItem[]) =>
    JSON.stringify(
      values.map((item) => [
        item.id,
        item.label,
        !!item.disabled,
        !!item.danger,
        !!item.separatorBefore,
        item.shortcut,
      ]),
    );

  function update(next: MenuItem[], disabled = false): void {
    const previousFocus = items[buttons.findIndex((button) => button === document.activeElement)]?.id;

    const changed = !buttons.length || shape(items) !== shape(next);
    items = next;

    if (ownedTrigger) {
      ownedTrigger.disabled = disabled;
    }

    if (disabled) {
      popup.close('disabled');
    }

    if (!changed) {
      return;
    }

    panel.replaceChildren();
    buttons = [];

    for (const item of items) {
      if (item.separatorBefore) {
        const separator = document.createElement('div');
        separator.className = 'menu-separator';
        separator.setAttribute('role', 'separator');
        panel.append(separator);
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.tabIndex = -1;
      button.disabled = !!item.disabled;
      button.setAttribute('aria-disabled', String(!!item.disabled));
      button.className = 'menu-item';

      if (item.danger) {
        button.classList.add('danger');
      }

      button.textContent = item.label;

      if (item.shortcut) {
        const hint = document.createElement('kbd');
        hint.className = 'menu-shortcut';
        hint.textContent = item.shortcut;
        button.append(hint);
      }

      button.addEventListener('pointermove', (event) => {
        if (popup.isOpen() && !button.disabled && event.pointerType !== 'touch') {
          button.focus({ preventScroll: true });
        }
      });
      button.addEventListener('click', () => {
        const current = items.find((candidate) => candidate.id === item.id);

        if (!current || current.disabled) {
          return;
        }

        popup.close('selection');
        current.run();
      });
      panel.append(button);
      buttons.push(button);
    }

    if (popup.isOpen()) {
      let index = items.findIndex((item) => item.id === previousFocus && !item.disabled);

      if (index < 0) {
        index = enabled()[0] ?? -1;
      }

      focus(index);
      popup.position();
    }
  }

  const click = () => popup.toggle();
  const triggerKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      popup.open();
      let index = enabled()[0] ?? -1;

      if (event.key === 'ArrowUp') {
        index = enabled().at(-1) ?? -1;
      }

      focus(index);
    }
  };

  const menuKey = (event: KeyboardEvent) => {
    const indices = enabled();
    const focused = buttons.findIndex((button) => button === document.activeElement);
    const current = indices.indexOf(focused);

    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = navigationIndex(event.key, current, indices.length);
      focus(indices[index ?? -1] ?? -1);
    } else if (event.key === 'Tab') {
      // Let the browser continue from the trigger's normal document position.
      popup.close('tab');
      trigger.focus({ preventScroll: true });
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      (event.key !== ' ' || typeahead.active())
    ) {
      event.preventDefault();
      const query = typeahead.append(event.key);

      for (let offset = 1; offset <= indices.length; offset += 1) {
        const index = indices[(current + offset) % indices.length];
        const item = items[index ?? -1];

        if (index !== undefined && item?.label.toLocaleLowerCase().startsWith(query)) {
          focus(index);
          break;
        }
      }
    }
  };

  const openContext = (event: MouseEvent | KeyboardEvent) => {
    if (!context) {
      return;
    }

    let target: Element | undefined;

    if (isElement(document, event.target)) {
      target = event.target;
    }

    if (
      root.hasAttribute('data-miter-context') &&
      (target?.closest('input,textarea,[contenteditable=true]') ||
        target?.closest('[data-miter-context]') !== root)
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    point = undefined;

    if (event instanceof window.MouseEvent && event.button === 2) {
      point = { x: event.clientX, y: event.clientY };
    }

    update(context.items());
    popup.open();
  };
  const contextKey = (event: KeyboardEvent) => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      openContext(event);
    }
  };

  if (context) {
    root.addEventListener('contextmenu', openContext);
    trigger.addEventListener('keydown', contextKey);
  } else {
    trigger.addEventListener('click', click);
    trigger.addEventListener('keydown', triggerKey);
  }

  panel.addEventListener('keydown', menuKey);
  update(initial);

  return {
    trigger,
    popup,
    update,
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;

      try {
        popup.dispose();
      } finally {
        trigger.removeEventListener('click', click);
        trigger.removeEventListener('keydown', triggerKey);
        panel.removeEventListener('keydown', menuKey);
        root.removeEventListener('contextmenu', openContext);
        trigger.removeEventListener('keydown', contextKey);

        if (!context) {
          root.replaceChildren();
        }
      }
    },
  };
}
