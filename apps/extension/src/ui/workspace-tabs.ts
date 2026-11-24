import { errorMessage } from '../schemas/primitives';
import { textResultSchema } from './rpc-results';
import { workspaceStateSchema } from '../schemas/messages';
import { callResult } from './rpc';
import { type RenameTarget } from './view-data';
import type { WorkspaceAction, TabKind } from '../../../../packages/ui/src/workspace';
import type { MenuItem } from '../../../../packages/ui/src/menu';
import { ToastCenter } from '../../../../packages/ui/src/toast';
import { createMemo, createSignal } from 'solid-js';
import type { Snapshot } from '../../../../packages/protocol/src/index';
import { displayTaskName } from '../../../../packages/protocol/src/task-brief';
import type { BridgeStatus } from '../../../../packages/bridge/src/index';
import { taskPresentation } from '../../../../packages/bridge/src/presentation';
import { type WorkspaceState } from '../../../../packages/ui/src/workspace';
import type { LibraryView, LibraryFilter } from '../../../../packages/ui/src/library';
import { closeActivePopover } from '../../../../packages/ui/src/popover';
import type { Accessor } from 'solid-js';
import type { Worker } from '../../../../packages/protocol/src/index';
import type { ViewRPC } from './rpc';
import { runningStates as running } from './task-view';

type LibrarySelection = {
  view: LibraryView;
  scope: string;
  filter: LibraryFilter;
};

type TabActionsDependencies = {
  snapshot: Accessor<Snapshot>;
  navigation: Accessor<WorkspaceState>;
  connected: Accessor<boolean>;
  bridges: Accessor<BridgeStatus[]>;
  projectWorkers: Accessor<Worker[]>;
  toasts: ToastCenter;
  rpc: ViewRPC;
  action: (method: string, params?: Record<string, unknown>) => Promise<void>;
  applyNavigation: (state: WorkspaceState) => void;
  setNotice: (message: string) => void;
  success: (message: string) => void;
  setModal: (modal: string) => void;
  newWorker: (projectId: string) => void;
  setView: (view: 'activity') => void;
  setTextValue: (text: string) => void;
};

