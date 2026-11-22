import { reloadWorkspace } from '../workspace-reload';
import { ProjectToolbar } from './ProjectToolbar';
import { errorMessage } from '../schemas/primitives';
import type { JSX } from 'solid-js';
import { type WorkspaceController } from '../ui/workspace-controller';
import { lazy, Show } from 'solid-js';
import { TooltipButton } from '../components/TooltipButton';
import { Icon, Mark } from '../icons';
import { DebugConsole } from '../DebugConsole';
import { MenuButton, WorkspaceTabRow } from '../controls';
import { tabId } from '../../../../packages/ui/src/tab-row';
import { TaskView } from './TaskView';
import { SetupPanel } from './SetupPanel';
import { connectionHelp } from '../ui/connection-help';
import { ConnectionAction } from './ConnectionGuide';
import { ProjectHome } from './ProjectHome';

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
  const canExpand = typeof location !== 'undefined' && location.pathname !== '/workspace.html';

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

  return (
    <div class="app-shell">
      <a class="skip-link" href="#mitter-task-view">
        Skip to workspace
      </a>
      <header class="titlebar">
        <span class="app-name">
          <Mark size={23} />
          Miter
        </span>
        <div class="spacer" />
        <Show when={navigation().recentlyClosed.length > 0}>
          <TooltipButton
            class="icon-button history-button"
            icon="history"
            label="Recently closed tabs"
            onClick={() => openLibrary('history', '')}
          />
        </Show>
        <button
          classList={{
            connection: true,
            online: connected(),
            'health-button': true,
          }}
          title="Setup &amp; connection"
          aria-haspopup="dialog"
          onClick={() => setModal('health')}
        >
          <Show
            when={connected()}
            fallback={
              <Show when={connectionError()} fallback="Connecting…">
                Disconnected
              </Show>
            }
          >
            Helper connected
          </Show>
        </button>
        <Show when={canExpand}>
          <button
            class="workspace-open"
            aria-label="Open full workspace"
            title="Open full workspace"
            onClick={() =>
              chrome.tabs.create({
                url: chrome.runtime.getURL('/workspace.html'),
              })
            }
          >
            <Icon name="external" />
            Workspace
          </button>
        </Show>
      </header>
      <div class="shell-body">
        <main class="main-shell" aria-label="Workspace">
          <Show when={projectTabs().length > 0}>
            <div class="project-navigation">
              <div class="project-tabs">
                <WorkspaceTabRow
                  kind="project"
                  items={projectTabs()}
                  selected={navigation().projectId}
                  addDisabled={!connected()}
                  canAdd={true}
                  addLabel="New project"
                  onSelect={chooseProject}
                  onAdd={() => setModal('project-create')}
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
              </div>
              <div class="project-switcher">
                <button
                  class="project-switcher-current"
                  aria-label={'Switch project: ' + (project()?.name || 'Projects')}
                  onClick={() => openLibrary('projects', '')}
                >
                  <Icon name="folder" />
                  <span>{project()?.name || 'Projects'}</span>
                  <Icon name="down" />
                </button>
                <TooltipButton
                  class="icon-button"
                  label="New project"
                  icon="plus"
                  disabled={!connected()}
                  onClick={() => setModal('project-create')}
                />
              </div>
              <Show when={project()}>
                {(projectEntry) => <ProjectToolbar controller={props.controller} project={projectEntry()} />}
              </Show>
            </div>
          </Show>
          <div
            id="mitter-project-view"
            role={panelRole(!!project())}
            aria-labelledby={projectPanelLabel()}
            class="project-view"
          >
            <Show when={taskTabs().length > 0}>
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
            </Show>
            <Show when={!connected() && snapshot().projects.length > 0}>
              <div class="connection-banner">
                <span role="status">{connectionHelp(connectionError()).title}</span>
                <ConnectionAction
                  error={connectionError()}
                  reconnect={() => client.reconnect()}
                  reload={reloadWorkspace}
                />
                <button onClick={() => setModal('health')}>Setup help</button>
              </div>
            </Show>
            <div
              id="mitter-task-view"
              role={panelRole(!!worker())}
              aria-labelledby={taskPanelLabel()}
              class="task-view"
              tabindex="-1"
            >
              <Show
                when={worker()}
                fallback={
                  <Show
                    when={snapshot().projects.length > 0}
                    fallback={
                      <SetupPanel
                        connected={connected()}
                        error={connectionError()}
                        rpc={rpc}
                        reconnect={() => client.reconnect()}
                        reload={reloadWorkspace}
                        openProject={() => setModal('project')}
                        createProject={() => setModal('project-create')}
                        newTask={newWorker}
                      />
                    }
                  >
                    <ProjectHome
                      project={project()}
                      projects={snapshot().projects}
                      tasks={projectWorkers()}
                      connected={connected()}
                      createProject={() => setModal('project-create')}
                      openProject={() => setModal('project')}
                      newTask={newWorker}
                      runStarter={props.controller.starterRun.run}
                      startingStarter={props.controller.starterRun.starting().has(navigation().projectId)}
                      chooseProject={chooseProject}
                      chooseTask={choose}
                      browseProjects={() => openLibrary('projects')}
                      browseTasks={() => openLibrary('tasks')}
                    />
                  </Show>
                }
              >
                {(task) => <TaskView controller={props.controller} task={task()} />}
              </Show>
            </div>
          </div>
        </main>
      </div>
      <Show when={terminalMounted()}>
        <TerminalDock
          visible={terminalOpen()}
          rpc={rpc}
          runFocus={props.controller.runFocus()}
          setupFocus={props.controller.setupFocus()}
          projectId={navigation().projectId}
          {...terminalScope()}
          projectName={project()?.name || ''}
          editElement={newWorker}
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
          close={() => setDebugOpen(false)}
          copy={copy}
        />
      </Show>
      <footer class="statusbar">
        <Show when={activeCount()}>
          <button
            title="View working tasks, including closed tabs"
            onClick={() => openLibrary('tasks', '', 'active')}
          >
            {activeCount()} working
          </button>
        </Show>
        <Show when={project() || terminalOpen()}>
          <button
            onClick={toggleTerminal}
            aria-pressed={terminalOpen()}
            title="App runs and shells · Ctrl+Shift+`"
          >
            <Icon name="terminal" />
            Terminal
          </button>
        </Show>
        <div class="spacer" />
        <MenuButton
          label="Help"
          items={[
            { id: 'setup', label: 'Setup & connection', run: () => setModal('health') },
            {
              id: 'diagnostics',
              label: 'Diagnostics',
              run: () => {
                setDebugOpen((value) => !value);
                setTerminalOpen(false);
              },
            },
          ]}
        />
        <button
          class="settings-button"
          aria-label="Settings"
          title="Settings"
          onClick={() => setModal('settings')}
          disabled={!connected()}
        >
          <Icon name="settings" />
          Settings
        </button>
      </footer>
      {props.children}
    </div>
  );
}
