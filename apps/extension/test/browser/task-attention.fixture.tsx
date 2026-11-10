import { Show } from 'solid-js';
import { APP_VERSION, workerSchema } from '../../../../packages/protocol/src/index';
import { bridgeStatusSchema } from '../../../../packages/bridge/src/runner/types';
import { emptyWorkspace } from '../../../../packages/ui/src/workspace';
import { HostClient } from '../../src/client';
import { DebugConsole } from '../../src/DebugConsole';
import { createWorkspaceController } from '../../src/ui/workspace-controller';
import { TaskView } from '../../src/views/TaskView';

type AttentionFixtureProps = {
  reason: string;
  receiving: boolean;
  consoleOpen: boolean;
  workerError: string;
  onAction: (name: string) => void;
};

export function TaskAttentionFixture(props: AttentionFixtureProps) {
  const task = workerSchema.parse({
    id: 'fixture_worker',
    projectId: 'fixture_project',
    name: 'Reply recovery layout',
    goal: 'Keep the full attention reason and all recovery controls readable.',
    checks: [],
    mode: 'handoff',
    state: 'paused',
    queue: [],
    cursor: 0,
    runId: 'fixture_run',
    iteration: 0,
    maxIterations: 15,
    maxMinutes: 30,
    startedAt: 1,
    autoCommands: false,
    observations: [],
    repeatCount: 0,
    createdAt: 1,
    error: props.workerError,
  });
  const status = bridgeStatusSchema.parse({
    workerId: task.id,
    tabId: 1,
    url: 'https://chatgpt.com/',
    active: false,
    phase: 'error',
    errorCode: 'REPLY_TIMEOUT',
    monitoring: true,
    receiving: props.receiving,
    reason: props.reason,
    turns: 3,
    maxTurns: 15,
    startedAt: 1,
  });

  // The controller binds its RPC on creation. Scope this test double to that
  // binding, then restore the prototype before any other fixture can mount.
  const request = HostClient.prototype.request;
  let controller: ReturnType<typeof createWorkspaceController>;
  try {
    Object.assign(HostClient.prototype, {
      request: async (method: string) => {
        if (method === 'workspace.read') {
          return emptyWorkspace();
        }
        if (method === 'debug.read') {
          return [];
        }
        throw new Error('Unexpected attention fixture RPC: ' + method);
      },
    });
    controller = createWorkspaceController();
  } finally {
    HostClient.prototype.request = request;
  }

  // No connection, authenticated chat, native host, or mutation is allowed.
  controller.client.connect = () => {};
  controller.setSnapshot((snapshot) => ({ ...snapshot, workers: [task] }));
  controller.setDebugOpen(props.consoleOpen);
  const viewController = {
    ...controller,
    connected: () => true,
    bridge: () => status,
    action: async (method: string) => props.onAction(method),
    showResend: async () => props.onAction('resend'),
    useReply: () => props.onAction('use-reply'),
    copy: async () => props.onAction('copy'),
  };

  return (
    <div class="app-shell" style={{ position: 'fixed', inset: '0' }}>
      <header class="titlebar">
        <span class="app-name">Miter</span>
        <div class="spacer" />
        <span class="connection online">Local fixture</span>
      </header>
      <div class="shell-body">
        <div class="main-shell">
          <div class="workspace-tab-row">
            <div class="tabbar">
              <button class="worker-tab selected">Fixture project</button>
            </div>
          </div>
          <div class="project-view">
            <div class="workspace-tab-row">
              <div class="tabbar">
                <button class="worker-tab selected">Reply recovery layout</button>
              </div>
            </div>
            <div class="task-toolbar">
              <span class="project-title">Controlled project</span>
            </div>
            <div class="task-view">
              <TaskView controller={viewController} task={task} />
            </div>
          </div>
        </div>
      </div>
      <Show when={controller.debugOpen()}>
        <DebugConsole
          entries={[]}
          clear={() => props.onAction('clear-console')}
          close={() => controller.setDebugOpen(false)}
          copy={() => props.onAction('copy-console')}
        />
      </Show>
      <footer class="statusbar">Miter {APP_VERSION} · Controlled layout fixture</footer>
    </div>
  );
}
