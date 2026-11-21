import { createPopover, uiId, type PopoverHandle } from './popover.js';
import { requireWindow } from './dom/elements.js';
import { createTypeahead, navigationIndex } from './native/keyboard.js';
import { createIcon } from './icons.js';

/** Retain the native select for form values and validity. Labels are always text. */
export type EnhancedSelect = {
  trigger: HTMLButtonElement;
  popup: PopoverHandle;
  refresh(): void;
  dispose(): void;
};

export function enhanceSelect(
  select: HTMLSelectElement,
  configuration: { nativeTooltip?: boolean } = {},
): EnhancedSelect {
  const document = select.ownerDocument;
  const window = requireWindow(document);
  const original = {
    hidden: select.hidden,
    tabindex: select.getAttribute('tabindex'),
    aria: select.getAttribute('aria-hidden'),
  };
  const closestLabel = select.closest('label');
  let label: HTMLLabelElement | null = null;

  if (closestLabel instanceof window.HTMLLabelElement) {
    label = closestLabel;
  }

  const originalFor = label?.getAttribute('for');
  const shell = document.createElement('span');
  shell.className = 'select-control';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = uiId('select');
  trigger.className = 'select-trigger';
  trigger.setAttribute('role', 'combobox');
  const value = document.createElement('span');
  value.className = 'select-value';
  const caret = createIcon(document, 'chevronDown', 'control-caret');
  trigger.append(value, caret);
  const error = document.createElement('span');
  error.className = 'select-error';
  error.id = uiId('select-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  shell.append(trigger, error);
  select.after(shell);
  const labelText = label?.querySelector(':scope > span');

  if (label) {
    label.htmlFor = trigger.id;
  }

  if (labelText && labelText !== shell) {
    labelText.id ||= uiId('label');
    trigger.setAttribute('aria-labelledby', labelText.id);
  } else {
    trigger.setAttribute(
      'aria-label',
      select.getAttribute('aria-label') || select.name || 'Choose an option',
    );
  }

  const panel = document.createElement('div');
  panel.className = 'select-popup';
  panel.setAttribute('aria-label', labelText?.textContent || select.getAttribute('aria-label') || 'Options');
  shell.append(panel);
  select.hidden = true;
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.dataset.enhanced = 'true';
  let highlight = -1;
  let signature = '';
  let disposed = false;
  const typeahead = createTypeahead();
  let rows: HTMLElement[] = [];
  const options = () => Array.from(select.options);

  function enabled(index: number): boolean {
    const option = select.options[index];

    return (
      !!option &&
      !option.disabled &&
      !option.hidden &&
      !(option.parentElement instanceof window.HTMLOptGroupElement && option.parentElement.disabled)
    );
  }

  function paint(scroll = false): void {
    for (const [index, row] of rows.entries()) {
      row.classList.toggle('highlighted', index === highlight);
      row.setAttribute('aria-selected', String(index === select.selectedIndex));
    }

    const row = rows[highlight];

    if (popup.isOpen() && row) {
      trigger.setAttribute('aria-activedescendant', row.id);

      if (scroll) {
        row.scrollIntoView({ block: 'nearest' });
      }
    } else {
      trigger.removeAttribute('aria-activedescendant');
    }
  }

  function clearError(): void {
    error.hidden = true;
    error.textContent = '';
    trigger.removeAttribute('aria-invalid');
    trigger.removeAttribute('aria-describedby');
  }

  function commit(index: number, restore = true): void {
    let reason: 'selection' | 'tab' = 'tab';

    if (restore) {
      reason = 'selection';
    }

    if (!enabled(index)) {
      popup.close(reason);
      return;
    }

    const changed = select.selectedIndex !== index;
    select.selectedIndex = index;
    popup.close(reason);
    clearError();

    if (changed) {
      select.dispatchEvent(new window.Event('input', { bubbles: true }));
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    }

    refresh();
  }

  const popup = createPopover(trigger, panel, {
    role: 'listbox',
    matchWidth: true,
    onOpen: () => {
      trigger.focus({ preventScroll: true });
      typeahead.reset();
      refresh();
      highlight = options().findIndex((_, index) => enabled(index));

      if (enabled(select.selectedIndex)) {
        highlight = select.selectedIndex;
      }

      paint(true);
    },
    onClose: () => {
      typeahead.reset();
      highlight = select.selectedIndex;
      paint();
    },
  });

  function refresh(): void {
    if (disposed) {
      return;
    }

    const list = options();
    const next = JSON.stringify(
      list.map((option, index) => [
        option.value,
        option.text,
        option.disabled,
        option.hidden,
        enabled(index),
      ]),
    );

    if (next !== signature) {
      signature = next;
      panel.replaceChildren();
      rows = [];

      for (const [index, option] of list.entries()) {
        const row = document.createElement('div');
        row.id = uiId('option');
        row.className = 'select-option';
        row.setAttribute('role', 'option');
        row.dataset.value = option.value;
        row.setAttribute('aria-disabled', String(!enabled(index)));
        row.hidden = option.hidden;
        const check = createIcon(document, 'check', 'option-check');
        const text = document.createElement('span');
        text.textContent = option.text;
        row.append(check, text);
        row.addEventListener('pointerdown', (event) => event.preventDefault());
        row.addEventListener('pointermove', () => {
          if (enabled(index)) {
            highlight = index;
            paint();
          }
        });
        row.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();

          if (!trigger.disabled) {
            commit(index);
          }
        });
        panel.append(row);
        rows.push(row);
      }
    }

    value.textContent = select.selectedOptions[0]?.text || 'Choose…';
    if (configuration.nativeTooltip !== false) {
      trigger.title = value.textContent;
    }
    trigger.disabled = select.disabled;
    trigger.setAttribute('aria-disabled', String(select.disabled));
    trigger.setAttribute('aria-required', String(select.required));

    if (select.disabled) {
      popup.close('disabled');
    }

    if (select.validity.valid) {
      clearError();
    }

    if (!popup.isOpen()) {
      highlight = select.selectedIndex;
    }

    paint();
    popup.position();
  }

  function move(key: string): void {
    const length = select.options.length;
    let index = highlight;

    for (let step = 0; step < length; step += 1) {
      index = navigationIndex(key, index, length) ?? -1;

      if (enabled(index)) {
        highlight = index;
        paint(true);
        return;
      }
    }
  }

  function key(event: KeyboardEvent): void {
    if (trigger.disabled) {
      return;
    }

    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const wasOpen = popup.isOpen();

      if (!wasOpen) {
        popup.open();
      }

      if (event.key === 'Home' || event.key === 'End') {
        const indices = options()
          .map((_, index) => index)
          .filter(enabled);
        const index = navigationIndex(event.key, 0, indices.length);
        highlight = indices[index ?? -1] ?? -1;

        paint(true);
      } else if (wasOpen) {
        move(event.key);
      }
    } else if (event.key === 'Enter' || (event.key === ' ' && !typeahead.active())) {
      event.preventDefault();

      if (popup.isOpen()) {
        commit(highlight);
      } else {
        popup.open();
      }
    } else if (event.key === 'Tab' && popup.isOpen()) {
      commit(highlight, false);
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const query = typeahead.append(event.key);

      const list = options();
      let start = highlight + list.length;

      if (query.length === 1) {
        start += 1;
      }

      for (let offset = 0; offset < list.length; offset += 1) {
        const index = (start + offset) % list.length;
        const option = list[index];

        if (enabled(index) && option?.text.toLocaleLowerCase().startsWith(query)) {
          highlight = index;

          if (popup.isOpen()) {
            paint(true);
          } else {
            commit(index, false);
          }

          break;
        }
      }
    }
  }

  const click = () => popup.toggle();
  const invalid = (event: Event) => {
    event.preventDefault();
    error.textContent = select.validationMessage;
    error.hidden = false;
    trigger.setAttribute('aria-invalid', 'true');
    trigger.setAttribute('aria-describedby', error.id);
    trigger.focus();
  };
  trigger.addEventListener('click', click);
  trigger.addEventListener('keydown', key);
  select.addEventListener('change', refresh);
  select.addEventListener('invalid', invalid);
  const observer = new window.MutationObserver(refresh);
  observer.observe(select, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
  const form = select.form;
  const reset = () => window.queueMicrotask(refresh);
  form?.addEventListener('reset', reset);
  refresh();

  return {
    trigger,
    popup,
    refresh,
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      observer.disconnect();
      try {
        popup.dispose();
      } finally {
        trigger.removeEventListener('click', click);
        trigger.removeEventListener('keydown', key);
        select.removeEventListener('change', refresh);
        select.removeEventListener('invalid', invalid);
        form?.removeEventListener('reset', reset);
        shell.remove();
        select.hidden = original.hidden;

        if (original.tabindex === null) {
          select.removeAttribute('tabindex');
        } else {
          select.setAttribute('tabindex', original.tabindex);
        }

        if (original.aria === null) {
          select.removeAttribute('aria-hidden');
        } else {
          select.setAttribute('aria-hidden', original.aria);
        }

        delete select.dataset.enhanced;

        if (label) {
          if (originalFor === null || originalFor === undefined) {
            label.removeAttribute('for');
          } else {
            label.setAttribute('for', originalFor);
          }
        }
      }
    },
  };
}

export function enhanceSelects(root: HTMLElement): {
  refresh(): void;
  dispose(): void;
} {
  const window = requireWindow(root.ownerDocument);
  const controls: EnhancedSelect[] = [];

  for (const element of root.querySelectorAll('select:not([data-enhanced])')) {
    if (element instanceof window.HTMLSelectElement) {
      controls.push(enhanceSelect(element));
    }
  }

  return {
    refresh() {
      for (const control of controls) {
        control.refresh();
      }
    },
    dispose() {
      for (const control of controls) {
        control.dispose();
      }
    },
  };
}
