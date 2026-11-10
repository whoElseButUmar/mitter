/** UI selection only. No worker state, chat link, approval or budget is mutated. */
import { SavedNavigationSchema } from './workspace/migrations.js';
import type { NavigationProject, NavigationState, NavigationTask } from './workspace/schemas.js';

export {
  NavigationProjectSchema,
  NavigationStateSchema,
  NavigationTaskSchema,
  type NavigationProject,
  type NavigationState,
  type NavigationTask,
} from './workspace/schemas.js';

export const WORKSPACE_NAV_KEY = 'mitter.workspaceNavigation.v1';

export function emptyNavigation(): NavigationState {
  return { version: 1, projectId: '', taskByProject: {} };
}

export function restoreNavigation(
  value: unknown,
  legacyWorker: unknown,
  projects: NavigationProject[],
  tasks: NavigationTask[],
): NavigationState {
  const next = emptyNavigation();
  const saved = SavedNavigationSchema.safeParse(value);

  if (saved.success) {
    next.projectId = saved.data.projectId;

    for (const [projectId, taskId] of Object.entries(saved.data.taskByProject)) {
      if (
        projects.some((project) => project.id === projectId) &&
        tasks.some((task) => task.id === taskId && task.projectId === projectId)
      ) {
        Object.defineProperty(next.taskByProject, projectId, {
          value: taskId,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  } else if (typeof legacyWorker === 'string') {
    const task = tasks.find((task) => task.id === legacyWorker);

    if (task) {
      next.projectId = task.projectId;
      Object.defineProperty(next.taskByProject, task.projectId, {
        value: task.id,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }

  return reconcileNavigation(next, projects, tasks);
}

export function reconcileNavigation(
  state: NavigationState,
  projects: NavigationProject[],
  tasks: NavigationTask[],
): NavigationState {
  const taskByProject: Record<string, string> = {};

  for (const project of projects) {
    const remembered = state.taskByProject[project.id];
    const task =
      tasks.find((task) => task.id === remembered && task.projectId === project.id) ||
      tasks.find((task) => task.projectId === project.id);

    if (task) {
      Object.defineProperty(taskByProject, project.id, {
        value: task.id,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }

  let projectId = state.projectId;

  if (!projects.some((project) => project.id === projectId)) {
    projectId = projects[0]?.id || '';
  }

  return { version: 1, projectId, taskByProject };
}

export function selectProject(
  state: NavigationState,
  id: string,
  projects: NavigationProject[],
  tasks: NavigationTask[],
): NavigationState {
  if (!projects.some((project) => project.id === id)) {
    return state;
  }

  return reconcileNavigation({ ...state, projectId: id }, projects, tasks);
}

export function selectTask(
  state: NavigationState,
  id: string,
  projects: NavigationProject[],
  tasks: NavigationTask[],
): NavigationState {
  const task = tasks.find((task) => task.id === id);

  if (!task || !projects.some((project) => project.id === task.projectId)) {
    return state;
  }

  return reconcileNavigation(
    {
      ...state,
      projectId: task.projectId,
      taskByProject: { ...state.taskByProject, [task.projectId]: id },
    },
    projects,
    tasks,
  );
}

export function activeTaskId(state: NavigationState): string {
  return state.taskByProject[state.projectId] || '';
}
