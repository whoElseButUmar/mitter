import { renderToString } from 'solid-js/web';
import type { Worker } from '../../../../packages/protocol/src/index';
import type { BridgeStatus } from '../../../../packages/bridge/src/runner/types';
import { TaskRunnerControls } from '../../src/views/TaskRunnerControls';
import { TerminalAppearance } from '../../src/components/TerminalAppearance';
import { Modal } from '../../src/components';
import { ContextForm } from '../../src/forms/ContextForm';
import { NotificationsForm } from '../../src/forms/NotificationsForm';
import { RenameForm } from '../../src/forms/RenameForm';
import { ProjectForm } from '../../src/forms/ProjectForm';
import { TeamPanel } from '../../src/TeamPanel';
import type { Project } from '../../../../packages/protocol/src/index';
import { DEFAULT_TERMINAL_PREFERENCES } from '../../../../packages/terminal/src/appearance';
import { TaskAttentionFixture } from '../browser/task-attention.fixture';

type RunnerState = {
  bridge?: BridgeStatus;
  busy?: boolean;
  connected?: boolean;
  preferReply?: boolean;
};

export function renderRunner(task: Worker, state: RunnerState = {}) {
  return renderToString(() => (
    <TaskRunnerControls
      task={task}
      controller={{
        bridge: () => state.bridge,
        busy: () => state.busy ?? false,
        connected: () => state.connected ?? true,
        preferReply: () => state.preferReply ?? false,
        action: async () => {},
        runWithChat: async () => {},
        useReply: () => {},
        showResend: async () => {},
        continuePending: async () => {},
      }}
    />
  ));
}

export function renderAttention(reason: string, receiving = false, workerError = '') {
  return renderToString(() => (
    <TaskAttentionFixture
      reason={reason}
      receiving={receiving}
      consoleOpen={true}
      workerError={workerError}
      onAction={() => {}}
    />
  ));
}

export function renderAppearance(ready = true) {
  return renderToString(() => (
    <TerminalAppearance
      prefs={() => DEFAULT_TERMINAL_PREFERENCES}
      fonts={() => []}
      systemFonts={() => []}
      ready={() => ready}
      fontBusy={() => false}
      error={() => ''}
      apply={async () => {}}
      fail={() => {}}
      importTheme={async () => {}}
      importFont={async () => {}}
      removeFont={async () => {}}
      useSystemFonts={async () => {}}
      close={() => {}}
    />
  ));
}

export function renderOwnedForms(project: Project) {
  return renderToString(() => (
    <>
      <ContextForm
        project={() => project}
        projects={() => [project]}
        rpc={async () => {}}
        close={() => {}}
        success={() => {}}
        notice={() => {}}
      />
      <NotificationsForm
        preferences={{ enabled: true, sound: false }}
        rpc={async () => {}}
        close={() => {}}
        success={() => {}}
        notice={() => {}}
        playSound={async () => {}}
      />
      <RenameForm
        target={{ kind: 'project', id: project.id, name: project.name }}
        rpc={async () => {}}
        close={() => {}}
        success={() => {}}
        busy={() => false}
      />
    </>
  ));
}

export function renderProjectForm(project: Project) {
  return renderToString(() => (
    <ProjectForm
      close={() => {}}
      pick={async () => ({ cancelled: true })}
      save={async () => project}
      opened={() => {}}
    />
  ));
}

export function renderTeamPanel() {
  return renderToString(() => (
    <TeamPanel
      workerId="worker_1"
      revision={0}
      rpc={async () => ({ peers: [], messages: [] })}
      copy={async () => {}}
    />
  ));
}

export function renderDialogs() {
  return renderToString(() => (
    <>
      <Modal title="First dialog" close={() => {}}>
        First content
      </Modal>
      <Modal title="Second dialog" close={() => {}}>
        Second content
      </Modal>
    </>
  ));
}
