import type { JSX } from 'solid-js';
import { projectSchema, workerSchema, type Project } from '../../../../packages/protocol/src/index';
import { ProjectHome } from '../../src/views/ProjectHome';

export function createProjectHomeFixture(mount: (component: () => JSX.Element) => void) {
  const actions: string[] = [];
  const projects = Array.from({ length: 8 }, (_, index) =>
    projectSchema.parse({
      id: 'saved_project_' + index,
      name: 'Saved project ' + index,
      root: '/controlled/' + 'long-folder-name/'.repeat(12) + index,
      profiles: [],
      revision: 1,
    }),
  );
  const project = projects[0];
  if (!project) {
    throw new Error('Project fixture requires its project.');
  }
  const tasks = Array.from({ length: 8 }, (_, index) =>
    workerSchema.parse({
      id: 'saved_task_' + index,
      projectId: project.id,
      name: 'Saved task ' + index,
      goal: 'Build the requested app.',
      checks: [],
      mode: 'handoff',
      state: 'idle',
      queue: [],
      cursor: 0,
      runId: 'run_' + index,
      iteration: 0,
      maxIterations: 15,
      maxMinutes: 30,
      startedAt: 0,
      autoCommands: false,
      observations: [],
      repeatCount: 0,
      createdAt: index,
    }),
  );

  function show(mode: string) {
    if (
      ![
        'projects',
        'tasks',
        'empty',
        'offline',
        'result',
        'result-unverified',
        'result-offline',
        'result-only',
      ].includes(mode)
    ) {
      throw new Error('Unknown project home mode.');
    }
    actions.length = 0;
    let selectedProject: Project | undefined;
    let visibleTasks = tasks;
    if (mode === 'tasks' || mode === 'empty' || mode.startsWith('result')) {
      selectedProject = project;
    }
    if (mode === 'empty') {
      visibleTasks = [];
    }
    if (mode.startsWith('result')) {
      const result = workerSchema.parse({
        ...tasks[0],
        id: 'latest_result',
        name: 'Cozy Desk Kanban with saved cards and keyboard movement',
        state: 'complete',
        completion: {
          version: 1,
          verification: 'passed',
          checked: 4,
          at: 200,
          summary: 'Saved cards and keyboard movement are implemented.',
          evidence: {
            source: 'passed',
            domain: 'passed',
            browser: 'passed',
            lighthouse: 'passed',
            detail: 'Browser checks passed for this snapshot.',
          },
        },
      });
      if (mode === 'result-unverified') {
        result.completion = {
          version: 1,
          verification: 'not-run',
          checked: 0,
          at: 200,
          summary: 'Files are ready.',
        };
      }
      const older = workerSchema.parse({
        ...result,
        id: 'older_result',
        name: 'Earlier completed result',
        completion: { version: 1, verification: 'not-run', checked: 0, at: 100, summary: 'Earlier files.' },
      });
      const foreign = workerSchema.parse({
        ...result,
        id: 'other_project_result',
        projectId: 'another_project',
        name: 'Result belonging to another project',
        completion: { version: 1, verification: 'not-run', checked: 0, at: 300, summary: 'Other files.' },
      });
      visibleTasks = [...tasks, result, older, foreign];
      if (mode === 'result-only') {
        visibleTasks = [result, foreign];
      }
    }
    mount(() => (
      <ProjectHome
        project={selectedProject}
        projects={projects}
        tasks={visibleTasks}
        connected={mode !== 'offline' && mode !== 'result-offline'}
        createProject={() => actions.push('create')}
        openProject={() => actions.push('open')}
        newTask={() => actions.push('task')}
        chooseProject={(id) => actions.push(id)}
        chooseTask={(id) => actions.push(id)}
        browseProjects={() => actions.push('projects')}
        browseTasks={() => actions.push('tasks')}
      />
    ));
  }
  return { show, actions: () => [...actions] };
}
