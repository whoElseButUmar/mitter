import { randomUUID } from 'node:crypto';
import type {
  Action,
  Envelope,
  Profile,
  Project,
  Worker,
} from '../../../../../packages/protocol/src/index.js';
import { redact } from '../commands.js';
import type { Store } from '../database.js';
import { actionRecord, appendObservation } from '../model-observations.js';
import { ApprovalNeeded, errorMessage, type Workflow, type WorkflowFactory } from '../types.js';
import { digest } from '../workspace.js';

type ActiveRun = { controller: AbortController; promise: Promise<void> };

/** Owns one task's workflow, active run, and in-memory approval lifecycle. */
export class TaskRuntime {
  private readonly workflow: Workflow;
  private active: ActiveRun | undefined;
  private previousSetupWaitMs = 0;
  private setupWaitSince: number | undefined;
  private waitAtBudgetStart = 0;

  constructor(
    readonly worker: Worker,
    private readonly store: Pick<Store, 'saveWorker' | 'event'>,
    factory: WorkflowFactory,
    private readonly changed: () => void,
  ) {
    this.workflow = factory(worker.state, (state) => {
      worker.state = state;
      this.save();
    });
  }

  get running(): boolean {
    return this.active !== undefined;
  }

  assertIdle(): void {
    if (this.running) {
      throw new Error('Pause the worker and wait for the current operation to stop first.');
    }
  }

  move(state: Worker['state']): void {
    this.workflow.move(state);
  }

  get setupWaitMs(): number {
    if (this.setupWaitSince !== undefined) {
      return this.previousSetupWaitMs + Math.max(0, Date.now() - this.setupWaitSince);
    }
    return this.previousSetupWaitMs;
  }

  startBudget(): void {
    this.worker.startedAt = Date.now();
    this.waitAtBudgetStart = this.setupWaitMs;
  }

  get remainingMs(): number {
    const elapsed = Math.max(0, Date.now() - this.worker.startedAt);
    const waiting = this.setupWaitMs - this.waitAtBudgetStart;
    return this.worker.maxMinutes * 60000 - Math.max(0, elapsed - waiting);
  }

  save(): void {
    if (this.worker.state === 'awaiting_approval' && this.worker.pending?.action.type === 'setupCommand') {
      this.setupWaitSince ??= Date.now();
    } else if (this.setupWaitSince !== undefined) {
      this.previousSetupWaitMs = this.setupWaitMs;
      this.setupWaitSince = undefined;
    }
    this.store.saveWorker(this.worker);
    this.changed();
  }

  event(kind: string, message: string): void {
    this.store.event(this.worker.id, kind, redact(message));
    this.changed();
  }

  remember(message: string): void {
    this.worker.observations = appendObservation(this.worker.observations, message);
    this.save();
  }

  recordAction(action: Action, result: unknown): void {
    this.remember(JSON.stringify({ action: actionRecord(action), result }));
    let label = action.type;

    if ('path' in action) {
      label += ' ' + action.path;
    }

    this.event('action', label + ': ' + JSON.stringify(result).slice(0, 2200));
  }

  discardCompletedBatch(batch: Envelope): void {
    const worker = this.worker;

    if (worker.cursor >= batch.actions.length) {
      worker.queue.shift();
      worker.cursor = 0;
    }
  }

  newRunIfNeeded(): void {
    const worker = this.worker;

    if (['complete', 'cancelled'].includes(worker.state)) {
      worker.humanAcceptanceReady = false;
      worker.completion = undefined;
      worker.runId = randomUUID();
      this.previousSetupWaitMs = 0;
      this.setupWaitSince = undefined;
      worker.iteration = 0;
      worker.repeatCount = 0;
      worker.lastProposal = undefined;
      worker.cursor = 0;
      worker.autoCommands = false;
    }
  }

  discardPlan(): void {
    const worker = this.worker;
    worker.queue = [];
    worker.cursor = 0;
    worker.pending = undefined;
    worker.approvedFingerprint = undefined;
    worker.autoCommands = false;
    worker.humanAcceptanceReady = false;
    worker.completion = undefined;
  }

  requireApproval(project: Project, action: Action, profiles: Profile[]): void {
    const worker = this.worker;
    const fingerprint = digest(
      JSON.stringify({
        runId: worker.runId,
        action,
        profiles,
        revision: project.revision,
      }),
    );

    if (worker.autoCommands) {
      return;
    }

    if (worker.approvedFingerprint === fingerprint) {
      worker.approvedFingerprint = undefined;
      this.save();
      return;
    }

    const reason =
      `Run ${profiles
        .map((profile) => `${profile.label}: ${JSON.stringify([profile.program, ...profile.args])}`)
        .join('; ')}. ` + 'Project programs run with your OS user permissions. This is not a sandbox.';
    worker.pending = {
      token: randomUUID(),
      fingerprint,
      action,
      revision: project.revision,
      profile: profiles[0],
      reason,
    };
    this.move('awaiting_approval');
    this.save();
    this.event('approval', reason);
    throw new ApprovalNeeded();
  }

  start(execute: (signal: AbortSignal) => Promise<void>, budget: 'task' | 'user' = 'task'): void {
    this.assertIdle();
    const worker = this.worker;
    const controller = new AbortController();
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    if (budget === 'task') {
      budgetTimer = setTimeout(
        () => {
          worker.error = 'Active run time budget reached. Inspect the report before resuming.';
          this.event('budget', worker.error);
          controller.abort(new Error(worker.error));
        },
        Math.max(1, this.remainingMs),
      );
      budgetTimer.unref();
    }

    // Admission is synchronous; execution starts on the next microtask.
    const record: ActiveRun = { controller, promise: Promise.resolve() };
    this.active = record;
    record.promise = Promise.resolve()
      .then(() => execute(controller.signal))
      .catch((error) => {
        if (error instanceof ApprovalNeeded || controller.signal.aborted) {
          return;
        }

        worker.error = redact(errorMessage(error));
        this.move('blocked');
        this.event('error', worker.error);
      })
      .finally(() => {
        clearTimeout(budgetTimer);

        // Shutdown can make the execution loop return normally before its first
        // operation. Persist the abort even when there was no rejected promise.
        if (controller.signal.aborted && !['paused', 'cancelled', 'complete'].includes(worker.state)) {
          this.move('paused');
        }

        this.active = undefined;
        this.save();
      });
  }

  abort(reason: Error): void {
    this.active?.controller.abort(reason);
  }

  async wait(): Promise<void> {
    await this.active?.promise;
  }

  stopWorkflow(): void {
    this.workflow.stop();
  }
}