export function createWorkspaceTabs(dependencies: TabActionsDependencies) {
  const [library, setLibrary] = createSignal<LibrarySelection>({
    view: 'projects',
    scope: '',
    filter: 'all',
  });
  const [renameTarget, setRenameTarget] = createSignal<(RenameTarget & { name: string }) | undefined>();
  const {
    snapshot,
    navigation,
    connected,
    bridges,
    projectWorkers,
    toasts,
    rpc,
    action,
    applyNavigation,
    setNotice,
    success,
    setModal,
    newWorker,
    setView,
    setTextValue,
  } = dependencies;
  const navigate = async (event: WorkspaceAction) => {
    try {
      const next = await callResult(rpc, workspaceStateSchema, 'workspace.action', {
        action: event,
      });
      applyNavigation(next);
      return next;
    } catch (error) {
      setNotice(errorMessage(error));
      return undefined;
    }
  };

  const chooseProject = (id: string) =>
    void navigate({
      type: 'open',
      kind: 'project',
      id,
    });

  const choose = (id: string) =>
    void navigate({
      type: 'open',
      kind: 'task',
      id,
    });

  const openLibrary = (view: LibraryView, scope = navigation().projectId, filter: LibraryFilter = 'all') => {
    closeActivePopover(document);
    setLibrary({ view, scope, filter });
    setModal('library');
  };

  const closeTabs = async (event: WorkspaceAction) => {
    const before = navigation().recentlyClosed.map((closedTab) => closedTab.key);
    const next = await navigate(event);
    if (!next) {
      return;
    }
    const added = next.recentlyClosed.filter((closedTab) => !before.includes(closedTab.key));
    const firstClosed = added[0];
    if (firstClosed) {
      const group = firstClosed.group;
      let message = 'Closed ' + added.length + ' tabs. Running tasks continue.';
      if (added.length === 1) {
        message = 'Closed “' + firstClosed.label + '”. Work is kept.';
      }

      toasts.push({
        message,
        kind: 'info',
        key: 'closed:' + group,
        duration: 8000,
        action: {
          label: 'Undo',
          run: async () => {
            const restored = await callResult(rpc, workspaceStateSchema, 'workspace.action', {
              action: {
                type: 'restoreGroup',
                group,
              },
            });
            applyNavigation(restored);
            success('Tabs restored.');
          },
        },
      });
    }
  };

  const restore = (event: WorkspaceAction) =>
    void navigate(event).then((next) => {
      if (next) {
        success('Tabs restored.');
      }
    });

  const rename = (kind: TabKind, id: string) => {
    let value: string | undefined;
    if (kind === 'project') {
      value = snapshot().projects.find((projectEntry) => projectEntry.id === id)?.name;
    } else {
      value = snapshot().workers.find((task) => task.id === id)?.name;
    }
    if (!value) {
      return;
    }
    setRenameTarget({ kind, id, name: value });
    setModal('rename');
  };

  const menuItems = (kind: TabKind, id: string): MenuItem[] => {
    let task: Worker | undefined;
    if (kind === 'task') {
      task = snapshot().workers.find((workerEntry) => workerEntry.id === id);
    }

    let projectId: string;
    let openTabs: string[];
    if (kind === 'project') {
      projectId = id;
      openTabs = navigation().openProjects;
    } else {
      projectId = task?.projectId || '';
      openTabs = navigation().openTasks[projectId] || [];
    }

    const isOpen = openTabs.includes(id);
    const online = connected();
    const items: MenuItem[] = [];

    if (kind === 'project') {
      items.push(
        {
          id: 'new-task',
          label: 'New task…',
          disabled: !online,
          run: () => newWorker(id),
        },
        {
          id: 'folder',
          label: 'Open folder',
          disabled: !online,
          run: () => void action('project.reveal', { projectId: id }),
        },
        {
          id: 'tasks',
          label: 'All project tasks…',
          run: () => openLibrary('tasks', id),
        },
      );
    } else {
      items.push(
        {
          id: 'chat',
          label: 'Open linked chat',
          disabled: !online || task?.mode !== 'handoff',
          run: () => void action('bridge.openChat', { workerId: id }),
        },
        {
          id: 'activity',
          label: 'View task history',
          run: () => {
            void navigate({ type: 'open', kind, id }).then(() => {
              setModal('');
              setView('activity');
            });
          },
        },
        {
          id: 'report',
          label: 'View full report…',
          disabled: !online,
          run: () => {
            void callResult(rpc, textResultSchema, 'worker.report', {
              workerId: id,
            })
              .then((text) => {
                setTextValue(text);
                setModal('report');
              })
              .catch((event) => setNotice(errorMessage(event)));
          },
        },
      );
    }

    let editLabel = 'Rename project…';
    if (kind === 'task') {
      editLabel = 'Edit task…';
    }
    items.push({
      id: 'rename',
      label: editLabel,
      disabled: !online,
      run: () => rename(kind, id),
    });

    if (!isOpen) {
      items.push({
        id: 'open-tab',
        label: 'Open tab',
        separatorBefore: true,
        run: () => {
          void navigate({ type: 'open', kind, id }).then(() => setModal(''));
        },
      });
    } else {
      items.push(
        {
          id: 'close',
          label: 'Close tab',
          shortcut: 'Delete',
          separatorBefore: true,
          run: () => void closeTabs({ type: 'close', kind, id }),
        },
        {
          id: 'others',
          label: 'Close other ' + kind + ' tabs',
          disabled: openTabs.length < 2,
          run: () => void closeTabs({ type: 'closeOthers', kind, id }),
        },
        {
          id: 'right',
          label: 'Close tabs to the right',
          disabled: openTabs.indexOf(id) === openTabs.length - 1,
          run: () => void closeTabs({ type: 'closeRight', kind, id }),
        },
        {
          id: 'all',
          label: 'Close all ' + kind + ' tabs',
          run: () => void closeTabs({ type: 'closeAll', kind, projectId }),
        },
      );
    }

    items.push(
      {
        id: 'restore',
        label: 'Reopen closed ' + kind + ' tab',
        separatorBefore: true,
        disabled: !navigation().recentlyClosed.some(
          (closedTab) => closedTab.kind === kind && (kind === 'project' || closedTab.projectId === projectId),
        ),
        run: () => {
          if (kind === 'task') {
            restore({ type: 'restoreLast', kind, projectId });
            return;
          }

          restore({ type: 'restoreLast', kind });
        },
      },
      {
        id: 'history',
        label: 'Recently closed…',
        run: () => {
          if (kind === 'task') {
            openLibrary('history', projectId);
            return;
          }

          openLibrary('history', '');
        },
      },
    );

    return items;
  };

  const allProjectTabs = createMemo(() =>
    snapshot().projects.map((projectEntry) => {
      const states = snapshot()
        .workers.filter((task) => task.projectId === projectEntry.id)
        .map(
          (task) =>
            taskPresentation(
              task,
              bridges().find((bridgeStatus) => bridgeStatus.workerId === task.id),
            ).status,
        );
      let status = states.find((state) =>
        ['working', 'connecting', 'reconnecting', 'needs_approval'].includes(state),
      );
      if (!status) {
        if (states.length > 0 && states.every((state) => state === 'complete')) {
          status = 'complete';
        } else {
          status = 'idle';
        }
      }
      return {
        id: projectEntry.id,
        label: projectEntry.name,
        title: projectEntry.root,
        status,
      };
    }),
  );

  const projectTabs = createMemo(() =>
    navigation().openProjects.flatMap((id) => {
      const projectEntry = allProjectTabs().find((tab) => tab.id === id);
      if (projectEntry) {
        return [projectEntry];
      }

      return [];
    }),
  );

  const taskTabs = createMemo(() =>
    (navigation().openTasks[navigation().projectId] || []).flatMap((id) => {
      const task = projectWorkers().find((workerEntry) => workerEntry.id === id);
      if (!task) {
        return [];
      }

      return [
        {
          id: task.id,
          label: displayTaskName(task),
          title: displayTaskName(task),
        },
      ];
    }),
  );

  const activeCount = createMemo(
    () =>
      snapshot().workers.filter(
        (task) =>
          running.has(task.state) ||
          bridges().some((bridgeStatus) => bridgeStatus.workerId === task.id && bridgeStatus.active),
      ).length,
  );

  return {
    library,
    renameTarget,
    navigate,
    chooseProject,
    choose,
    openLibrary,
    closeTabs,
    restore,
    rename,
    menuItems,
    allProjectTabs,
    projectTabs,
    taskTabs,
    activeCount,
  };
}
