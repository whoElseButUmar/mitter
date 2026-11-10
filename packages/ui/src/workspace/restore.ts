import { restoreNavigation } from '../workspace-state.js';
import { dictionary } from './schemas.js';
import type { Catalog, WorkspaceState } from './schemas.js';
import { SavedWorkspaceStateSchema, SavedWorkspaceVersionSchema } from './migrations.js';

export const HISTORY_LIMIT = 200;

export function emptyWorkspace(): WorkspaceState {
  return {
    version: 2,
    revision: 0,
    projectId: '',
    taskByProject: dictionary(),
    openProjects: [],
    openTasks: dictionary(),
    knownProjects: [],
    knownTasks: [],
    recentlyClosed: [],
  };
}

export function currentTask(state: WorkspaceState): string {
  if (!state.projectId) {
    return '';
  }

  return state.taskByProject[state.projectId] || '';
}

export function restoreWorkspace(
  raw: unknown,
  legacy: unknown,
  selectedWorker: unknown,
  catalog: Catalog,
): WorkspaceState {
  const version = SavedWorkspaceVersionSchema.safeParse(raw);

  if (version.success && version.data.version > 2) {
    throw new Error(
      'Workspace was saved by a newer Mitter. Its tab history has not been overwritten. ' +
        'Update Mitter to open it.',
    );
  }

  const state = emptyWorkspace();
  const saved = SavedWorkspaceStateSchema.safeParse(raw);

  if (!saved.success) {
    const navigation = restoreNavigation(legacy, selectedWorker, catalog.projects, catalog.tasks);
    state.projectId = navigation.projectId;
    state.taskByProject = { ...navigation.taskByProject };
    return reconcileWorkspace(state, catalog);
  }

  const value = saved.data;
  state.revision = value.revision;
  state.projectId = value.projectId;
  state.openProjects = value.openProjects;
  state.knownProjects = value.knownProjects;
  state.knownTasks = value.knownTasks;

  for (const [projectId, tasks] of Object.entries(value.openTasks)) {
    state.openTasks[projectId] = tasks;
  }

  for (const [projectId, taskId] of Object.entries(value.taskByProject)) {
    state.taskByProject[projectId] = taskId;
  }

  for (const closed of value.recentlyClosed) {
    if (state.recentlyClosed.some((tab) => tab.kind === closed.kind && tab.id === closed.id)) {
      continue;
    }

    state.recentlyClosed.push({ ...closed, label: closed.label.slice(0, 300) });
  }

  state.recentlyClosed = state.recentlyClosed.slice(0, HISTORY_LIMIT);
  return reconcileWorkspace(state, catalog);
}

export function reconcileWorkspace(state: WorkspaceState, catalog: Catalog): WorkspaceState {
  const projectIds = new Set(catalog.projects.map((project) => project.id));
  const next: WorkspaceState = {
    ...state,
    openProjects: state.openProjects.filter((id) => projectIds.has(id)),
    openTasks: dictionary(),
    taskByProject: dictionary(),
    recentlyClosed: [...state.recentlyClosed],
  };
  const knownProjects = new Set(state.knownProjects);
  const knownTasks = new Set(state.knownTasks);

  for (const project of catalog.projects) {
    if (!knownProjects.has(project.id) && !next.openProjects.includes(project.id)) {
      next.openProjects.push(project.id);
    }

    const tasks = catalog.tasks.filter((task) => task.projectId === project.id);
    const taskIds = new Set(tasks.map((task) => task.id));
    const openTasks = (state.openTasks[project.id] || []).filter((id) => taskIds.has(id));

    for (const task of tasks) {
      if (!knownTasks.has(task.id) && !openTasks.includes(task.id)) {
        openTasks.push(task.id);
      }
    }

    next.openTasks[project.id] = openTasks;
    const remembered = state.taskByProject[project.id];

    if (remembered && openTasks.includes(remembered)) {
      next.taskByProject[project.id] = remembered;
    } else {
      next.taskByProject[project.id] = openTasks[0] || '';
    }
  }

  next.knownProjects = catalog.projects.map((project) => project.id);
  next.knownTasks = catalog.tasks.filter((task) => projectIds.has(task.projectId)).map((task) => task.id);

  if (!next.openProjects.includes(next.projectId)) {
    next.projectId = next.openProjects[0] || '';
  }

  return next;
}
