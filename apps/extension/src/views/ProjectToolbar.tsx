import { runningStates as running } from '../ui/task-view';
import { errorMessage } from '../schemas/primitives';
import { syntaxResultSchema } from '../ui/rpc-results';
import { callResult } from '../ui/rpc';
import { type WorkspaceController } from '../ui/workspace-controller';
import { Icon } from '../icons';
import { MenuButton } from '../controls';
import type { Project } from '../../../../packages/protocol/src/index';

export function ProjectToolbar(props: { controller: WorkspaceController; project: Project }) {
  const {
    connected,
    selected,
    setNotice,
    setModal,
    setTextValue,
    output,
    useReply,
    worker,
    bridge,
    tabs,
    rpc,
    action,

    showFollowups,

    showNotifications,
    showText,
    confirmAction,
  } = props.controller;
  const { openLibrary, closeTabs, rename, taskTabs } = tabs;
  const { file, browseFiles } = output;
  const projectEntry = () => props.project;
  return (
    <div class="task-toolbar">
      <span class="project-title" title={projectEntry().root}>
        <Icon name="folder" size={15} />
        {projectEntry().name}
      </span>
      <div class="spacer" />
      <button
        title="Show project in file manager"
        disabled={!connected()}
        onClick={() => {
          const task = worker();
          if (task) {
            return action('worker.reveal', {
              workerId: task.id,
            });
          }
          return action('project.reveal', {
            projectId: projectEntry().id,
          });
        }}
      >
        <Icon name="folder" size={14} />
        <span class="wide-label">Open folder</span>
      </button>
      <MenuButton
        label="Tools"
        disabled={!connected()}
        items={[
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
            id: 'files',
            label: 'Browse workspace files…',
            disabled: !worker(),
            run: () => void browseFiles(),
          },
          {
            id: 'notifications',
            label: 'Notifications…',
            run: () => void showNotifications(),
          },
          {
            id: 'followups',
            label: 'Follow-up history…',
            disabled: !worker(),
            run: () => void showFollowups(),
          },
          {
            id: 'profiles',
            label: 'Command profiles…',
            run: () => setModal('profile'),
          },
          {
            id: 'models',
            label: 'Settings…',
            run: () => setModal('settings'),
          },
          {
            id: 'health',
            label: 'Connection & health…',
            run: () => setModal('health'),
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
            run: () => {
              void callResult(rpc, syntaxResultSchema, 'worker.syntax', {
                workerId: selected(),
                path: file(),
              })
                .then((result) => {
                  let summary = 'Syntax check failed.';
                  if (result.ok) {
                    summary = 'Syntax check passed.';
                  }

                  setTextValue(summary + '\n' + result.scope + '\n' + result.details);
                  setModal('report');
                })
                .catch((event) => setNotice(errorMessage(event)));
            },
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
              confirmAction(
                'worker.cancel',
                'Stop this task and clear its queue? Existing edits will remain.',
              ),
          },
        ]}
      />
    </div>
  );
}
