import { For, Show } from 'solid-js';
import type { Project, Worker } from '../../../../packages/protocol/src/index';
import { displayTaskName } from '../../../../packages/protocol/src/task-brief';
import { Status } from '../components';
import { taskStatus } from '../ui/task-status';

export function ProjectHome(props: {
  project: Project | undefined;
  projects: Project[];
  tasks: Worker[];
  connected: boolean;
  createProject: () => void;
  openProject: () => void;
  newTask: () => void;
  chooseProject: (id: string) => void;
  chooseTask: (id: string) => void;
  browseProjects: () => void;
  browseTasks: () => void;
}) {
  const recentProjects = () => props.projects.slice(-6).reverse();
  const projectTasks = () => props.tasks.filter((task) => task.projectId === props.project?.id);
  const latestCompleted = () => {
    let latest: Worker | undefined;
    for (const task of projectTasks()) {
      if (
        task.state === 'complete' &&
        (!latest || (task.completion?.at ?? task.createdAt) >= (latest.completion?.at ?? latest.createdAt))
      ) {
        latest = task;
      }
    }
    return latest;
  };
  const otherTasks = () => {
    const completedId = latestCompleted()?.id;
    return projectTasks().filter((task) => task.id !== completedId);
  };
  const recentTasks = () => otherTasks().slice(-6).reverse();

  return (
    <section class="project-home">
      <Show
        when={props.project}
        fallback={
          <>
            <h1>Projects</h1>
            <div class="button-row home-actions">
              <button type="button" class="primary" disabled={!props.connected} onClick={props.createProject}>
                New project
              </button>
              <button type="button" disabled={!props.connected} onClick={props.openProject}>
                Open project
              </button>
            </div>
            <ul class="saved-entries" aria-label="Saved projects">
              <For each={recentProjects()}>
                {(project) => (
                  <li>
                    <button type="button" class="saved-entry" onClick={() => props.chooseProject(project.id)}>
                      <span class="saved-entry-name">{project.name}</span>
                      <span class="saved-entry-path" title={project.root}>
                        {project.root}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <Show when={props.projects.length > 6}>
              <button type="button" class="text-button" onClick={props.browseProjects}>
                Browse all {props.projects.length} projects
              </button>
            </Show>
          </>
        }
      >
        {(project) => (
          <>
            <h1>{project().name}</h1>
            <div class="button-row home-actions">
              <button
                type="button"
                classList={{ primary: !latestCompleted() }}
                disabled={!props.connected}
                onClick={() => props.newTask()}
              >
                New task
              </button>
            </div>
            <Show when={!projectTasks().length}>
              <p class="muted">
                <Show when={props.connected} fallback="Reconnect to start a task in this project.">
                  Create your first task to build or change something.
                </Show>
              </p>
            </Show>
            <Show when={latestCompleted()}>
              {(task) => (
                <section class="project-result" aria-label="Latest result">
                  <div class="project-result-details">
                    <h2 class="project-result-status">{taskStatus(task()).heading}</h2>
                    <p class="project-result-name">{displayTaskName(task())}</p>
                  </div>
                  <button type="button" class="primary" onClick={() => props.chooseTask(task().id)}>
                    View result
                  </button>
                </section>
              )}
            </Show>
            <Show when={recentTasks().length}>
              <ul class="saved-entries" aria-label="Saved tasks">
                <For each={recentTasks()}>
                  {(task) => (
                    <li>
                      <button
                        type="button"
                        class="saved-entry saved-task"
                        onClick={() => props.chooseTask(task.id)}
                      >
                        <span class="saved-entry-name">{displayTaskName(task)}</span>
                        <Show when={task.state === 'complete'} fallback={<Status value={task.state} />}>
                          <span class="project-task-status">{taskStatus(task).heading}</span>
                        </Show>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={otherTasks().length > 6}>
              <button type="button" class="text-button" onClick={props.browseTasks}>
                Browse all {projectTasks().length} tasks
              </button>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
