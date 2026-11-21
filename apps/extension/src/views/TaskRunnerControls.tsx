import { Match, Show, Switch } from 'solid-js';
import type { Worker } from '../../../../packages/protocol/src/index';
import { budgetExhausted, taskPresentation } from '../../../../packages/bridge/src/presentation';
import { chatStartLabel, isFreshContinuation, runningStates } from '../ui/task-view';
import { taskStatus } from '../ui/task-status';
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
  const { connected, busy, action, runWithChat, useReply, showResend, continuePending } = props.controller;
  const task = () => props.task;
  const bridge = () => {
    const status = props.controller.bridge();
    if (status?.workerId === task().id) {
      return status;
    }
    return undefined;
  };
  const preferReply = () => {
    const status = props.controller.bridge();
    return (!status || status.workerId === task().id) && props.controller.preferReply();
  };
  const progress = () => taskPresentation(task(), bridge());

  const disabled = () => busy() || !connected();
  const chatRecovery = () =>
    task().mode === 'handoff' &&
    !bridge()?.active &&
    !bridge()?.monitoring &&
    !task().pending &&
    !runningStates.has(task().state) &&
    !task().queue.length &&
    !isFreshContinuation(task()) &&
    !preferReply() &&
    !budgetExhausted(bridge()) &&
    ['CHAT_NOT_READY', 'SEND_NOT_READY'].includes(bridge()?.errorCode || '');

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
              <button class="primary" disabled={disabled()} onClick={() => void action('bridge.openChat')}>
                <Icon name="external" />
                Open chat
              </button>
              <button disabled={disabled()} onClick={useReply}>
                Use reply…
              </button>
              <button disabled={disabled()} onClick={() => void showResend()}>
                Resend prompt…
              </button>
            </Show>
          </Match>
          <Match when={bridge()?.active}>
            <Show when={bridge()?.phase === 'connecting'}>
              <button class="primary" disabled={disabled()} onClick={() => void action('bridge.openChat')}>
                <Icon name="external" />
                Open chat
              </button>
            </Show>
            <button
              disabled={disabled()}
              onClick={() => void action('bridge.pause')}
              title="Pause; Resume keeps the current plan"
            >
              <Icon name="pause" />
              Pause
            </button>
          </Match>
          <Match when={task().pending}>{null}</Match>
          <Match when={runningStates.has(task().state)}>
            <button disabled={disabled()} onClick={() => void action('worker.pause')}>
              <Icon name="pause" />
              Pause
            </button>
          </Match>
          <Match when={task().queue.length}>
            <button class="primary" disabled={disabled()} onClick={() => void continuePending()}>
              <Icon name="play" />
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
          <Match when={chatRecovery()}>
            <button class="primary" disabled={disabled()} onClick={() => void action('bridge.openChat')}>
              <Icon name="external" />
              Open chat
            </button>
            <button disabled={disabled()} onClick={startChat}>
              {chatStartLabel(task(), preferReply(), busy(), progress().start)}
            </button>
          </Match>
          <Match when={task().mode === 'handoff'}>
            <button class="primary" onClick={startChat} disabled={disabled()}>
              <Icon name="play" />
              {chatStartLabel(task(), preferReply(), busy(), progress().start)}
            </button>
          </Match>
          <Match when={task().mode === 'local'}>
            <button class="primary" disabled={disabled()} onClick={startLocal}>
              <Icon name="play" />
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
            <Icon name="stop" />
            Stop
          </button>
        </Show>
        <Show
          when={
            bridge() &&
            !bridge()?.monitoring &&
            !task().pending &&
            !chatRecovery() &&
            taskStatus(task(), bridge()).requiresAttention
          }
        >
          <button disabled={disabled()} onClick={() => void action('bridge.openChat')}>
            Open chat
          </button>
        </Show>
      </section>
    </Show>
  );
}
