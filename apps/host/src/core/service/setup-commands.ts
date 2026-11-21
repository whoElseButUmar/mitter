/// <reference lib="es2024.promise" />
import { randomUUID } from 'node:crypto';
import type { Action, Project, Worker } from '../../../../../packages/protocol/src/index.js';
import { parseProfile } from '../commands.js';
import type { Store } from '../database.js';
import { recordSetupResult } from '../handoff-delivery.js';
import type { Locks } from '../locks.js';
import type { ManualSetupOptions, ManualSetupResult } from '../terminal/manual-setup.js';
import { ApprovalNeeded } from '../types.js';
import { digest, safePath } from '../workspace.js';
import {
  type PnpmInstallInputs,
  forgetPnpmInstall,
  plainPnpmInstall,
  pnpmInstallInputs,
  recordPnpmInstall,
} from './pnpm-install-receipt.js';
import type { TaskRuntime } from './task-runtime.js';
import {
  requestedInstall,
  requestedInstallId,
  recordInstallDecision,
  installDecisionKey,
} from './requested-install.js';

export type SetupAction = Extract<Action, { type: 'setupCommand' }>;

export function setupProfile(action: SetupAction) {
  const [program, ...args] = action.command;
  return parseProfile({
    id: 'project-setup',
    label: 'Project setup',
    program,
    args,
    timeoutMs: 600_000,
  });
}

function setupFingerprint(worker: Worker, project: Project, action: SetupAction, actionId: string) {
  return digest(
    JSON.stringify({
      workerId: worker.id,
      runId: worker.runId,
      epoch: worker.control?.epoch ?? 0,
      actionId,
      projectId: project.id,
      root: project.root,
      revision: project.revision,
      action,
    }),
  );
}

export function requireSetupApproval(
  task: TaskRuntime,
  project: Project,
  action: SetupAction,
  actionId: string,
) {
  const worker = task.worker;
  const fingerprint = setupFingerprint(worker, project, action, actionId);
  if (worker.approvedFingerprint === fingerprint) {
    worker.approvedFingerprint = undefined;
    task.save();
    return;
  }

  requestSetupApproval(
    task,
    project,
    action,
    fingerprint,
    actionId === requestedInstallId(worker.queue[0]?.id ?? ''),
  );
  throw new ApprovalNeeded();
}

function requestSetupApproval(
  task: TaskRuntime,
  project: Project,
  action: SetupAction,
  fingerprint: string,
  fromTaskRequest = false,
) {
  task.worker.approvedFingerprint = undefined;
  task.worker.pending = {
    token: randomUUID(),
    fingerprint,
    action,
    revision: project.revision,
    ...(fromTaskRequest && { fromTaskRequest: true }),
    reason: 'Review the proposed command before it runs in your project folder.',
  };
  task.move('awaiting_approval');
  task.save();
  task.event('approval', 'Project setup needs your approval.');
}

function setupAtCursor(worker: Worker) {
  const pending = worker.pending;
  const batch = worker.queue[0];
  let action = batch?.actions[worker.cursor];
  if (pending?.fromTaskRequest) {
    action = requestedInstall;
  }

  if (
    worker.state !== 'awaiting_approval' ||
    !pending ||
    pending.action.type !== 'setupCommand' ||
    !batch ||
    action?.type !== 'setupCommand'
  ) {
    return;
  }

  let actionId = batch.id + '_' + worker.cursor;
  if (pending.fromTaskRequest) {
    actionId = requestedInstallId(batch.id);
  }
  return { action, actionId, pending, displayedAction: pending.action };
}

export function canRestoreSetupApproval(worker: Worker, project: Project, store: Store): boolean {
  const setup = setupAtCursor(worker);
  if (!setup || setup.pending.manualSessionId || worker.approvedFingerprint) {
    return false;
  }

  const { action, actionId, pending } = setup;
  // A crash can occur after the terminal starts opening but before its session ID is saved.
  const manual = store.get(manualSetupKey(actionId));
  if ((manual !== undefined && manual !== false) || store.get('command:setup:' + actionId) !== undefined) {
    return false;
  }

  // The current revision is checked again when the user answers the dialog.
  const reviewedProject = { ...project, revision: pending.revision };
  return (
    pending.fingerprint === setupFingerprint(worker, reviewedProject, action, actionId) &&
    pending.fingerprint === setupFingerprint(worker, reviewedProject, setup.displayedAction, actionId)
  );
}

