import { runningStates as running } from '../ui/task-view';
import { SelectedPreviewElement } from '../components/SelectedPreviewElement';
import { TaskMarkdown } from '../components/TaskMarkdown';
import { TaskEditor } from './TaskEditor';
import { TaskDiagnostics } from './TaskDiagnostics';
import { taskStatus } from '../ui/task-status';
import { TaskRunnerControls } from './TaskRunnerControls';
import type { WorkspaceController } from '../ui/workspace-controller';
import type { Worker } from '../../../../packages/protocol/src/index';
import { approvalDescription, checkDescription } from '../ui/task-view';
import { FollowupPanel } from '../Followups';
import { ContextArea } from '../ContextArea';
import { createResource, For, Show } from 'solid-js';
import { createApprovalTrust } from '../ui/approval-trust';

import { displayTaskName } from '../../../../packages/protocol/src/task-brief';
import { Icon } from '../icons';
import { TooltipButton } from '../components/TooltipButton';
import { previewFailures } from '../preview-failures';
import { createTaskAppRun } from '../ui/task-app-run';
import { SetupCommandReview, setupReviewKey } from '../components/SetupCommandReview';
import { savedChatResultSchema } from '../schemas/local-results';
import { callResult } from '../ui/rpc';

export function TaskView(props: { controller: WorkspaceController; task: Worker; suspended?: boolean }) {
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
  const completed = () => task().state === 'complete' && !task().pending;
  const completionEvidence = () => task().completion?.evidence;
  const appRun = createTaskAppRun({
    task,
    connected,
    rpc,
    failures: previewFailures,
    showTerminal: props.controller.showAppTerminal,
  });
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
      <div class="task-scroll">
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
            <div class="task-heading-row" classList={{ 'task-handoff': completed() }}>
              <h1 title={displayTaskName(task())}>{displayTaskName(task())}</h1>
              <Show when={completed()}>
                <div class="task-handoff-actions" role="group" aria-label="Completed task actions">
                  <Show when={appRun.available()}>
                    <TooltipButton
                      class="primary"
                      label="Run"
                      icon="play"
                      busy={appRun.busy()}
                      disabled={appRun.busy() || !connected()}
                      onClick={() => void appRun.start()}
                    />
                  </Show>
                  <TooltipButton
                    class="icon-button"
                    label="Open files"
                    icon="folder"
                    ariaHasPopup="dialog"
                    busy={output.browsing()}
                    disabled={!connected()}
                    onClick={() => void output.browseFiles()}
                  />
                  <Show when={task().mode === 'handoff' && savedChat() === task().id}>
                    <TooltipButton
                      class="icon-button"
                      label="Open chat"
                      icon="external"
                      disabled={!connected() || busy()}
                      onClick={() => void action('bridge.openChat', { workerId: task().id })}
                    />
                  </Show>
                </div>
              </Show>
            </div>
            <Show when={!completed()}>
              <div
                class="task-state"
                data-tone={progress().tone}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <h2 class="task-status-heading">{progress().heading}</h2>
                <Show when={progress().detail}>
                  <span class="state-summary">{progress().detail}</span>
                </Show>
              </div>
            </Show>
            <Show when={appRun.error()}>
              {(message) => (
                <p class="error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <details class="task-details">
              <summary>
                <Icon name="right" />
                Task details
              </summary>
              <div class="task-disclosure-content">
                <TaskMarkdown source={task().goal.replace(/^(Worker name|The goal):\s*/i, '')} />
                <Show when={task().worktree}>
                  <small class="muted">Isolated worktree · {task().worktree?.branch}</small>
                </Show>
              </div>
            </details>
            <Show keyed when={task().hasPreviewSelection && task().id}>
              {(workerId) => <SelectedPreviewElement workerId={workerId} rpc={props.controller.rpc} />}
            </Show>
            <Show when={completed() || completionEvidence() || task().checks.length}>
              <details class="completion-evidence">
                <summary>
                  <Icon name="right" />
                  Verification details
                </summary>
                <div class="task-disclosure-content">
                  <Show when={completed() && progress().detail}>{(detail) => <p>{detail()}</p>}</Show>
                  <Show when={completionEvidence()}>{(evidence) => <p>{evidence().detail}</p>}</Show>
                  <Show when={task().checks.length}>
                    <strong>Configured checks</strong>
                    <ul>
                      <For each={task().checks}>{(check) => <li>{checkDescription(check)}</li>}</For>
                    </ul>
                  </Show>
                  <Show when={task().completion?.summary}>
                    {(summary) => (
                      <>
                        <strong>Model summary</strong>
                        <TaskMarkdown source={summary()} />
                      </>
                    )}
                  </Show>
                </div>
              </details>
            </Show>
          </section>
        </ContextArea>
        <Show when={task().error && task().error !== progress().detail}>
          <div class="error-banner" role="alert">
            {task().error}
          </div>
        </Show>
        <Show keyed when={setupReviewKey(task())}>
          {(_identity) => (
            <SetupCommandReview
              task={task()}
              controller={props.controller}
              suspended={props.suspended === true}
            />
          )}
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
      </div>
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
