import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import type { Worker } from '../../../../packages/protocol/src/index';
import { approvalDescription } from '../ui/task-view';
import { workerSetupDecisionResultSchema } from '../../../../packages/protocol/src/rpc';
import { Field, Modal } from '../components';
import { Icon } from '../icons';
import { errorMessage } from '../schemas/primitives';
import { callResult } from '../ui/rpc';
import { reviewedTaskBoundary } from '../ui/task-boundary';
import type { WorkspaceController } from '../ui/workspace-controller';

/** Remount the dialog when its authority changes, including a replacement run of the same task. */
export function setupReviewKey(task: Worker): string | undefined {
  const pending = task.pending;
  if (pending?.action.type !== 'setupCommand') {
    return undefined;
  }
  return JSON.stringify([
    task.id,
    task.runId,
    task.control?.epoch ?? 0,
    pending.token,
    pending.fingerprint,
    pending.revision,
  ]);
}

function CommandSnippet(props: { command: string; copy: (text: string) => Promise<void> }) {
  return (
    <div class="setup-command-code">
      <pre dir="ltr">
        <code>{props.command}</code>
      </pre>
      <button
        type="button"
        aria-label="Copy command"
        title="Copy command"
        class="icon-button"
        onClick={() => void props.copy(props.command)}
      >
        <Icon name="copy" />
      </button>
    </div>
  );
}

export function SetupCommandReview(props: { controller: WorkspaceController; task: Worker }) {
  const controller = props.controller;
  const task = props.task;
  const pending = task.pending;
  if (pending?.action.type !== 'setupCommand') {
    return null;
  }
  const proposal = pending.action;
  const key = setupReviewKey(task);
  const request = { workerId: task.id, expectedRun: reviewedTaskBoundary(task), token: pending.token };
  const command = approvalDescription(pending);
  const directory =
    task.worktree?.root ||
    controller.snapshot().projects.find((project) => project.id === task.projectId)?.root;
  const [open, setOpen] = createSignal(!pending.manualSessionId);
  const [editing, setEditing] = createSignal(false);
  const [instruction, setInstruction] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [accepted, setAccepted] = createSignal(false);
  const [error, setError] = createSignal('');
  const [manualReceipt, setManualReceipt] = createSignal('');
  const manualSession = () => props.task.pending?.manualSessionId || manualReceipt();
  const dialogVisible = () => open() && !manualSession() && !controller.modal();
  createEffect(() => {
    if (dialogVisible()) {
      onCleanup(controller.reviewingSetup(task.id));
    }
  });
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  const current = () => alive && setupReviewKey(props.task) === key;
  const showTerminal = (sessionId: string) =>
    controller.showSetupTerminal({
      workerId: task.id,
      projectId: task.projectId,
      sessionId,
    });
  async function decide(decision: 'deny' | 'instead' | 'manual' | 'run') {
    if (!current() || !controller.connected() || busy() || accepted() || manualSession()) {
      return;
    }
    const replacement = instruction().trim();
    if (decision === 'instead' && !replacement) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await callResult(
        controller.rpc,
        workerSetupDecisionResultSchema,
        'worker.setupDecision',
        {
          ...request,
          decision,
          ...(decision === 'instead' && { instruction: replacement }),
        },
      );
      if (!current()) {
        return;
      }
      if (decision === 'manual') {
        const sessionId = result.sessionId || manualSession();
        if (!sessionId) {
          throw new Error('Miter is waiting for the setup terminal. Reopen this task to reconnect.');
        }
        setManualReceipt(sessionId);
        showTerminal(sessionId);
      }
      setAccepted(true);
      setOpen(false);
    } catch (reason) {
      if (current()) {
        setError(errorMessage(reason));
      }
    } finally {
      if (alive) {
        setBusy(false);
      }
    }
  }

  function close() {
    setOpen(false);
    setEditing(false);
    setError('');
  }

  return (
    <section class="setup-approval">
      <Show
        when={manualSession()}
        fallback={
          <button
            type="button"
            disabled={!controller.connected() || accepted()}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            Review setup command
          </button>
        }
      >
        {(sessionId) => (
          <div class="setup-manual-handoff">
            <CommandSnippet command={command} copy={controller.copy} />
            <button
              type="button"
              disabled={!controller.connected()}
              onClick={() => showTerminal(sessionId())}
            >
              <Icon name="terminal" /> Open setup terminal
            </button>
          </div>
        )}
      </Show>
      <Show when={dialogVisible()}>
        <Modal title="Allow this setup command?" close={close} closeDisabled={busy()}>
          <div class="setup-command-review">
            <p>{proposal.purpose}</p>
            <CommandSnippet command={command} copy={controller.copy} />
            <dl>
              <dt>Working folder</dt>
              <dd>{directory || task.projectId}</dd>
              <dt>Expected changes</dt>
              <dd>{proposal.effects}</dd>
            </dl>
            <p class="muted">
              This command runs with your local permissions. ChatGPT receives its result and a limited amount
              of output.
            </p>
            <Show when={error()}>
              {(message) => (
                <p class="error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <Show
              when={editing()}
              fallback={
                <div class="setup-command-actions">
                  <button
                    type="button"
                    disabled={busy() || !controller.connected()}
                    onClick={() => void decide('deny')}
                  >
                    No
                  </button>
                  <button type="button" disabled={busy()} onClick={() => setEditing(true)}>
                    Do this instead
                  </button>
                  <button
                    type="button"
                    disabled={busy() || !controller.connected()}
                    onClick={() => void decide('manual')}
                  >
                    I’ll do it myself
                  </button>
                  <button
                    type="button"
                    class="primary"
                    disabled={busy() || !controller.connected()}
                    onClick={() => void decide('run')}
                  >
                    Run it
                  </button>
                </div>
              }
            >
              <form
                class="creation-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void decide('instead');
                }}
              >
                <Field label="What should ChatGPT do instead?">
                  <textarea
                    ref={(field) =>
                      queueMicrotask(() => {
                        if (field.isConnected) {
                          field.focus();
                        }
                      })
                    }
                    required
                    maxLength={2000}
                    rows={3}
                    value={instruction()}
                    onInput={(event) => setInstruction(event.currentTarget.value)}
                  />
                </Field>
                <div class="button-row end">
                  <button type="button" disabled={busy()} onClick={() => setEditing(false)}>
                    Back
                  </button>
                  <button
                    class="primary"
                    type="submit"
                    disabled={busy() || !controller.connected() || !instruction().trim()}
                  >
                    Send instruction
                  </button>
                </div>
              </form>
            </Show>
          </div>
        </Modal>
      </Show>
    </section>
  );
}
