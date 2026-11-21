import { runningStates as running } from '../ui/task-view';
import { type WorkspaceController } from '../ui/workspace-controller';
import { MenuButton } from '../controls';
import type { MenuItem } from '../../../../packages/ui/src/menu';
import type { Project } from '../../../../packages/protocol/src/index';

export function ProjectToolbar(props: { controller: WorkspaceController; project: Project }) {
  const {
    connected,
    setModal,
    output,
    useReply,
    worker,
    bridge,
    tabs,
    action,

    showFollowups,

    showNotifications,
    showText,
    checkSelectedSyntax,
    confirmAction,
  } = props.controller;
  const { openLibrary, closeTabs, rename, taskTabs } = tabs;
  const { file, browseFiles } = output;
  const projectEntry = () => props.project;
  const items = (): MenuItem[] => {
    const projectItems: MenuItem[] = [
      {
        id: 'open-folder',
        label: 'Open folder',
        run: () => {
          const task = worker();
          if (task) {
            return action('worker.reveal', { workerId: task.id });
          }
          return action('project.reveal', { projectId: projectEntry().id });
        },
      },
      {
        id: 'task-list',
        label: 'All project tasks…',
        run: () => openLibrary('tasks'),
      },
      {
        id: 'history',
        label: 'Recently closed…',
        run: () => openLibrary('history'),
      },
      {
        id: 'rename',
        label: 'Rename project…',
        run: () => rename('project', projectEntry().id),
      },
      {
        id: 'close-all',
        label: 'Close all task tabs',
        disabled: !taskTabs().length,
        run: () =>
          void closeTabs({
            type: 'closeAll',
            kind: 'task',
            projectId: projectEntry().id,
          }),
      },
      {
        id: 'context',
        label: 'Project context…',
        run: () => setModal('context'),
      },
      {
        id: 'profiles',
        label: 'Test commands…',
        run: () => setModal('profile'),
      },
      {
        id: 'notifications',
        label: 'Notifications…',
        run: () => void showNotifications(),
      },
    ];
    if (!worker()) {
      return projectItems;
    }
    const taskItems: MenuItem[] = [
      {
        id: 'files',
        label: 'Open files',
        run: () => void browseFiles(),
      },
      {
        id: 'followups',
        label: 'Follow-up history…',
        run: () => void showFollowups(),
      },
      {
        id: 'changes',
        label: 'Review file changes…',
        disabled: !worker(),
        run: () => setModal('changes'),
      },
      {
        id: 'syntax',
        label: 'Check selected JavaScript syntax',
        disabled: !worker() || !file() || !/\.(js|mjs|cjs)$/.test(file()),
        run: () => void checkSelectedSyntax(),
      },
      {
        id: 'report',
        label: 'View full report…',
        disabled: !worker(),
        separatorBefore: true,
        run: () => void showText('report'),
      },
      {
        id: 'use-reply',
        label: 'Use reply from chat…',
        disabled:
          !worker() ||
          worker()?.mode !== 'handoff' ||
          !!bridge()?.active ||
          running.has(worker()?.state || '') ||
          ['complete', 'cancelled'].includes(worker()?.state || ''),
        run: useReply,
      },
      {
        id: 'manual',
        label: 'Manual handoff…',
        disabled: !worker(),
        run: () => setModal('manual'),
      },
      {
        id: 'rollback',
        label: 'Roll back file edits…',
        separatorBefore: true,
        disabled: !worker() || running.has(worker()?.state || '') || !!bridge()?.active,
        run: () =>
          confirmAction(
            'worker.rollback',
            'Restore Miter’s file edits? Later changes may block rollback. Command side effects are not undone.',
          ),
      },
      {
        id: 'cancel',
        label: 'Cancel task…',
        danger: true,
        disabled: !worker() || ['complete', 'cancelled'].includes(worker()?.state || ''),
        run: () =>
          confirmAction('worker.cancel', 'Stop this task and clear its queue? Existing edits will remain.'),
      },
    ];
    return [...projectItems, ...taskItems];
  };

  return (
    <div class="project-actions">
      <MenuButton label="Actions" disabled={!connected()} items={items()} />
    </div>
  );
}
