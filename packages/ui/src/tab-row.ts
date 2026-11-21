import { z } from 'zod';
import { closeActivePopover } from './popover.js';
import { mountMenu, type MenuItem, type MenuHandle } from './menu.js';
import { isElement, isNode, requireWindow } from './dom/elements.js';
import { TabItemSchema } from './native/schemas.js';
import { navigationIndex } from './native/keyboard.js';
import { createIcon } from './icons.js';

export { TabItemSchema } from './native/schemas.js';
export type TabItem = z.infer<typeof TabItemSchema>;
export type TabRowOptions = {
  kind: 'project' | 'task';
  items: TabItem[];
  selected: string;
  addDisabled?: boolean;
  canAdd: boolean;
  addLabel: string;
  onSelect(id: string): void;
  onAdd(): void;
  onClose?(id: string): void;
  onList?(): void;
  listLabel?: string;
  menuItems?(id: string): MenuItem[];
};

type TabEntry = {
  tab: HTMLButtonElement;
  text: HTMLSpanElement;
  dot: HTMLElement;
  menu?: MenuHandle;
};

export function tabId(kind: 'project' | 'task', id: string): string {
  return `mitter-${kind}-tab-${encodeURIComponent(id)}`;
}

/** Only tabs belong to the tablist; row actions and popups stay outside it. */
export function mountTabRow(root: HTMLElement, initial: TabRowOptions) {
  const document = root.ownerDocument;
  const window = requireWindow(document);
  let options = initial;
  let selectedBefore = '';
  const entries = new Map<string, TabEntry>();
  root.className = `workspace-tab-row ${initial.kind}-tab-row`;
  const label = document.createElement('span');
  label.className = 'tab-row-label';
  label.textContent = 'Tasks';

  if (initial.kind === 'project') {
    label.textContent = 'Projects';
  }

  label.id = `mitter-${initial.kind}-tabs-label`;
  const list = document.createElement('div');
  list.className = 'tabbar';
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-labelledby', label.id);
  list.setAttribute('aria-orientation', 'horizontal');
  const empty = document.createElement('span');
  empty.className = 'empty-tabs';
  empty.textContent = 'No open tasks';

  if (initial.kind === 'project') {
    empty.textContent = 'No open projects';
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'add-tab';
  add.append(createIcon(document, 'plus'));
  const addClick = () => {
    closeActivePopover(document);
    options.onAdd();
  };
  add.addEventListener('click', addClick);
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'list-tabs';
  let listIcon: 'folders' | 'listTodo' = 'listTodo';

  if (initial.kind === 'project') {
    listIcon = 'folders';
  }

  all.append(createIcon(document, listIcon));
  const listClick = () => {
    closeActivePopover(document);
    options.onList?.();
  };
  all.addEventListener('click', listClick);
  const closeActive = document.createElement('button');
  closeActive.type = 'button';
  closeActive.className = 'close-active-tab';
  closeActive.append(createIcon(document, 'close'));
  const closeClick = () => close(options.selected);
  closeActive.addEventListener('click', closeClick);
  root.append(label, list, empty, closeActive, add, all);

  function resetRoving(): void {
    for (const [id, entry] of entries) {
      let tabIndex = -1;

      if (id === options.selected) {
        tabIndex = 0;
      }

      entry.tab.tabIndex = tabIndex;
    }
  }

  function close(id: string): void {
    if (!entries.has(id) || !options.onClose) {
      return;
    }

    closeActivePopover(document);
    options.onClose(id);
  }

  function update(next: TabRowOptions): void {
    options = next;
    const hadFocus = list.contains(document.activeElement);
    const closeHadFocus = document.activeElement === closeActive;
    const selectionChanged = selectedBefore !== next.selected;

    for (const [id, entry] of entries) {
      if (!next.items.some((item) => item.id === id)) {
        entry.menu?.dispose();
        entry.tab.remove();
        entries.delete(id);
      }
    }

    for (const [index, item] of next.items.entries()) {
      let entry = entries.get(item.id);

      if (!entry) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = `worker-tab ${next.kind}-tab`;
        tab.setAttribute('role', 'tab');
        tab.id = tabId(next.kind, item.id);
        tab.dataset.tabId = item.id;
        const dot = document.createElement('i');
        dot.setAttribute('aria-hidden', 'true');
        dot.className = 'state-dot';
        const text = document.createElement('span');
        tab.append(dot, text);
        tab.addEventListener('click', () => {
          closeActivePopover(document);
          options.onSelect(item.id);
        });
        tab.addEventListener('auxclick', (event) => {
          if (event.button === 1) {
            event.preventDefault();
            close(item.id);
          }
        });
        tab.addEventListener('mousedown', (event) => {
          if (event.button === 1) {
            event.preventDefault();
          }
        });
        list.append(tab);
        entry = { tab, text, dot };
        entries.set(item.id, entry);

        if (next.menuItems) {
          tab.setAttribute('aria-haspopup', 'menu');
          entry.menu = mountMenu(root, item.label, [], {
            trigger: tab,
            items: () => options.menuItems?.(item.id) || [],
          });
        }
      }

      const current = list.children[index];

      if (current !== entry.tab) {
        list.insertBefore(entry.tab, current || null);
      }

      entry.text.textContent = item.label;
      entry.tab.title = item.title || item.label;
      entry.dot.className = `state-dot dot-${item.status || 'idle'}`;
      entry.tab.classList.toggle('selected', next.selected === item.id);
      entry.tab.setAttribute('aria-selected', String(next.selected === item.id));
      let controls = 'mitter-task-view';

      if (next.kind === 'project') {
        controls = 'mitter-project-view';
      }

      entry.tab.setAttribute('aria-controls', controls);
    }

    list.hidden = !next.items.length;
    empty.hidden = next.items.length > 0;
    const selected = next.items.find((item) => item.id === next.selected);
    closeActive.hidden = !next.onClose || !selected;

    if (selected) {
      closeActive.title = 'Close ' + selected.label + ' tab (keeps work saved)';
      closeActive.setAttribute('aria-label', 'Close ' + selected.label + ' tab');
    }

    add.disabled = !!next.addDisabled || !next.canAdd;
    add.title = next.addLabel;
    add.setAttribute('aria-label', next.addLabel);
    all.hidden = !next.onList;
    all.title = next.listLabel || 'All ' + next.kind + 's';
    all.setAttribute('aria-label', all.title);

    if (!list.contains(document.activeElement) || selectionChanged) {
      resetRoving();
    }

    if (selectionChanged) {
      entries.get(next.selected)?.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      selectedBefore = next.selected;
    }

    if (
      (hadFocus && !list.contains(document.activeElement)) ||
      (closeHadFocus && (selectionChanged || closeActive.hidden))
    ) {
      (entries.get(next.selected)?.tab || add).focus({ preventScroll: true });
    }
  }

  function key(event: KeyboardEvent): void {
    if (!isElement(document, event.target)) {
      return;
    }

    const current = event.target.closest('[role=tab]');

    if (!(current instanceof window.HTMLButtonElement) || !list.contains(current)) {
      return;
    }

    if (event.key === 'Delete' && options.onClose) {
      const id = current.dataset.tabId;

      if (id !== undefined) {
        event.preventDefault();
        close(id);
      }

      return;
    }

    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }

    const enabled = Array.from(list.querySelectorAll('[role=tab]:not(:disabled)')).filter(
      (element): element is HTMLButtonElement => element instanceof window.HTMLButtonElement,
    );

    if (!enabled.length) {
      return;
    }

    event.preventDefault();
    const index = navigationIndex(event.key, enabled.indexOf(current), enabled.length);
    const target = enabled[index ?? -1];

    if (!target) {
      return;
    }

    for (const button of enabled) {
      button.tabIndex = -1;
    }

    target.tabIndex = 0;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  const leave = (event: FocusEvent) => {
    if (!isNode(document, event.relatedTarget) || !list.contains(event.relatedTarget)) {
      resetRoving();
    }
  };
  list.addEventListener('keydown', key);
  list.addEventListener('focusout', leave);
  update(initial);

  return {
    update,
    dispose() {
      for (const entry of entries.values()) {
        entry.menu?.dispose();
      }

      add.removeEventListener('click', addClick);
      all.removeEventListener('click', listClick);
      closeActive.removeEventListener('click', closeClick);
      list.removeEventListener('keydown', key);
      list.removeEventListener('focusout', leave);
      root.replaceChildren();
    },
  };
}
