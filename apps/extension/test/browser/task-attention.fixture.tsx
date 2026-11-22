import { Show } from 'solid-js';
import {
  APP_VERSION,
  workerSchema,
  type CompletionRecord,
  type Worker,
} from '../../../../packages/protocol/src/index';
import { bridgeStatusSchema, type BridgeStatus } from '../../../../packages/bridge/src/runner/types';
import { emptyWorkspace } from '../../../../packages/ui/src/workspace';
import { HostClient } from '../../src/client';
import { DebugConsole } from '../../src/DebugConsole';
import { createWorkspaceController } from '../../src/ui/workspace-controller';
import { TaskView } from '../../src/views/TaskView';
import { TaskOutput } from '../../src/ui/task-output';
import type { ViewRPC } from '../../src/ui/rpc';

export type TaskViewScenario =
  | 'connecting'
  | 'chat-unavailable'
  | 'running'
  | 'checking'
  | 'approval'
  | 'setup-command'
  | 'manual-setup'
  | 'ready'
  | 'unverified'
  | 'unverified-app';

type AttentionFixtureProps = {
  reason: string;
  receiving: boolean;
  savedChat?: boolean | undefined;
  consoleOpen: boolean;
  workerError: string;
  completion?: CompletionRecord | undefined;
  scenario?: TaskViewScenario | undefined;
  lowerBound?: boolean | undefined;
  onOutputReady?: (showActivity: () => void) => void;
  onAction: (name: string) => void;
  outputRead?: ViewRPC;
};

function configureScenario(task: Worker, status: BridgeStatus, scenario: TaskViewScenario) {
  status.monitoring = false;
  status.receiving = false;
  delete status.errorCode;
  status.active = true;
  status.phase = 'running';
  task.name = 'Cozy Desk Kanban';
  task.goal = 'Build a cozy kanban with saved cards, keyboard movement and a real backend.';
  task.error = '';
  task.checks = [{ type: 'exists', path: 'index.html' }];

  switch (scenario) {
    case 'connecting':
      task.state = 'idle';
      status.phase = 'connecting';
      status.reason = 'Waiting for the task’s ChatGPT page to finish loading.';
      status.turns = 0;
      break;
    case 'chat-unavailable':
      task.state = 'paused';
      status.active = false;
      status.phase = 'error';
      status.errorCode = 'CHAT_NOT_READY';
      status.reason =
        'ChatGPT is not ready. Open chat, sign in if needed, then Resume task. Nothing was sent.';
      status.turns = 0;
      break;
    case 'running':
      task.state = 'executing';
      status.reason = 'Applying the next approved changes to the project.';
      break;
    case 'checking':
      task.state = 'verifying';
      status.reason = 'Running browser journeys and Lighthouse checks on desktop and mobile.';
      break;
    case 'setup-command':
    case 'manual-setup':
      task.state = 'awaiting_approval';
      task.pending = {
        token: 'setup_review',
        fingerprint: 'setup_fingerprint',
        revision: 1,
        reason: 'Set up this project.',
        action: {
          type: 'setupCommand',
          command: ['pnpm', 'create', 'vite', 'my board'],
          purpose: 'Create a Vite project.',
          effects: 'Writes package.json and starter files in my board.',
        },
      };
      if (scenario === 'manual-setup') {
        task.pending.manualSessionId = 'fixture_setup_session';
      }
      task.worktree = { root: '/projects/My board', branch: 'example', baseCommit: 'fixture' };
      status.phase = 'waiting_approval';
      break;
    case 'approval':
      task.state = 'awaiting_approval';
      task.pending = {
        token: 'fixture_approval',
        fingerprint: 'fixture_fingerprint',
        revision: 1,
        reason: 'Run the registered project test suite.',
        action: { type: 'command', profileId: 'tests' },
        profile: { id: 'tests', label: 'Project tests', program: 'pnpm', args: ['test'], timeoutMs: 30000 },
      };
      status.phase = 'waiting_approval';
      status.reason = 'The test command needs your approval.';
      break;
    case 'ready':
      task.state = 'complete';
      task.completion = {
        version: 1,
        verification: 'passed',
        checked: 5,
        at: 1,
        summary: 'Saved cards, editing and keyboard movement are implemented.',
        evidence: {
          source: 'passed',
          domain: 'passed',
          browser: 'passed',
          lighthouse: 'passed',
          detail:
            'Chrome user journeys and automated accessibility checks passed. All scored Lighthouse categories reached 100 on desktop and mobile for this snapshot. This does not establish WCAG conformance or deployed performance.',
        },
      };
      status.active = false;
      status.phase = 'complete';
      status.reason = 'The verified app is ready.';
      break;
    case 'unverified':
    case 'unverified-app':
      task.state = 'complete';
      task.completion = {
        version: 1,
        verification: 'not-run',
        checked: 0,
        at: 1,
        summary: 'Files are ready.',
      };
      status.active = false;
      status.phase = 'complete';
      status.reason = 'No completion checks were run.';
      break;
  }
}

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
  if (props.completion) {
    task.state = 'complete';
    task.completion = props.completion;
  }
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
    lowerBound: props.lowerBound,
  });
  if (props.scenario) {
    configureScenario(task, status, props.scenario);
  }

  // The controller binds its RPC on creation. Scope this test double to that
  // binding, then restore the prototype before any other fixture can mount.
  const request = HostClient.prototype.request;
  let controller: ReturnType<typeof createWorkspaceController>;
  try {
    Object.assign(HostClient.prototype, {
      request: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'worker.setupDecision' && props.scenario === 'setup-command') {
          props.onAction(JSON.stringify(params));
          if (params.decision === 'manual') {
            return { accepted: true, sessionId: 'fixture_setup_session' };
          }
          return { accepted: true };
        }
        if (method === 'workspace.read') {
          return emptyWorkspace();
        }
        if (method === 'debug.read') {
          return [];
        }
        if (method === 'bridge.hasSavedChat' && params.workerId === task.id) {
          return { saved: props.savedChat ?? false };
        }
        if (method === 'worker.asset' && props.scenario === 'unverified-app') {
          return {
            path: 'index.html',
            mime: 'text/html',
            size: 1,
            offset: 0,
            stamp: 'a'.repeat(64),
            data: btoa('<'),
            eof: true,
          };
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
  let output = controller.output;
  if (props.outputRead) {
    output = new TaskOutput({
      snapshot: controller.snapshot,
      selected: () => task.id,
      worker: () => task,
      project: () => undefined,
      connected: () => true,
      rpc: props.outputRead,
      notice: () => props.onAction('read-notice'),
      success: () => props.onAction('success'),
      copy: async () => props.onAction('copy'),
      action: async () => props.onAction('action'),
      modal: controller.modal,
      setModal: controller.setModal,
    });
    output.setExpanded(true);
  } else {
    output.browseFiles = async () => props.onAction('open-files');
  }
  props.onOutputReady?.(() => output.setView('activity'));
  const viewController = {
    ...controller,
    output,
    connected: () => true,
    bridge: () => status,
    action: async (method: string) => props.onAction(method),
    runWithChat: async () => props.onAction('run-with-chat'),
    showResend: async () => props.onAction('resend'),
    useReply: () => props.onAction('use-reply'),
    copy: async (text: string) => {
      if (props.scenario === 'setup-command') {
        props.onAction('copy ' + text);
        return;
      }
      props.onAction('copy');
    },
    showSetupTerminal: (focus: { sessionId: string }) => props.onAction('open ' + focus.sessionId),
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
