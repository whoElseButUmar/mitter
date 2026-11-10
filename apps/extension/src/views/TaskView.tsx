import { runningStates as running } from '../ui/task-view';
import { errorMessage } from '../schemas/primitives';
import { debugEntrySchema } from '../../../../packages/bridge/src/diagnostics';
import { callResult } from '../ui/rpc';
import { TaskEditor } from './TaskEditor';
import { TaskRunnerControls } from './TaskRunnerControls';
import type { WorkspaceController } from '../ui/workspace-controller';
import type { Worker } from '../../../../packages/protocol/src/index';
import { approvalDescription } from '../ui/task-view';
import { FollowupPanel } from '../Followups';
import { ContextArea } from '../ContextArea';
import { Show } from 'solid-js';
import { createApprovalTrust } from '../ui/approval-trust';

import { displayTaskName } from '../../../../packages/protocol/src/task-brief';
import { APP_VERSION } from '../../../../packages/protocol/src/index';
import { taskPresentation } from '../../../../packages/bridge/src/presentation';
import { Status } from '../components';

export function TaskView(props: { controller: WorkspaceController; task: Worker }) {
  const {
    snapshot,
    connected,
    success,
    setNotice,

    busy,
    setDebugOpen,
    useReply,
    bridge,

    rpc,
    action,
    copy,
    rewriteDraft,
    sendFollowup,
    showFollowups,
    showText,
  } = props.controller;
  const trust = createApprovalTrust(() => props.task);

  const task = () => props.task;
  const progress = () => taskPresentation(task(), bridge());

  return (
    <div class="task-layout">
      <ContextArea
        items={[
          {
            id: 'copy-goal',
            label: 'Copy task request',
            run: () => void copy(task().goal),
          },
          {
            id: 'report',
            label: 'View report…',
            run: () => void showText('report'),
          },
          {
            id: 'followups',
            label: 'Follow-up history…',
            run: () => void showFollowups(),
          },
        ]}
      >
        <section class="goal-block">
          <h1 title={displayTaskName(task())}>{displayTaskName(task())}</h1>
          <details class="task-details">
            <summary>Task details</summary>
            <p>{task().goal.replace(/^(Worker name|The goal):\s*/i, '')}</p>
          </details>
          <Show when={task().worktree}>
            <small class="muted">Isolated worktree · {task().worktree?.branch}</small>
          </Show>
        </section>
      </ContextArea>
      <div
        classList={{
          'task-state': true,
          success: task().state === 'complete',
          'bridge-working': !!bridge()?.active || !!bridge()?.receiving,
        }}
        role="status"
        aria-live="polite"
      >
        <Status value={progress().status} />
        <span class="state-summary">{progress().detail}</span>
      </div>
      <Show when={task().error && task().error !== progress().detail}>
        <div class="error-banner" role="alert">
          {task().error}
        </div>
      </Show>
      <Show when={task().pending}>
        {(pending) => (
          <section class="approval">
            <strong>Command approval needed</strong>
            <p>{pending().reason}</p>
            <pre>{approvalDescription(pending())}</pre>
            <label class="checkline">
              <input
                type="checkbox"
                checked={trust.checked()}
                onChange={(event) => trust.setChecked(event.currentTarget.checked)}
              />
              <span>
                Trust registered commands in this imported batch only. New replies need fresh approval.
                Scripts are not sandboxed.
              </span>
            </label>
            <div class="button-row end">
              <button
                onClick={() =>
                  action('worker.approve', {
                    workerId: task().id,
                    expectedRun: { runId: task().runId, epoch: task().control?.epoch ?? 0 },
                    token: pending().token,
                    approve: false,
                  })
                }
              >
                Reject
              </button>
              <button
                class="primary"
                disabled={busy()}
                onClick={() =>
                  action('worker.approve', {
                    workerId: task().id,
                    expectedRun: { runId: task().runId, epoch: task().control?.epoch ?? 0 },
                    token: pending().token,
                    approve: true,
                    trustRun: trust.checked(),
                  })
                }
              >
                Approve
              </button>
            </div>
          </section>
        )}
      </Show>
      <TaskRunnerControls controller={props.controller} task={task()} />
      <Show when={bridge()?.phase === 'error' || (!!bridge()?.errorCode && !bridge()?.active)}>
        <div class="bridge-note">
          <Show when={bridge()?.monitoring && !bridge()?.receiving}>
            <button class="text-button" onClick={useReply}>
              Use reply…
            </button>
          </Show>
          <button class="text-button" onClick={() => setDebugOpen(true)}>
            Show details
          </button>
          <button
            class="text-button"
            onClick={() => {
              void callResult(rpc, debugEntrySchema.array(), 'debug.read')
                .then((entries) =>
                  copy(
                    [
                      'MITER ' + APP_VERSION + ' diagnostics',
                      ...entries.map(
                        (event) =>
                          new Date(event.time).toISOString() + ' [' + event.kind + '] ' + event.message,
                      ),
                    ].join('\n'),
                  ),
                )
                .catch((event) => {
                  setNotice(errorMessage(event));
                  setDebugOpen(true);
                });
            }}
          >
            Copy diagnostics
          </button>
        </div>
      </Show>
      <TaskEditor controller={props.controller} task={task()} />
      <Show keyed when={task().id}>
        {(id) => (
          <FollowupPanel
            workerId={id}
            items={snapshot().workers.find((item) => item.id === id)?.followups || []}
            running={running.has(task().state) || !!bridge()?.active}
            disabled={!connected()}
            send={(result) => sendFollowup(id, result)}
            steer={async (request) => {
              const result = await rpc('bridge.steer', {
                workerId: id,
                request: request,
              });
              success('Steering task. Completed work is kept.');
              return result;
            }}
            cancel={async (requestId) => {
              const result = await rpc('worker.followupCancel', {
                workerId: id,
                id: requestId,
              });
              success('Queued follow-up removed.');
              return result;
            }}
            copy={copy}
            history={() => void showFollowups()}
            rewrite={rewriteDraft}
            start={() =>
              rpc('worker.followupStart', {
                workerId: id,
              })
            }
          />
        )}
      </Show>
    </div>
  );
}
