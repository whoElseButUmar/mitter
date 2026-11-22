import { Show } from 'solid-js';
import { APP_VERSION, type Worker } from '../../../../packages/protocol/src/index';
import { debugEntrySchema } from '../../../../packages/bridge/src/diagnostics';
import { turnLabel } from '../../../../packages/bridge/src/presentation';
import { errorMessage } from '../schemas/primitives';
import { callResult } from '../ui/rpc';
import type { WorkspaceController } from '../ui/workspace-controller';
import { Icon } from '../icons';

export function TaskDiagnostics(props: {
  controller: WorkspaceController;
  task: Worker;
  visibleDetail: string;
  requiresAttention: boolean;
}) {
  const { bridge, action, rpc, copy, setNotice, setDebugOpen, connected, busy } = props.controller;
  const recoveryVisible = () =>
    props.task.state !== 'complete' &&
    props.task.state !== 'cancelled' &&
    !props.task.humanAcceptanceReady &&
    (bridge()?.monitoring || (props.requiresAttention && !props.task.pending)) &&
    !bridge()?.receiving;
  const copyDiagnostics = async () => {
    try {
      const entries = await callResult(rpc, debugEntrySchema.array(), 'debug.read');
      await copy(
        [
          'MITER ' + APP_VERSION + ' diagnostics',
          ...entries.map(
            (event) => new Date(event.time).toISOString() + ' [' + event.kind + '] ' + event.message,
          ),
        ].join('\n'),
      );
    } catch (error) {
      setNotice(errorMessage(error));
      setDebugOpen(true);
    }
  };

  return (
    <Show when={bridge()}>
      {(status) => (
        <details class="task-diagnostics task-disclosure-panel">
          <summary>
            <Icon name="right" />
            Technical details
          </summary>
          <div class="task-diagnostics-content">
            <Show
              when={
                status().reason &&
                status().reason !== props.visibleDetail &&
                status().reason !== props.task.error
              }
            >
              <p>{status().reason}</p>
            </Show>
            <p class="task-turn-counter">
              {turnLabel(status())}
              <Show when={status().lowerBound} fallback=" · Task-wide send attempts">
                {' · Known minimum; older sends may be unrecorded'}
              </Show>
            </p>
            <div class="bridge-note">
              <Show when={!recoveryVisible() && props.task.state !== 'complete'}>
                <button disabled={!connected() || busy()} onClick={() => void action('bridge.openChat')}>
                  Open chat
                </button>
              </Show>
              <button onClick={() => setDebugOpen(true)}>Open console</button>
              <button disabled={!connected()} onClick={() => void copyDiagnostics()}>
                Copy diagnostics
              </button>
            </div>
          </div>
        </details>
      )}
    </Show>
  );
}
