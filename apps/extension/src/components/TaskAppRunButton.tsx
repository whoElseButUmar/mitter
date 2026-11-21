import { Show } from 'solid-js';
import type { Worker } from '../../../../packages/protocol/src/index';
import { Icon } from '../icons';
import { previewFailures } from '../preview-failures';
import { createTaskAppRun } from '../ui/task-app-run';
import type { WorkspaceController } from '../ui/workspace-controller';

export function TaskAppRunButton(props: { controller: WorkspaceController; task: Worker }) {
  const appRun = createTaskAppRun({
    task: () => props.task,
    connected: props.controller.connected,
    rpc: props.controller.rpc,
    failures: previewFailures,
    showTerminal: props.controller.showAppTerminal,
  });

  return (
    <Show when={appRun.available()}>
      <section class="app-preview-launch" aria-label="Run the app">
        <button
          type="button"
          class="primary"
          disabled={appRun.busy() || !props.controller.connected()}
          onClick={() => void appRun.start()}
        >
          <Icon name="play" />
          <Show when={appRun.busy()} fallback="Run">
            Starting…
          </Show>
        </button>
        <Show when={appRun.error()}>
          <p class="error" role="alert">
            {appRun.error()}
          </p>
        </Show>
      </section>
    </Show>
  );
}
