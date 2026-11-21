import type { JSX } from 'solid-js';
import { projectSchema, workerSchema } from '../../../../packages/protocol/src/index';
import { WorkerForm } from '../../src/forms/WorkerForm';
import { bridgeStartResultSchema } from '../../src/schemas/local-results';
import { workerCreateParamsSchema } from '../../../../packages/protocol/src/rpc';

/** Uses the mounted production form, with only native creation and chat admission controlled. */
export function createTaskStartFixture(mount: (component: () => JSX.Element) => void, close: () => void) {
  const project = projectSchema.parse({
    id: 'task_start_project',
    name: 'Task start check',
    root: '/controlled/project',
    profiles: [],
    revision: 1,
  });
  let resolveStart: ((value: unknown) => void) | undefined;
  let created = 0;
  let started = 0;
  let stopped = 0;
  let failed = 0;
  let authorizations = 0;
  const requests: ReturnType<typeof workerCreateParamsSchema.parse>[] = [];

  function mountTask() {
    if (resolveStart) {
      throw new Error('Finish the previous controlled admission before mounting another task.');
    }
    created = 0;
    started = 0;
    stopped = 0;
    failed = 0;
    authorizations = 0;
    requests.length = 0;
    mount(() => (
      <WorkerForm
        projects={[project]}
        scopedProjectId={project.id}
        authorize={async () => {
          authorizations++;
          return true;
        }}
        create={async (params) => {
          created++;
          requests.push(workerCreateParamsSchema.parse(params));
          return workerSchema.parse({
            projectId: params.projectId,
            name: params.name,
            goal: params.goal,
            checks: params.checks,
            mode: params.mode,
            maxIterations: params.maxIterations,
            maxMinutes: params.maxMinutes,
            id: 'task_start_worker',
            state: 'idle',
            queue: [],
            cursor: 0,
            runId: 'task_start_run',
            iteration: 0,
            autoCommands: false,
            observations: [],
            repeatCount: 0,
            createdAt: 1,
            startedAt: 0,
          });
        }}
        created={() => {}}
        start={async () => {
          started++;
          return new Promise<unknown>((resolve) => {
            resolveStart = resolve;
          });
        }}
        rpc={async (method) => {
          if (method !== 'bridge.stopStarted') {
            throw new Error('Unexpected task fixture request: ' + method);
          }
          stopped++;
          return { stopped: true };
        }}
        stop={async () => {
          throw new Error('Chat cleanup must use its exact admission receipt.');
        }}
        failed={() => {
          failed++;
        }}
        close={close}
      />
    ));
  }

  function admit() {
    const resolve = resolveStart;
    if (!resolve) {
      throw new Error('No task is waiting for chat admission.');
    }
    resolveStart = undefined;
    resolve(
      bridgeStartResultSchema.parse({
        workerId: 'task_start_worker',
        admissionId: 'task_start_admission',
        expectedRun: { runId: 'task_start_run', epoch: 0 },
        tabId: 1,
        url: 'https://chatgpt.com',
        active: true,
        phase: 'connecting',
        reason: 'The chat is still loading.',
        turns: 0,
        maxTurns: 15,
        startedAt: 1,
      }),
    );
  }

  return {
    mount: mountTask,
    admit,
    inspect: () => ({ created, started, stopped, failed, authorizations, requests }),
  };
}