export function reviewedSetup(task: TaskRuntime, project: Project, token: string) {
  const worker = task.worker;
  const setup = setupAtCursor(worker);
  if (!setup || setup.pending.token !== token) {
    throw new Error('This setup request has ended. Review the current task.');
  }

  const { action, actionId, pending } = setup;
  const fingerprint = setupFingerprint(worker, project, action, actionId);
  if (
    pending.revision !== project.revision ||
    pending.fingerprint !== fingerprint ||
    pending.fingerprint !== setupFingerprint(worker, project, setup.displayedAction, actionId)
  ) {
    if (!task.running) {
      // Refresh a stale request without approving the changed project.
      requestSetupApproval(task, project, action, fingerprint, pending.fromTaskRequest);
    }
    throw new Error('The project changed. Review the refreshed setup request before running it.');
  }
  return { action, actionId, pending };
}

export function finishSetupChoice(
  task: TaskRuntime,
  project: Project,
  store: Store,
  action: SetupAction,
  result: unknown,
  installResolved: boolean | 'waived',
) {
  // A declined, redirected or manually completed setup can invalidate the rest of the model's plan.
  store.transaction(() => {
    if (plainPnpmInstall(action.command)) {
      if (installResolved === 'waived') {
        store.set(installDecisionKey(task.worker, project), 'waived');
      } else {
        recordInstallDecision(store, task.worker, project, installResolved);
      }
    }
    task.recordAction(action, result);
    recordSetupResult(store, task.worker);
    task.discardPlan();
    task.worker.error = undefined;
    if (task.worker.mode === 'handoff') {
      task.move('review');
    } else {
      task.move('planning');
    }
    task.save();
  });
}

export function manualSetupKey(actionId: string) {
  return 'miter.manualSetup.' + actionId;
}

export function startSetupTerminal(
  task: TaskRuntime,
  project: Project,
  store: Store,
  locks: Locks,
  scratch: string,
  token: string,
  open: (options: ManualSetupOptions) => Promise<string>,
  continueLocal: () => void,
): Promise<string> {
  const ready = Promise.withResolvers<string>();
  let manualCompleted = false;

  task.start(async (signal) => {
    try {
      // Keep other Miter writers from changing this project while the user runs the step.
      await locks.using(project.root, signal, async () => {
        await safePath(project.root, '.', true);
        signal.throwIfAborted();
        const { action, actionId, pending } = reviewedSetup(task, project, token);
        const install = plainPnpmInstall(action.command);
        let inputs: PnpmInstallInputs | undefined;
        if (install) {
          inputs = await pnpmInstallInputs(project.root, scratch);
        }
        signal.throwIfAborted();
        const journalKey = manualSetupKey(actionId);
        const exited = Promise.withResolvers<{ sessionId: string; result: ManualSetupResult }>();
        store.set(journalKey, true);
        let sessionId: string;
        try {
          sessionId = await open({
            projectId: project.id,
            workerId: task.worker.id,
            root: project.root,
            signal,
            onFinish: (id, result) => exited.resolve({ sessionId: id, result }),
          });
        } catch (error) {
          if (!signal.aborted) {
            // An opening failure leaves no session in which the user could type.
            store.set(journalKey, false);
            ready.reject(error);
            return;
          }
          throw error;
        }

        // A person can enter a different command or interrupt the terminal.
        forgetPnpmInstall(store, task.worker);
        store.set('miter.qualityCommands.' + task.worker.runId, true);
        if (signal.aborted) {
          ready.reject(signal.reason);
        } else {
          pending.manualSessionId = sessionId;
          task.save();
          ready.resolve(sessionId);
        }

        // Cancellation asks the terminal to kill its process. Retain the writer lock
        // until the manager confirms exit, including when cancellation raced opening.
        const finished = await exited.promise;
        project.revision++;
        store.saveProject(project);
        signal.throwIfAborted();
        if (task.worker.pending !== pending || finished.sessionId !== sessionId) {
          throw new Error(
            'The terminal result belongs to another session. Inspect the project before continuing.',
          );
        }

        let instruction = 'Inspect the project before planning the next step. The user supplied the command.';
        if (install && finished.result.code === 0 && finished.result.plainPnpmInstall) {
          instruction = 'The requested pnpm install succeeded. Continue with the implementation.';
          await recordPnpmInstall(store, task.worker, project, scratch, inputs, signal);
        }
        finishSetupChoice(
          task,
          project,
          store,
          action,
          {
            decision: 'manual',
            exitCode: finished.result.code,
            output: finished.result.output,
            instruction,
          },
          finished.result.code === 0 && finished.result.plainPnpmInstall === true,
        );
        manualCompleted = true;
      });
    } catch (error) {
      if (signal.aborted && task.worker.pending?.token === token) {
        task.worker.pending = undefined;
      }
      ready.reject(error);
      throw error;
    }
  }, 'user');

  if (task.worker.mode === 'local') {
    void task.wait().then(() => {
      if (manualCompleted && task.worker.state === 'planning' && !task.running) {
        continueLocal();
      }
    });
  }
  return ready.promise;
}
