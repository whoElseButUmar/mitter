import { Match, Show, Switch } from 'solid-js';
import type { Worker } from '../../../../packages/protocol/src/index';
import { budgetExhausted, taskPresentation, turnLabel } from '../../../../packages/bridge/src/presentation';
import { chatStartLabel, isFreshContinuation, runningStates } from '../ui/task-view';
import type { WorkspaceController } from '../ui/workspace-controller';
import { Icon } from '../icons';

type RunnerController = Pick<
  WorkspaceController,
  | 'connected'
  | 'busy'
  | 'bridge'
  | 'preferReply'
  | 'action'
  | 'runWithChat'
  | 'useReply'
  | 'showResend'
  | 'continuePending'
>;

export function TaskRunnerControls(props: { controller: RunnerController; task: Worker }) {
  const { connected, busy, bridge, preferReply, action, runWithChat, useReply, showResend, continuePending } =
    props.controller;
  const task = () => props.task;
  const progress = () => taskPresentation(task(), bridge());

  const disabled = () => busy() || !connected();

  const turnCounterTitle = (lowerBound: boolean | undefined) => {
    if (lowerBound) {
      return 'Known minimum recovered from older task history. Earlier unrecorded sends cannot be reconstructed exactly. New sends are saved before execution.';
    }

    return 'Task-wide send attempts. Resume and updates do not reset this count; checking a reply does not use a turn.';
  };

  const startChat = () => {
    if (isFreshContinuation(task()) || !preferReply()) {
      void runWithChat();
      return;
    }
    useReply();
  };

  const startLocal = () => {
    if (isFreshContinuation(task())) {
      void action('bridge.continueFresh');
      return;
    }
    void action('worker.run', {
      workerId: task().id,
      expectedRun: { runId: task().runId, epoch: task().control?.epoch ?? 0 },
    });
  };

  return (
    <Show when={task().state !== 'complete' && task().state !== 'cancelled' && !task().humanAcceptanceReady}>
      <section class="runner-controls">
        <Switch>
          <Match when={bridge()?.monitoring}>
            <Show when={!bridge()?.receiving}>
              <button onClick={() => void showResend()}>Resend prompt…</button>
            </Show>
            <span class="muted small">
              <Show when={bridge()?.receiving} fallback="Watching for reply">
                Receiving reply…
              </Show>
            </span>
          </Match>
          <Match when={bridge()?.active}>
            <button onClick={() => void action('bridge.pause')} title="Pause; Resume keeps the current plan">
              <Icon name="pause" size={14} />
              Pause
            </button>
          </Match>
          <Match when={task().pending}>{null}</Match>
          <Match when={runningStates.has(task().state)}>
            <button onClick={() => void action('worker.pause')}>
              <Icon name="pause" size={14} />
              Pause
            </button>
          </Match>
          <Match when={task().queue.length}>
            <button class="primary" disabled={disabled()} onClick={() => void continuePending()}>
              <Icon name="play" size={14} />
              <Show when={task().mode === 'handoff' && bridge()} fallback="Continue local work">
                Continue task
              </Show>
            </button>
          </Match>
          <Match when={task().mode === 'handoff' && budgetExhausted(bridge()) && !preferReply()}>
            <button
              class="primary"
              disabled={disabled()}
              title="Authorize 15 more turns and 30 more active minutes. Previous progress is retained."
              onClick={() =>
                void action('bridge.extend', {
                  confirm: true,
                })
              }
            >
              Continue · +15 turns
            </button>
          </Match>
          <Match when={task().mode === 'handoff'}>
            <button class="primary" onClick={startChat} disabled={disabled()}>
              <Icon name="play" size={14} />
              {chatStartLabel(task(), preferReply(), busy(), progress().start)}
            </button>
          </Match>
          <Match when={task().mode === 'local'}>
            <button class="primary" disabled={disabled()} onClick={startLocal}>
              <Icon name="play" size={14} />
              <Show when={isFreshContinuation(task())} fallback="Run locally">
                Continue fresh
              </Show>
            </button>
          </Match>
        </Switch>
        <Show when={task().control?.mode !== 'stopped'}>
          <button
            class="stop-button"
            disabled={disabled()}
            onClick={() =>
              void action('bridge.halt', {
                id: crypto.randomUUID(),
              })
            }
            title="Stop running work and retire the pending plan. Completed files are kept."
          >
            <span class="stop-square" aria-hidden="true" />
            Stop
          </button>
        </Show>
        <Show when={bridge()}>
          {(bridgeStatus) => (
            <span class="muted small task-turn-counter" title={turnCounterTitle(bridgeStatus().lowerBound)}>
              {turnLabel(bridgeStatus())}
            </span>
          )}
        </Show>
        <Show when={bridge()}>
          <button onClick={() => void action('bridge.openChat')}>Open chat</button>
        </Show>
      </section>
    </Show>
  );
}
