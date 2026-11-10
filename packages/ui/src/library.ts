import { mountMenu, type MenuItem, type MenuHandle } from './menu.js';
import { enhanceSelect } from './select.js';
import type { TabKind } from './workspace.js';
import { isHTMLElement, requireWindow } from './dom/elements.js';
import { navigationIndex } from './native/keyboard.js';
import { LibraryFilterSchema, libraryRows, type LibraryData, type LibraryView } from './library/rows.js';

export {
  LibraryFilterSchema,
  LibraryViewSchema,
  LibraryRecordSchema,
  LibraryDataSchema,
  type LibraryFilter,
  type LibraryView,
  type LibraryRecord,
} from './library/rows.js';

export type LibraryOptions = LibraryData & {
  open(kind: TabKind, id: string): void;
  restore(key: string): void;
  clearHistory(): Promise<unknown>;
  menu(kind: TabKind, id: string): MenuItem[];
};

/** Closed tabs are views of retained records; opening a row never runs a task. */
export function mountLibrary(root: HTMLElement, initial: LibraryOptions) {
  const document = root.ownerDocument;
  const window = requireWindow(document);
  let options = initial;
  let view = initial.view;
  let scope = initial.scopeProjectId;
  let filter = initial.initialFilter || 'all';
  let query = '';
  let lastShape = '';
  let externalView = initial.view;
  let externalScope = initial.scopeProjectId;
  let externalFilter = initial.initialFilter || 'all';
  const menus: MenuHandle[] = [];
  let disposed = false;
  root.className = 'workspace-library';
  const tabs = document.createElement('div');
  tabs.className = 'library-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Workspace lists');
  const buttons = new Map<LibraryView, HTMLButtonElement>();

  for (const [id, label] of [
    ['projects', 'Projects'],
    ['tasks', 'Tasks'],
    ['history', 'Recently closed'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('role', 'tab');
    button.id = 'library-tab-' + id;
    button.addEventListener('click', () => {
      view = id;
      filter = 'all';
      filterSelect.value = 'all';
      filterControl.refresh();
      render();
    });
    tabs.append(button);
    buttons.set(id, button);
  }

  const tabKey = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const controls = [...buttons.values()];
    const current = controls.findIndex((button) => button === document.activeElement);
    const index = navigationIndex(event.key, current, controls.length);
    const target = controls[index ?? -1];
    target?.click();
    target?.focus();
  };
  tabs.addEventListener('keydown', tabKey);
  const tools = document.createElement('div');
  tools.className = 'library-search-row';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search projects';
  input.setAttribute('aria-label', 'Search workspace');
  input.autocomplete = 'off';
  const searchChanged = () => {
    query = input.value;
    renderList();
  };
  input.addEventListener('input', searchChanged);
  const filterSelect = document.createElement('select');
  filterSelect.setAttribute('aria-label', 'Filter list');
  filterSelect.innerHTML =
    '<option value="all">All</option><option value="open">Open tabs</option>' +
    '<option value="closed">Closed tabs</option><option value="active">Working</option>' +
    '<option value="attention">Needs attention</option><option value="complete">Complete</option>';
  filterSelect.value = filter;
  const filterRoot = document.createElement('div');
  filterRoot.className = 'library-filter';
  filterRoot.append(filterSelect);
  tools.append(input, filterRoot);
  const scopeRow = document.createElement('div');
  scopeRow.className = 'library-scope';
  const allProjects = document.createElement('button');
  allProjects.type = 'button';
  allProjects.className = 'text-button';
  const scopeClick = () => {
    if (scope) {
      scope = '';
    } else {
      scope = options.scopeProjectId;
    }

    render();
  };
  allProjects.addEventListener('click', scopeClick);
  const count = document.createElement('span');
  count.className = 'muted small';
  scopeRow.append(count, allProjects);
  const panel = document.createElement('div');
  panel.className = 'library-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'library-results';
  const list = document.createElement('ul');
  list.className = 'library-list';
  const empty = document.createElement('p');
  empty.className = 'library-empty';
  panel.append(list, empty);
  const foot = document.createElement('div');
  foot.className = 'library-foot';
  const hint = document.createElement('span');
  hint.textContent = 'Closing a tab keeps its work saved. Running tasks continue.';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = 'Clear list…';
  clear.className = 'text-button';
  const confirmation = document.createElement('div');
  confirmation.className = 'history-confirm';
  confirmation.hidden = true;
  confirmation.setAttribute('role', 'alert');
  const message = document.createElement('span');
  message.textContent = 'Clear all recently closed tabs? Projects, tasks and files are kept.';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Keep history';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.textContent = 'Clear history';
  confirmation.append(message, cancel, confirm);
  const clearClick = () => {
    confirmation.hidden = false;
    cancel.focus();
  };
  const cancelClick = () => {
    confirmation.hidden = true;
    clear.focus();
  };
  const confirmClick = async () => {
    confirm.disabled = true;

    try {
      await options.clearHistory();

      if (!disposed) {
        confirmation.hidden = true;
        input.focus();
      }
    } catch (reason) {
      if (!disposed) {
        message.textContent = 'Could not clear history: ' + String(reason);
      }
    } finally {
      if (!disposed) {
        confirm.disabled = false;
      }
    }
  };
  clear.addEventListener('click', clearClick);
  cancel.addEventListener('click', cancelClick);
  confirm.addEventListener('click', confirmClick);
  foot.append(hint, clear);
  root.append(tabs, tools, scopeRow, panel, confirmation, foot);
  const filterControl = enhanceSelect(filterSelect);
  const filterChanged = () => {
    const result = LibraryFilterSchema.safeParse(filterSelect.value);

    if (result.success) {
      filter = result.data;
      renderList();
    }
  };
  filterSelect.addEventListener('change', filterChanged);

  function render(): void {
    for (const [id, button] of buttons) {
      button.setAttribute('aria-selected', String(id === view));
      button.tabIndex = -1;

      if (id === view) {
        button.tabIndex = 0;
      }

      button.classList.toggle('selected', id === view);
      button.setAttribute('aria-controls', panel.id);
    }

    panel.setAttribute('aria-labelledby', 'library-tab-' + view);
    input.placeholder = 'Search projects and folders';

    if (view === 'history') {
      input.placeholder = 'Search recently closed';
    } else if (view === 'tasks') {
      input.placeholder = 'Search tasks and goals';
    }

    filterRoot.hidden = view === 'history';
    allProjects.hidden = view === 'projects' || !options.scopeProjectId;
    const project = options.projects.find((project) => project.id === scope);
    allProjects.textContent =
      options.projects.find((project) => project.id === options.scopeProjectId)?.label + ' only';

    if (scope) {
      allProjects.textContent = 'Show all projects';
    }

    if (!project && scope) {
      scope = '';
    }

    clear.hidden = view !== 'history';
    confirmation.hidden = true;
    renderList();
  }

  function disposeMenus(): void {
    for (const menu of menus) {
      menu.dispose();
    }

    menus.length = 0;
  }

  function renderList(): void {
    const rows = libraryRows(options, view, scope, filter, query);
    let scopeName = '';

    if (view !== 'projects' && scope) {
      scopeName = options.projects.find((project) => project.id === scope)?.label || '';
    }

    let noun = 'task';

    if (view === 'projects') {
      noun = 'project';
    } else if (view === 'history') {
      noun = 'closed tab';
    }

    count.textContent = rows.length + ' ' + noun;

    if (rows.length !== 1) {
      count.textContent += 's';
    }

    if (scopeName) {
      count.textContent += ' in ' + scopeName;
    }

    clear.disabled = !options.state.recentlyClosed.length;
    const shape = JSON.stringify([view, rows]);

    if (shape === lastShape) {
      return;
    }

    lastShape = shape;
    let focused: string | undefined;

    if (isHTMLElement(document, document.activeElement)) {
      const row = document.activeElement.closest('[data-library-key]');

      if (row instanceof window.HTMLElement) {
        focused = row.dataset.libraryKey;
      }
    }

    const scroll = panel.scrollTop;

    disposeMenus();
    list.replaceChildren();

    for (const row of rows) {
      const item = document.createElement('li');
      item.className = 'library-row';
      item.dataset.libraryKey = row.key;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'library-open';
      button.dataset.libraryKey = row.key;
      button.disabled = !row.available;
      let action = 'Open ';

      if (view === 'history') {
        action = 'Restore ';
      }

      button.setAttribute('aria-label', action + row.label);

      if (row.selected) {
        button.setAttribute('aria-current', 'true');
      }

      const dot = document.createElement('i');
      dot.className = 'state-dot dot-' + row.status;
      dot.setAttribute('aria-hidden', 'true');
      const body = document.createElement('span');
      body.className = 'library-item-body';
      const title = document.createElement('strong');
      title.textContent = row.label;
      const subtitle = document.createElement('small');
      subtitle.textContent = row.subtitle;
      body.append(title, subtitle);
      const detail = document.createElement('span');
      detail.className = 'library-item-detail';
      detail.textContent = row.status.replaceAll('_', ' ');

      if (view === 'history') {
        detail.textContent = 'Restore';
      } else if (row.opened) {
        detail.textContent = 'Open tab';
      } else if (row.status === 'idle') {
        detail.textContent = 'Saved';
      }

      if (row.stamp) {
        const time = document.createElement('time');
        const date = new Date(row.stamp);
        time.dateTime = date.toISOString();
        time.title = date.toLocaleString();
        time.textContent = date.toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        });
        detail.append(time);
      }

      button.append(dot, body, detail);
      button.addEventListener('click', () => {
        if (view === 'history') {
          options.restore(row.key);
        } else {
          options.open(row.kind, row.id);
        }
      });
      item.append(button);
      list.append(item);

      if (view !== 'history') {
        const menu = mountMenu(item, row.label, [], {
          trigger: button,
          items: () => options.menu(row.kind, row.id),
        });
        menus.push(menu);
        const more = document.createElement('div');
        more.className = 'library-more';
        item.append(more);
        const visible = mountMenu(more, '…', options.menu(row.kind, row.id));
        visible.trigger.setAttribute('aria-label', 'Actions for ' + row.label);
        menus.push(visible);
      }
    }

    empty.hidden = rows.length > 0;
    empty.textContent = 'No tasks in this list.';

    if (query) {
      empty.textContent = 'No matches. Try another name.';
    } else if (view === 'history') {
      empty.textContent = 'No recently closed tabs.';
    } else if (view === 'projects') {
      empty.textContent = 'No projects in this list.';
    }

    panel.scrollTop = scroll;

    if (focused) {
      const target = Array.from(list.querySelectorAll('button.library-open')).find(
        (button) => button instanceof window.HTMLButtonElement && button.dataset.libraryKey === focused,
      );

      if (target instanceof window.HTMLButtonElement) {
        target.focus({ preventScroll: true });
      } else {
        input.focus({ preventScroll: true });
      }
    }
  }

  const move = (event: KeyboardEvent) => {
    const controls = Array.from(list.querySelectorAll('button.library-open:not(:disabled)')).filter(
      (element): element is HTMLButtonElement => element instanceof window.HTMLButtonElement,
    );

    if (!controls.length) {
      return;
    }

    const current = controls.findIndex((button) => button === document.activeElement);

    if (
      (event.target === input && event.key === 'ArrowDown') ||
      (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && current >= 0)
    ) {
      event.preventDefault();
      let index = navigationIndex(event.key, current, controls.length);

      if (event.target === input) {
        index = 0;
      }

      controls[index ?? -1]?.focus();
    }
  };
  root.addEventListener('keydown', move);
  render();
  queueMicrotask(() => {
    if (!disposed && root.isConnected) {
      input.focus();
    }
  });

  return {
    update(next: LibraryOptions) {
      options = next;

      if (
        next.view !== externalView ||
        next.scopeProjectId !== externalScope ||
        (next.initialFilter || 'all') !== externalFilter
      ) {
        view = next.view;
        scope = next.scopeProjectId;
        externalView = next.view;
        externalScope = next.scopeProjectId;
        externalFilter = next.initialFilter || 'all';
        filter = externalFilter;
        filterSelect.value = filter;
        filterControl.refresh();
        render();
      } else {
        renderList();
      }
    },
    dispose() {
      disposed = true;

      disposeMenus();

      filterControl.dispose();
      tabs.removeEventListener('keydown', tabKey);
      input.removeEventListener('input', searchChanged);
      allProjects.removeEventListener('click', scopeClick);
      clear.removeEventListener('click', clearClick);
      cancel.removeEventListener('click', cancelClick);
      confirm.removeEventListener('click', confirmClick);
      filterSelect.removeEventListener('change', filterChanged);
      root.removeEventListener('keydown', move);
      root.replaceChildren();
    },
  };
}
