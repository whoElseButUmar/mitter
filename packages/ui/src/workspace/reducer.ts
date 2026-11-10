import { StorageValuesSchema, TabKindSchema, WorkspaceActionSchema } from './schemas.js';
import type { Catalog, ClosedTab, TabKind, WorkspaceAction, WorkspaceState } from './schemas.js';
import { HISTORY_LIMIT, reconcileWorkspace } from './restore.js';

export function validateWorkspaceAction(value: unknown): WorkspaceAction {
  const record = StorageValuesSchema.safeParse(value);

  if (!record.success || typeof record.data.type !== 'string') {
    throw new Error('Invalid workspace action.');
  }

  const actionType = record.data.type;
  const action = { ...record.data };
  const requiredStrings: Record<string, string[]> = {
    open: ['id'],
    close: ['id'],
    closeOthers: ['id'],
    closeRight: ['id'],
    closeAll: [],
    restore: ['key'],
    restoreLast: [],
    restoreGroup: ['group'],
    clearHistory: [],
  };
  const keys = requiredStrings[actionType];

  if (!Object.hasOwn(requiredStrings, actionType) || !keys) {
    throw new Error('Unknown workspace action.');
  }

  if (
    ['open', 'close', 'closeOthers', 'closeRight', 'closeAll'].includes(actionType) ||
    (action.type === 'restoreLast' && action.kind)
  ) {
    if (!TabKindSchema.safeParse(action.kind).success) {
      throw new Error('Invalid tab kind.');
    }
  }

  if (action.type === 'closeAll' || action.type === 'restoreLast') {
    if (action.projectId) {
      keys.push('projectId');
    } else {
      delete action.projectId;
    }
  }

  if (action.type === 'restoreLast' && !action.kind) {
    delete action.kind;
  }

  for (const key of keys) {
    const identifier = action[key];

    if (typeof identifier !== 'string' || !identifier || identifier.length > 300) {
      throw new Error('Invalid workspace ' + key + '.');
    }
  }

  return WorkspaceActionSchema.parse(action);
}

export function reduceWorkspace(
  state: WorkspaceState,
  action: WorkspaceAction,
  catalog: Catalog,
  now = Date.now(),
  group = String(now),
): WorkspaceState {
  const next = reconcileWorkspace(state, catalog);

  function list(kind: TabKind, projectId = ''): string[] {
    if (kind === 'project') {
      return next.openProjects;
    }

    return next.openTasks[projectId] || [];
  }

  function owner(kind: TabKind, id: string): string | undefined {
    if (kind === 'project') {
      return catalog.projects.find((project) => project.id === id)?.id;
    }

    return catalog.tasks.find((task) => task.id === id)?.projectId;
  }

  function available(tab: ClosedTab): boolean {
    if (tab.kind === 'project') {
      return catalog.projects.some((project) => project.id === tab.id);
    }

    return (
      catalog.tasks.some((task) => task.id === tab.id && task.projectId === tab.projectId) &&
      catalog.projects.some((project) => project.id === tab.projectId)
    );
  }

  function open(kind: TabKind, id: string, index?: number): void {
    const projectId = owner(kind, id);

    if (!projectId || !catalog.projects.some((project) => project.id === projectId)) {
      return;
    }

    if (!next.openProjects.includes(projectId)) {
      next.openProjects.push(projectId);
    }

    const ids = list(kind, projectId);
    let insertion = ids.length;

    if (index !== undefined) {
      insertion = Math.min(index, ids.length);
    }

    if (!ids.includes(id)) {
      ids.splice(insertion, 0, id);
    } else if (kind === 'project' && index !== undefined) {
      ids.splice(ids.indexOf(id), 1);
      ids.splice(Math.min(index, ids.length), 0, id);
    }

    next.projectId = projectId;

    if (kind === 'task') {
      next.taskByProject[projectId] = id;
    }

    next.recentlyClosed = next.recentlyClosed.filter(
      (tab) => !(tab.kind === kind && tab.id === id) && !(tab.kind === 'project' && tab.id === projectId),
    );
  }

  function closeMany(kind: TabKind, ids: string[]): void {
    const indices = new Map(ids.map((id) => [id, list(kind, owner(kind, id) || '').indexOf(id)]));
    let selectedBefore = Object.values(next.taskByProject);

    if (kind === 'project') {
      selectedBefore = [next.projectId];
    }

    for (const id of ids) {
      const projectId = owner(kind, id);

      if (!projectId) {
        continue;
      }

      const row = list(kind, projectId);
      const index = row.indexOf(id);

      if (index < 0) {
        continue;
      }

      let label = catalog.tasks.find((task) => task.id === id)?.name || id;

      if (kind === 'project') {
        label = catalog.projects.find((project) => project.id === id)?.name || id;
      }

      next.recentlyClosed = next.recentlyClosed.filter((tab) => !(tab.kind === kind && tab.id === id));
      next.recentlyClosed.unshift({
        key: group + ':' + kind + ':' + id,
        group,
        kind,
        id,
        projectId,
        label,
        index: indices.get(id) ?? index,
        closedAt: now,
        wasSelected: selectedBefore.includes(id),
      });
      row.splice(index, 1);

      if (kind === 'project' && next.projectId === id) {
        next.projectId = row[Math.min(index, row.length - 1)] || '';
      }

      if (kind === 'task' && next.taskByProject[projectId] === id) {
        next.taskByProject[projectId] = row[Math.min(index, row.length - 1)] || '';
      }
    }

    next.recentlyClosed = next.recentlyClosed.slice(0, HISTORY_LIMIT);
  }

  switch (action.type) {
    case 'open': {
      open(action.kind, action.id);
      break;
    }
    case 'close': {
      closeMany(action.kind, [action.id]);
      break;
    }
    case 'closeOthers':
    case 'closeRight': {
      const projectId = owner(action.kind, action.id);

      if (!projectId) {
        break;
      }

      const row = list(action.kind, projectId);

      if (!row.includes(action.id)) {
        break;
      }

      let closing = row.slice(row.indexOf(action.id) + 1);

      if (action.type === 'closeOthers') {
        closing = row.filter((id) => id !== action.id);
      }

      closeMany(action.kind, closing);
      break;
    }
    case 'closeAll': {
      closeMany(action.kind, [...list(action.kind, action.projectId || next.projectId)]);
      break;
    }
    case 'restore': {
      const tab = next.recentlyClosed.find((tab) => tab.key === action.key);

      if (tab && available(tab)) {
        open(tab.kind, tab.id, tab.index);
      }

      break;
    }
    case 'restoreLast': {
      const tab = next.recentlyClosed.find(
        (tab) =>
          (!action.kind || tab.kind === action.kind) &&
          (!action.projectId || tab.projectId === action.projectId) &&
          available(tab),
      );

      if (tab) {
        open(tab.kind, tab.id, tab.index);
      }

      break;
    }
    case 'restoreGroup': {
      const tabs = next.recentlyClosed
        .filter((tab) => tab.group === action.group && available(tab))
        .reverse();

      for (const tab of tabs) {
        open(tab.kind, tab.id, tab.index);
      }

      const selected = tabs.find((tab) => tab.wasSelected);

      if (selected) {
        open(selected.kind, selected.id);
      }

      break;
    }
    case 'clearHistory': {
      next.recentlyClosed = [];
      break;
    }
  }

  return next;
}
