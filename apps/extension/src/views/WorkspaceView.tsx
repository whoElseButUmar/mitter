import { ProjectToolbar } from './ProjectToolbar';
import { errorMessage } from '../schemas/primitives';
import type { JSX } from 'solid-js';
import { welcomeCopy } from '../ui/task-view';
import { type WorkspaceController } from '../ui/workspace-controller';
import { lazy, Show } from 'solid-js';
import { displayTaskName } from '../../../../packages/protocol/src/task-brief';
import { APP_VERSION } from '../../../../packages/protocol/src/index';
import { Icon, Mark } from '../icons';
import { DebugConsole } from '../DebugConsole';
import { WorkspaceTabRow } from '../controls';
import { tabId } from '../../../../packages/ui/src/tab-row';
import { TaskView } from './TaskView';

const TerminalDock = lazy(() =>
  import('../TerminalDock').then((module) => ({
    default: module.TerminalDock,
  })),
);

export function WorkspaceView(props: { controller: WorkspaceController; children?: JSX.Element }) {
  const {
    snapshot,
    navigation,
    connected,
    connectionError,
    selected,
    success,
    info,
    setNotice,
    setModal,
    terminalOpen,
    setTerminalOpen,
    terminalMounted,
    toggleTerminal,
    debugOpen,
    setDebugOpen,
    logs,
    client,
    worker,
    project,
    projectWorkers,
    tabs,
    rpc,
    copy,
    newWorker,
  } = props.controller;
  const { chooseProject, choose, openLibrary, closeTabs, menuItems, projectTabs, taskTabs, activeCount } =
    tabs;
  const welcome = () => welcomeCopy(project(), projectWorkers().length, snapshot().projects.length);

  const projectPanelLabel = () => {
    const currentProject = project();

    if (currentProject) {
      return tabId('project', currentProject.id);
    }

    return undefined;
  };

  const taskPanelLabel = () => {
    const currentWorker = worker();

    if (currentWorker) {
      return tabId('task', currentWorker.id);
    }

    return undefined;
  };

  const terminalScope = (): { workerId?: string } => {
    const workerId = selected();

    if (workerId) {
      return { workerId };
    }

    return {};
  };

  const panelRole = (hasSelection: boolean): 'tabpanel' | undefined => {
    if (hasSelection) {
      return 'tabpanel';
    }

    return undefined;
  };

  const newTaskLabel = () => {
    const projectName = project()?.name;
    if (projectName) {
      return 'New task in ' + projectName;
    }

    return 'Open a project to add a task';
  };

  const savedEntryCount = () => {
    if (project()) {
      return projectWorkers().length;
    }

    return snapshot().projects.length;
  };

  const browseSavedEntries = () => {
    if (project()) {
      openLibrary('tasks');
      return;
    }

    openLibrary('projects');
  };

  return (
    <div class="app-shell">
      <header class="titlebar">
        <span class="app-name">
          <Mark size={23} />
          Miter
        </span>
        <span class="window-caption">Local project runner</span>
        <div class="spacer" />
        <button
          class="icon-button history-button"
          title="Recently closed tabs"
          aria-label="History"
          onClick={() => openLibrary('history', '')}
        >
          <Icon name="history" size={16} />
        </button>
        <button
          classList={{
            connection: true,
            online: connected(),
            'health-button': true,
          }}
          title="Connection, diagnostics and state backups"
          aria-label="Connection and health"
          onClick={() => setModal('health')}
        >
          <i />
          <Show when={connected()} fallback={'Disconnected'}>
            {'Local ready'}
          </Show>
        </button>
        <button
          class="icon-button"
          aria-label="Open full workspace"
          title="Open full workspace"
          onClick={() =>
            chrome.tabs.create({
              url: chrome.runtime.getURL('/workspace.html'),
            })
          }
        >
          <Icon name="expand" size={15} />
        </button>
      </header>
      <div class="shell-body">
        <div class="main-shell">
          <WorkspaceTabRow
            kind="project"
            items={projectTabs()}
            selected={navigation().projectId}
            addDisabled={!connected()}
            canAdd={true}
            addLabel="New project"
            onSelect={chooseProject}
            onAdd={() => setModal('project')}
            onClose={(id) =>
              void closeTabs({
                type: 'close',
                kind: 'project',
                id,
              })
            }
            onList={() => openLibrary('projects', '')}
            listLabel="All projects"
            menuItems={(id) => menuItems('project', id)}
          />
          <div
            id="mitter-project-view"
            role={panelRole(!!project())}
            aria-labelledby={projectPanelLabel()}
            class="project-view"
          >
            <WorkspaceTabRow
              kind="task"
              items={taskTabs()}
              selected={selected()}
              addDisabled={!connected()}
              canAdd={!!project()}
              addLabel={newTaskLabel()}
              onSelect={choose}
              onAdd={newWorker}
              onClose={(id) =>
                void closeTabs({
                  type: 'close',
                  kind: 'task',
                  id,
                })
              }
              onList={() => openLibrary('tasks')}
              listLabel="All project tasks"
              menuItems={(id) => menuItems('task', id)}
            />
            <Show when={!connected()}>
              <div class="connection-banner">
                <span>{connectionError() || 'Connecting to the local host…'}</span>
                <button onClick={() => client.reconnect()}>Reconnect</button>
              </div>
            </Show>
            <Show when={project()}>
              {(projectEntry) => <ProjectToolbar controller={props.controller} project={projectEntry()} />}
            </Show>
            <div
              id="mitter-task-view"
              role={panelRole(!!worker())}
              aria-labelledby={taskPanelLabel()}
              class="task-view"
            >
              <Show
                when={worker()}
                fallback={
                  <div class="welcome">
                    <Icon name="folder" size={36} />
                    <h1>{welcome().title}</h1>
                    <p>{welcome().text}</p>
                    <div class="button-row">
                      <Show when={savedEntryCount()}>
                        <button onClick={browseSavedEntries}>
                          <Show when={project()} fallback={'Browse projects'}>
                            {'Browse tasks'}
                          </Show>
                        </button>
                      </Show>
                      <Show
                        when={project()}
                        fallback={
                          <button class="primary" onClick={() => setModal('project')} disabled={!connected()}>
                            Choose Folder…
                          </button>
                        }
                      >
                        <button class="primary" onClick={() => newWorker()} disabled={!connected()}>
                          New task
                        </button>
                      </Show>
                    </div>
                  </div>
                }
              >
                {(task) => <TaskView controller={props.controller} task={task()} />}
              </Show>
            </div>
          </div>
        </div>
      </div>
      <Show when={terminalMounted()}>
        <TerminalDock
          visible={terminalOpen()}
          projectId={navigation().projectId}
          {...terminalScope()}
          projectName={project()?.name || ''}
          close={() => setTerminalOpen(false)}
        />
      </Show>
      <Show when={debugOpen()}>
        <DebugConsole
          entries={logs()}
          clear={() =>
            void rpc('debug.clear')
              .then(() => success('Console cleared.'))
              .catch((event) => setNotice(errorMessage(event)))
          }
          close={() => {
            setDebugOpen(false);
            info('Console closed.');
          }}
          copy={copy}
        />
      </Show>
      <footer class="statusbar">
        <span>Miter {APP_VERSION}</span>
        <span class="footer-state">
          <Show when={worker()} fallback={'Ready'}>
            {(currentWorker) => displayTaskName(currentWorker())}
          </Show>
        </span>
        <div class="spacer" />
        <Show when={activeCount()}>
          <button
            title="View working tasks, including closed tabs"
            onClick={() => openLibrary('tasks', '', 'active')}
          >
            {activeCount()} working
          </button>
        </Show>
        <button onClick={toggleTerminal} aria-pressed={terminalOpen()} title="Local shell · Ctrl+Shift+`">
          Terminal
        </button>
        <button
          onClick={() => {
            setDebugOpen((value) => !value);
            setTerminalOpen(false);
          }}
          aria-pressed={debugOpen()}
        >
          <Icon name="terminal" size={13} />
          Console<span class="shortcut">Ctrl + `</span>
        </button>
        <button
          class="icon-button"
          aria-label="Settings"
          title="Settings"
          onClick={() => setModal('settings')}
          disabled={!connected()}
        >
          <Icon name="settings" size={14} />
        </button>
      </footer>
      {props.children}
    </div>
  );
}
