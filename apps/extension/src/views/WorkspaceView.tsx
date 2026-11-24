import { reloadWorkspace } from '../workspace-reload';
import { ProjectToolbar } from './ProjectToolbar';
import { errorMessage } from '../schemas/primitives';
import type { JSX } from 'solid-js';
import { type WorkspaceController } from '../ui/workspace-controller';
import { Show } from 'solid-js';
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
import { createWorkspaceHandoff } from '../ui/workspace-handoff';
// Load the code with the workspace so a rebuild cannot remove it before the first Terminal click.
import { TerminalDock } from '../TerminalDock';

export function WorkspaceView(props: { controller: WorkspaceController; children?: JSX.Element }) {
  const {
    snapshot,
    navigation,
    connected,
    connectionError,
    connectionBuilds,
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
  const canExpand = typeof location !== 'undefined' && location.pathname === '/sidepanel.html';
  const handoff = createWorkspaceHandoff(canExpand, setNotice);
  const inTab = () => handoff.externalTab() !== undefined;
  let workspaceButton: HTMLButtonElement | undefined;

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

  const workingTasksLabel = () => {
    const count = activeCount();
    if (count === 1) {
      return '1 working task';
    }

    return count + ' working tasks';
  };

  const workspace = (
    <div class="app-shell" hidden={inTab()}>
      <a class="skip-link" href="#mitter-task-view">
        Skip to workspace
      </a>
      <header class="titlebar">
        <span class="app-name">
          <Mark size={23} />
          Miter
        </span>
        <div class="spacer" />
        <TooltipButton
          class="icon-button"
          icon="bell"
          label="Notification history"
          ariaHasPopup="dialog"
          onClick={() => setModal('notification-history')}
        />
        <Show when={navigation().recentlyClosed.length > 0}>
          <TooltipButton
            class="icon-button history-button"
            icon="history"
            label="Recently closed tabs"
            onClick={() => openLibrary('history', '')}
          />
        </Show>
        <Show when={!connected()}>
          <button
            class="connection health-button"
            title="Setup &amp; connection"
            aria-haspopup="dialog"
            onClick={() => setModal('health')}
          >
            <Show when={connectionError()} fallback="Connecting…">
              Disconnected
            </Show>
          </button>
        </Show>
        <Show when={canExpand}>
          <button
            ref={workspaceButton}
            class="workspace-open"
            aria-label="Open full workspace"
            title="Open full workspace"
            disabled={handoff.opening()}
            onClick={() => void handoff.openWorkspace()}
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
                <span role="status">{connectionHelp(connectionError(), connectionBuilds()).title}</span>
                <ConnectionAction
                  error={connectionError()}
                  builds={connectionBuilds()}
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
                        builds={connectionBuilds()}
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
                {(task) => <TaskView controller={props.controller} task={task()} suspended={inTab()} />}
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
          editElements={newWorker}
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
          <TooltipButton
            class="icon-button"
            icon="tasks"
            label={workingTasksLabel()}
            onClick={() => openLibrary('tasks', '', 'active')}
          />
        </Show>
        <Show when={project() || terminalOpen()}>
          <TooltipButton
            class="icon-button"
            icon="terminal"
            label="Terminal"
            hint={'Terminal · Ctrl+Shift+`'}
            ariaPressed={terminalOpen()}
            onClick={toggleTerminal}
          />
        </Show>
        <div class="spacer" />
        <MenuButton
          label="Help"
          icon="help"
          items={[
            {
              id: 'docs',
              label: 'Documentation',
              run: () => {
                void chrome.tabs
                  .create({ url: chrome.runtime.getURL('/docs.html') })
                  .catch((error) => setNotice(errorMessage(error)));
              },
            },
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
        <TooltipButton
          class="icon-button settings-button"
          icon="settings"
          label="Settings"
          ariaHasPopup="dialog"
          onClick={() => setModal('settings')}
          disabled={!connected()}
        />
      </footer>
      {props.children}
    </div>
  );

  return (
    <>
      {workspace}
      <Show when={inTab()}>
        <main class="app-shell workspace-handoff" aria-labelledby="workspace-handoff-title">
          <div class="workspace-handoff-content">
            <Mark size={30} />
            <h1 id="workspace-handoff-title">Miter is open in a tab</h1>
            <div class="workspace-handoff-actions">
              <button type="button" class="primary" autofocus onClick={() => void handoff.takeMeThere()}>
                Take me there
              </button>
              <button
                type="button"
                onClick={() => {
                  handoff.openHere();
                  queueMicrotask(() => workspaceButton?.focus());
                }}
              >
                Open here instead
              </button>
            </div>
          </div>
        </main>
      </Show>
    </>
  );
}
