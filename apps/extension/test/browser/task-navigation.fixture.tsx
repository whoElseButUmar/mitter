import { Show } from 'solid-js';
import { projectSchema } from '../../../../packages/protocol/src/index';
import { readinessSchema } from '../../../../packages/protocol/src/rpc';
import { emptyWorkspace } from '../../../../packages/ui/src/workspace';
import { HostClient } from '../../src/client';
import { createWorkspaceController } from '../../src/ui/workspace-controller';
import { ProjectHome } from '../../src/views/ProjectHome';
import { SetupPanel } from '../../src/views/SetupPanel';

/** Keeps the production callback signature, so a MouseEvent cannot stand in for a project ID. */
export function TaskNavigationFixture(props: { mode: 'project' | 'setup' }) {
  const project = projectSchema.parse({
    id: 'navigation_project',
    name: 'First project',
    root: '/controlled/first-project',
    profiles: [],
    revision: 1,
  });
  const navigation = {
    ...emptyWorkspace(),
    revision: 1,
    projectId: project.id,
    openProjects: [project.id],
    knownProjects: [project.id],
  };
  const readiness = readinessSchema.parse({
    version: 1,
    node: 'v26.5.1',
    platform: 'darwin',
    architecture: 'arm64',
    webChecks: { status: 'ready', detail: 'Local prerequisites are available.' },
    checks: {
      source: { status: 'ready', detail: 'Source checks are available.' },
      domain: { status: 'ready', detail: 'Domain checks are available.' },
      browser: { status: 'unavailable', detail: 'Rendered browser checks are not automatic.' },
    },
    notice: 'Prerequisites do not mean the task has passed its checks.',
  });
  const request = HostClient.prototype.request;
  let controller: ReturnType<typeof createWorkspaceController>;
  try {
    Object.assign(HostClient.prototype, {
      request: async (method: string) => {
        if (method === 'workspace.read') {
          return navigation;
        }
        if (method === 'system.readiness') {
          return readiness;
        }
        throw new Error('Unexpected task-navigation fixture RPC: ' + method);
      },
    });
    controller = createWorkspaceController();
  } finally {
    HostClient.prototype.request = request;
  }
  controller.client.connect = () => {};
  controller.setSnapshot((snapshot) => ({ ...snapshot, projects: [project] }));
  controller.applyNavigation(navigation);

  return (
    <>
      <Show
        when={props.mode === 'project'}
        fallback={
          <SetupPanel
            connected={true}
            error=""
            rpc={controller.rpc}
            reconnect={() => {}}
            reload={() => {}}
            openProject={() => controller.setModal('project')}
            createProject={() => controller.setModal('project-create')}
            newTask={controller.newWorker}
            projectName={project.name}
          />
        }
      >
        <ProjectHome
          project={project}
          projects={[project]}
          tasks={[]}
          connected={true}
          createProject={() => controller.setModal('project-create')}
          openProject={() => controller.setModal('project')}
          newTask={controller.newWorker}
          startingStarter={false}
          runStarter={controller.starterRun.run}
          chooseProject={controller.tabs.chooseProject}
          chooseTask={controller.tabs.choose}
          browseProjects={() => controller.tabs.openLibrary('projects')}
          browseTasks={() => controller.tabs.openLibrary('tasks')}
        />
      </Show>
      <output
        hidden
        data-task-navigation
        data-modal={controller.modal()}
        data-project-id={controller.formProjectId()}
      />
    </>
  );
}
