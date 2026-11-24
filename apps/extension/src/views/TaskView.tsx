import { runningStates as running } from '../ui/task-view';
import { SelectedPreviewElement } from '../components/SelectedPreviewElement';
import { TaskMarkdown } from '../components/TaskMarkdown';
import { TaskEditor } from './TaskEditor';
import { TaskDiagnostics } from './TaskDiagnostics';
import { taskStatus } from '../ui/task-status';
import { TaskRunnerControls } from './TaskRunnerControls';
import type { WorkspaceController } from '../ui/workspace-controller';
import type { Worker } from '../../../../packages/protocol/src/index';
import { approvalDescription } from '../ui/task-view';
import { FollowupPanel } from '../Followups';
import { ContextArea } from '../ContextArea';
import { createResource, Show } from 'solid-js';
import { createApprovalTrust } from '../ui/approval-trust';

import { displayTaskName } from '../../../../packages/protocol/src/task-brief';
import { TaskAppRunButton } from '../components/TaskAppRunButton';
import { Icon } from '../icons';
import { SetupCommandReview, setupReviewKey } from '../components/SetupCommandReview';
import { savedChatResultSchema } from '../schemas/local-results';
import { callResult } from '../ui/rpc';

export function TaskView(props: { controller: WorkspaceController; task: Worker }) {
  const {
    snapshot,
    connected,
    success,

    busy,
    bridge,

    rpc,
    action,
    copy,
    rewriteDraft,
    sendFollowup,
    showFollowups,
    showText,
    output,
  } = props.controller;
  const trust = createApprovalTrust(() => props.task);

  const task = () => props.task;
  const progress = () => taskStatus(task(), bridge());
  const [savedChat] = createResource(
    () => connected() && task().state === 'complete' && task().mode === 'handoff' && task().id,
    async (workerId) => {
      try {
        const result = await callResult(rpc, savedChatResultSchema, 'bridge.hasSavedChat', { workerId });
        if (result.saved) {
          return workerId;
        }
      } catch {
        // This optional action returns after the next connection or task change.
      }
      return undefined;
    },
  );

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
          <div classList={{ 'task-handoff': task().state === 'complete' }}>
            <div class="task-heading-row">
              <h1 title={displayTaskName(task())}>{displayTaskName(task())}</h1>
              <div
                class="task-state"
                data-tone={progress().tone}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <h2 class="task-status-heading">
                  <Show when={progress().tone === 'success'}>
                    <Icon name="check" />
                  </Show>
                  {progress().heading}
                </h2>
                <Show when={progress().detail}>
                  <span class="state-summary">{progress().detail}</span>
                </Show>
              </div>
            </div>
            <Show when={task().state === 'complete' && !task().pending}>
              <div class="task-handoff-actions" role="group" aria-label="Completed task actions">
                <TaskAppRunButton controller={props.controller} task={task()} />
                <button
                  type="button"
                  disabled={!connected()}
                  aria-disabled={output.browsing()}
                  aria-busy={output.browsing()}
                  onClick={() => void output.browseFiles()}
                >
                  <Icon name="folder" />
                  <Show when={output.browsing()} fallback="Open files">
                    Opening…
                  </Show>
                </button>
                <Show when={task().mode === 'handoff' && savedChat() === task().id}>
                  <button
                    type="button"
                    disabled={!connected() || busy()}
                    onClick={() => void action('bridge.openChat', { workerId: task().id })}
                  >
                    <Icon name="external" />
                    Open chat
                  </button>
                </Show>
              </div>
            </Show>
          </div>
          <details class="task-details">
            <summary>
              <Icon name="right" />
              Task details
            </summary>
            <TaskMarkdown source={task().goal.replace(/^(Worker name|The goal):\s*/i, '')} />
            <Show when={task().worktree}>
              <small class="muted">Isolated worktree · {task().worktree?.branch}</small>
            </Show>
          </details>
          <Show keyed when={task().hasPreviewSelection && task().id}>
            {(workerId) => <SelectedPreviewElement workerId={workerId} rpc={props.controller.rpc} />}
          </Show>
        </section>
      </ContextArea>
      <Show when={task().completion?.evidence}>
        {(evidence) => (
          <details class="completion-evidence">
            <summary>
              <Icon name="right" />
              Verification details
            </summary>
            <p>{evidence().detail}</p>
            <Show when={task().completion?.summary}>
              {(summary) => (
                <>
                  <strong>Model summary</strong>
                  <TaskMarkdown source={summary()} />
                </>
              )}
            </Show>
          </details>
        )}
      </Show>
      <Show when={task().error && task().error !== progress().detail}>
        <div class="error-banner" role="alert">
          {task().error}
        </div>
      </Show>
      <Show keyed when={setupReviewKey(task())}>
        {(_identity) => <SetupCommandReview task={task()} controller={props.controller} />}
      </Show>
      <Show when={!setupReviewKey(task()) && task().pending}>
        {(pending) => (
          <section class="approval">
            <h2>Review command</h2>
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
                disabled={busy() || !connected()}
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
                disabled={busy() || !connected()}
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
      <TaskDiagnostics
        controller={props.controller}
        task={task()}
        visibleDetail={progress().detail}
        requiresAttention={progress().requiresAttention}
      />
      <TaskEditor controller={props.controller} task={task()} />
      <Show keyed when={task().id}>
        {(id) => (
          <FollowupPanel
            workerId={id}
            items={snapshot().workers.find((item) => item.id === id)?.followups || []}
            running={running.has(task().state) || !!bridge()?.active}
            disabled={!connected()}
            canAttachImages={task().mode === 'handoff'}
            send={(result, beforeSave) => sendFollowup(id, result, beforeSave)}
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
