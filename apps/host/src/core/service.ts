import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Action,
  Envelope,
  Profile,
  Project,
  Request,
  Response,
  Settings,
  Snapshot,
  Worker,
} from '../../../../packages/protocol/src/index.js';
import {
  APP_VERSION,
  VERSION,
  id,
  integer,
  object,
  parseAction,
  taskBoundarySchema,
  taskControlSchema,
  text,
} from '../../../../packages/protocol/src/index.js';
import { parseProposalEnvelope, type ProposalEnvelope } from '../../../../packages/protocol/src/proposal.js';
import { parseFollowup } from '../../../../packages/protocol/src/requests.js';
import { parseRpcParams, parseRpcResult } from '../../../../packages/protocol/src/rpc.js';
import { serviceRpcRegistry } from './service/rpc.js';
import { ReplyValidationError } from '../../../../packages/protocol/src/validation.js';
import {
  parseModelSettings,
  restoreModelSettings,
} from '../../../../packages/protocol/src/model-settings.js';
import {
  parseTaskProgress,
  progressKey,
  type TaskProgress,
} from '../../../../packages/bridge/src/progress.js';
import { parseSchema } from '../../../../packages/protocol/src/helpers.js';
import { readAsset, openTaskFile } from './assets.js';
import { createStateBackup, listStateBackups, verifyStateBackup } from './backups.js';
import { Collaboration } from './collaboration.js';
import { parseProfile, redact, gitDiff, type CommandResult } from './commands.js';
import { Store } from './database.js';
import { pickFolder, revealProject } from './desktop.js';
import { EditConflict, isFileEdit, digest as editDigest } from './edit-plan.js';
import { Followups } from './followups.js';
import { deliveryKey, matchingDelivery, type HandoffDelivery } from './handoff-delivery.js';
import { inspectHealth } from './health.js';
import { Locks } from './locks.js';
import { actionRecord } from './model-observations.js';
import { chatPrompt, localPrompt } from './prompts.js';
import { ReadSnapshots } from './read-snapshots.js';
import { parseModelOutput } from '../../../inference/src/protocol.js';
import { reviewFile } from './review.js';
import { checkJavaScript } from './syntax-check.js';
import { ApprovalNeeded, UserQuestion, errorMessage } from './types.js';
import type { Models, WorkflowFactory } from './types.js';
import {
  Workspace,
  digest,
  fileText,
  listFiles,
  searchFiles,
  safePath,
  validateRelative,
} from './workspace.js';
import { createWorktree } from './worktrees.js';
import { CommandJournalStore } from './service/command-journal.js';
import { buildEditRepair, encodeRepairObservation } from './service/edit-repair.js';
import { TaskRuntime } from './service/task-runtime.js';
import { ProjectCatalog } from './service/project-catalog.js';
import { TaskProgressStore, parseProgressUpdate, prepareFollowupProgress } from './service/progress.js';
import { advanceCounter } from './service/counters.js';
import { buildCompletion, buildReport, summarizeAction } from './service/reports.js';
import {
  parseLocalDraft,
  parseHandoffText,
  parseDisplayName,
  parseWorkerCreation,
  parseOptionalFlag,
} from './service/request-parsing.js';
import {
  readControlOperation,
  verificationIntentSchema,
  type CheckResult,
  type ControlArchive,
  type ControlOperation,
  type ControlResult,
  type EditRepairArchive,
  type FollowupActivation,
  type RepairFileEvidence,
  type RetiredQueue,
  type SkippedEdit,
  type VerificationIntent,
  type VerificationResult,
} from './service/schemas.js';
import {
  migrateLegacyCompletion,
  recoverInterruptedWorker,
  recoverStoppedWorker,
  shutdownRecoveryMessage,
} from './service/state-migration.js';

// Model implementations may drain retiring processes before reset can delete data.
// This is a dependency contract, not serialized state.
type ServiceModels = Models & { settled?: () => Promise<void> };

const gatedMethods = new Set([
  'worker.validateReply',
  'worker.import',
  'worker.run',
  'worker.resume',
  'worker.approve',
  'worker.followupActivate',
  'worker.accept',
]);
const epochMethods = new Set([
  'worker.validateReply',
  'worker.import',
  'worker.run',
  'worker.resume',
  'worker.approve',
]);

export class Service {
  readonly projects: Map<string, Project>;
  private readonly catalog: ProjectCatalog;
  readonly workers = new Map<string, Worker>();
  private readonly tasks = new Map<string, TaskRuntime>();
  private readonly interruptions = new Set<string>();
  private readonly locks = new Locks();
  private readonly workspace: Workspace;
  private readonly reads: ReadSnapshots;
  private readonly progress: TaskProgressStore;
  private readonly commands: CommandJournalStore;
  readonly followups: Followups;
  readonly team: Collaboration;
  private readonly listeners = new Set<() => void>();
  settings: Settings;
  private closed = false;
  private readonly teamTimer: ReturnType<typeof setInterval>;
  private quiescing: Promise<void> | undefined;
  private storeClosed = false;

  constructor(
    readonly store: Store,
    readonly dataDir: string,
    readonly factory: WorkflowFactory,
    readonly models: ServiceModels,
    readonly workflowName = 'xstate',
  ) {
    this.workspace = new Workspace(store);
    this.reads = new ReadSnapshots(store);
    this.progress = new TaskProgressStore(store);
    this.commands = new CommandJournalStore(store);
    this.followups = new Followups(store);
    this.team = new Collaboration(store, this.workers);

    const savedSettings = store.get('settings');
    this.settings = restoreModelSettings(savedSettings);

    if (savedSettings !== undefined && JSON.stringify(savedSettings) !== JSON.stringify(this.settings)) {
      store.set('settings', this.settings);
    }

    this.teamTimer = setInterval(() => {
      if (this.team.expire()) {
        this.changed();
      }
    }, 1000);
    this.teamTimer.unref();

    this.catalog = new ProjectCatalog(store, dataDir, () => this.changed());
    this.projects = this.catalog.projects;

    for (const savedWorker of store.workers()) {
      let worker = recoverInterruptedWorker(savedWorker);

      if (worker !== savedWorker) {
        store.event(worker.id, 'recovery', shutdownRecoveryMessage);
      }

      if (worker.control?.mode === 'stopped' && worker.queue.length > 0) {
        this.archiveQueue(worker, worker.control.operationId);
      }

      worker = recoverStoppedWorker(worker);
      const migratedWorker = migrateLegacyCompletion(worker, Date.now());

      if (migratedWorker !== worker) {
        worker = migratedWorker;
        this.followups.finish(worker, 'completed');
        this.team.releaseOwner(worker.id);
        store.event(
          worker.id,
          'completion-migration',
          'Finished work retained. No files changed or tests rerun; the former acceptance gate was removed.',
        );
      }

      worker.autoCommands = false;
      this.register(worker);
      store.saveWorker(worker);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private register(worker: Worker): TaskRuntime {
    this.workers.set(worker.id, worker);
    const task = new TaskRuntime(worker, this.store, this.factory, () => this.changed());
    this.tasks.set(worker.id, task);

    return task;
  }

  private task(value: unknown): TaskRuntime {
    const task = this.tasks.get(id(value, 'worker ID'));

    if (!task) {
      throw new Error('Worker not found.');
    }

    return task;
  }

  private get activeTasks(): TaskRuntime[] {
    return [...this.tasks.values()].filter((task) => task.running);
  }

  private archiveQueue(worker: Worker, operationId: string): void {
    const retired: RetiredQueue = {
      workerId: worker.id,
      runId: worker.runId,
      queue: worker.queue,
      cursor: worker.cursor,
      at: Date.now(),
    };
    this.store.set('miter.retiredQueue.' + operationId, retired);
  }

  snapshot(): Snapshot {
    // Status views never receive complete source files or unbounded action queues.
    const bridgeProgress = this.progress.summaries(this.workers.values());
    const workers = [...this.workers.values()].map((worker) => ({
      ...worker,
      teamPaused: this.team.reason(worker.id) || undefined,
      followups: this.followups.summaries(worker.id),
      observations: [],
      queue: worker.queue.slice(0, 10).map((batch) => ({
        ...batch,
        actions: batch.actions.map(summarizeAction),
      })),
    }));
    let models = 'Not configured';

    if (this.settings.coderModelPath) {
      models = 'Local model configured; loaded on demand';
    }

    return {
      protocol: VERSION,
      bridgeProgress,
      projects: [...this.projects.values()],
      workers,
      events: this.store
        .events()
        .slice(0, 40)
        .map((event) => ({
          ...event,
          message: event.message.slice(0, 2400),
        })),
      settings: { ...this.settings },
      runtime: {
        version: APP_VERSION,
        node: process.version,
        workflow: this.workflowName,
        models,
      },
    };
  }

  async dispatch(request: Request): Promise<Response> {
    try {
      return {
        id: request.id,
        ok: true,
        result: await this.handle(request.method, request.params),
      };
    } catch (error) {
      return { id: request.id, ok: false, error: redact(errorMessage(error)) };
    }
  }

  async handle(method: string, raw: unknown): Promise<unknown> {
    const result = await this.receive(method, raw);
    parseRpcResult(serviceRpcRegistry, method, result);

    // Local callers retain live project/worker identity; wire validation must not
    // replace those objects or normalize exact source and acknowledgement bytes.
    return result;
  }

  private async receive(method: string, raw: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error('Host is shutting down.');
    }

    const params = object(raw, 'params');

    switch (method) {
      case 'state': {
        parseRpcParams(serviceRpcRegistry, method, params);
        return this.snapshot();
      }
      case 'system.health': {
        parseRpcParams(serviceRpcRegistry, method, params);
        return inspectHealth(
          this.store,
          this.dataDir,
          [...this.workers.values()],
          this.activeTasks.length,
          this.workflowName,
        );
      }
      case 'system.backups': {
        parseRpcParams(serviceRpcRegistry, method, params);
        return listStateBackups(this.dataDir);
      }
      case 'system.backup': {
        if (this.activeTasks.length > 0) {
          throw new Error('Pause active local work before creating a state backup.');
        }

        parseRpcParams(serviceRpcRegistry, method, params);
        return createStateBackup(this.store.db, this.dataDir, 'manual');
      }
      case 'system.verifyBackup': {
        const input = parseRpcParams(serviceRpcRegistry, method, params);
        return verifyStateBackup(this.dataDir, input.id);
      }
      case 'project.pickFolder': {
        parseRpcParams(serviceRpcRegistry, method, params);
        return pickFolder();
      }
      case 'project.reveal': {
        const project = this.catalog.get(params.projectId);
        parseRpcParams(serviceRpcRegistry, method, params);
        await revealProject(project.root);
        return { opened: true };
      }
      case 'project.read': {
        const project = this.catalog.get(params.projectId);
        const input = parseRpcParams(serviceRpcRegistry, method, params);
        const controller = new AbortController();

        return this.locks.using(project.root, controller.signal, () => fileText(project.root, input.path));
      }
      case 'project.context': {
        return this.catalog.context(params);
      }
      case 'project.rename': {
        return this.catalog.rename(params.projectId, params.name);
      }
      case 'project.add': {
        return this.catalog.add(params);
      }
      case 'project.profile': {
        const project = this.catalog.get(params.projectId);

        if (this.activeTasks.some((task) => task.worker.projectId === project.id)) {
          throw new Error('Pause this project’s workers before changing command profiles.');
        }

        return this.catalog.setProfile(project, params.profile);
      }
      case 'worker.create': {
        return this.createWorker(params);
      }
      case 'settings.update': {
        return this.updateSettings(params.settings);
      }
      default: {
        break;
      }
    }

    const task = this.task(params.workerId);
    const worker = task.worker;
    this.checkExpectedRun(worker, method, params);
    const project = this.catalog.executionProject(worker);

    if (method === 'worker.steerValidate') {
      const request = parseFollowup(params.request);
      parseRpcParams(serviceRpcRegistry, method, params);
      const previous = readControlOperation(
        this.store.get('miter.controlOperation.' + request.id),
        request.id,
      );

      if (previous) {
        const signature = digest(JSON.stringify({ workerId: worker.id, steer: true, request }));

        if (previous.signature !== signature) {
          throw new Error('This control ID was used for another request.');
        }

        return { valid: true, alreadyApplied: true };
      }

      await this.followups.validateSteering(worker, project.root, request);
      return { valid: true, alreadyApplied: false };
    }

    if (method === 'worker.stop' || method === 'worker.steer') {
      return this.interruptTask(task, project, params, method === 'worker.steer');
    }

    if (method === 'worker.continueFresh') {
      task.assertIdle();

      if (this.interruptions.has(worker.id)) {
        throw new Error('The previous operation is still stopping. Wait before continuing.');
      }

      parseRpcParams(serviceRpcRegistry, method, params);

      if (worker.control?.mode !== 'stopped') {
        return { ready: worker.control?.mode === 'fresh' };
      }

      // Crash recovery must retire the old queue before rearming the task.
      if (worker.queue.length > 0) {
        this.archiveQueue(worker, worker.control.operationId);
        worker.queue = [];
        worker.cursor = 0;
      }

      worker.control.mode = 'fresh';
      worker.error = undefined;
      task.move('paused');
      task.save();
      task.event(
        'control',
        'Fresh continuation requested. Completed files and history retained; ' +
          'old unexecuted proposals will not run.',
      );

      return { ready: true, epoch: worker.control.epoch };
    }

    this.checkRunGate(worker, method, params.epoch);

    switch (method) {
      case 'worker.reveal': {
        parseRpcParams(serviceRpcRegistry, method, params);
        await revealProject(project.root);
        return { opened: true };
      }
      case 'worker.read': {
        const input = parseRpcParams(serviceRpcRegistry, method, params);
        return this.locks.using(project.root, new AbortController().signal, () =>
          fileText(project.root, input.path),
        );
      }
      case 'worker.browse': {
        const input = parseRpcParams(serviceRpcRegistry, method, params);

        return {
          root: project.root,
          files: await listFiles(project.root, input.path),
        };
      }
      case 'worker.asset': {
        const input = parseRpcParams(serviceRpcRegistry, method, params);
        return readAsset(project.root, input.path, input.offset, input.length, input.stamp);
      }
      case 'worker.openFile': {
        const input = parseRpcParams(serviceRpcRegistry, method, params);
        return openTaskFile(project.root, input.path, input.application);
      }
      case 'worker.followups': {
        parseRpcParams(serviceRpcRegistry, method, params);
        return this.followups.list(worker.id);
      }
      case 'worker.followup': {
        const request = parseFollowup(params.request);
        parseRpcParams(serviceRpcRegistry, method, params);
        const followup = await this.locks.using(project.root, new AbortController().signal, () =>
          this.followups.enqueue(worker, project.root, request, () =>
            this.checkExpectedRun(worker, method, params),
          ),
        );
        task.event('followup', 'Follow-up queued: ' + followup.instruction);

        return followup;
      }
      case 'worker.followupCancel': {
        const followup = this.followups.get(id(params.id));

        if (
          !followup ||
          followup.workerId !== worker.id ||
          !['queued', 'blocked'].includes(followup.status)
        ) {
          throw new Error('Only a queued follow-up can be removed.');
        }

        parseRpcParams(serviceRpcRegistry, method, params);
        followup.status = 'cancelled';
        followup.finishedAt = Date.now();
        this.followups.save(followup);
        this.changed();

        return { cancelled: true };
      }
      case 'worker.followupActivate': {
        parseRpcParams(serviceRpcRegistry, method, params);
        return this.locks.using('followup:' + worker.id, new AbortController().signal, () =>
          this.activateFollowup(task, project, () => this.checkExpectedRun(worker, method, params)),
        );
      }
      case 'worker.team': {
        parseRpcParams(serviceRpcRegistry, method, params);
        const peers = [...this.workers.values()]
          .filter((peer) => peer.projectId === worker.projectId && peer.id !== worker.id)
          .map((peer) => ({
            id: peer.id,
            name: peer.name,
            state: peer.state,
            branch: peer.worktree?.branch ?? 'Shared workspace',
            held: this.team.reason(peer.id),
          }));

        return { peers, messages: this.team.messages(worker.projectId) };
      }
      case 'worker.teamMessage': {
        const message: Record<string, unknown> = {
          type: 'team_message',
          message: params.message,
        };

        if (params.to !== undefined) {
          message.to = params.to;
        }

        const action = parseAction(message);

        if (action.type !== 'team_message') {
          throw new Error('Invalid message');
        }

        const messageId = id(params.id);
        parseRpcParams(serviceRpcRegistry, method, params);
        const result = this.team.execute(worker, action, messageId);
        this.changed();

        return result;
      }
      case 'worker.bridgeLoad': {
        parseRpcParams(serviceRpcRegistry, method, params);
        return this.progress.load(worker);
      }
      case 'worker.bridgeSave': {
        this.progress.assertSaveEpoch(worker, params.epoch);
        const input = parseRpcParams(serviceRpcRegistry, method, params, 'Invalid task progress binding.');
        const saved = this.progress.save(worker, input.progress, input.epoch);
        this.changed();

        return saved;
      }
      case 'worker.bridgeExtend': {
        const input = parseRpcParams(serviceRpcRegistry, method, params);
        const next = this.progress.extend(worker, input.confirm);
        task.event('budget', 'User added 15 chat turns and 30 active minutes. Previous progress retained.');

        return next;
      }
      case 'worker.rename': {
        const name = parseDisplayName(params.name, 'task name');
        parseRpcParams(serviceRpcRegistry, method, params);
        worker.name = name;
        task.save();

        return worker;
      }
      case 'worker.prompt': {
        const input = parseRpcParams(serviceRpcRegistry, method, params);
        const kind = input.kind;
        let controlPrompt = '';

        if (worker.control) {
          controlPrompt =
            '\n\nRUN CONTROL: The user interrupted an earlier plan. Keep completed file edits ' +
            'and task history. Earlier unexecuted proposals are retired. ' +
            'Read the relevant current files and ' +
            'plan again; never assume a displayed earlier reply executed.';
        }

        return (
          chatPrompt(worker, project, kind) +
          this.followups.prompt(worker) +
          controlPrompt +
          (await this.team.context(worker, project))
        );
      }
      case 'worker.history': {
        let before = Number.MAX_SAFE_INTEGER;

        if (params.before !== undefined) {
          before = integer(params.before, 'history cursor', 1, Number.MAX_SAFE_INTEGER);
        }

        parseRpcParams(serviceRpcRegistry, method, params);
        const rows = this.store.taskEvents(worker.id, before);
        const events = rows.slice(0, 100).map((event) => ({
          ...event,
          message: event.message.slice(0, 2400),
        }));

        return {
          events,
          hasMore: rows.length > 100,
          before: events.at(-1)?.id ?? null,
        };
      }
      case 'worker.report': {
        parseRpcParams(serviceRpcRegistry, method, params);
        return this.report(worker, project) + (await this.team.context(worker, project));
      }
      case 'worker.handoffSeen': {
        const input = parseRpcParams(serviceRpcRegistry, method, params);
        return {
          seen: this.store.envelopeOwner(input.envelopeId) === worker.id,
        };
      }
      case 'worker.change': {
        const input = parseRpcParams(serviceRpcRegistry, method, params);
        return this.locks.using(project.root, new AbortController().signal, () =>
          reviewFile(this.store, worker.runId, project.root, input.path),
        );
      }
      case 'worker.syntax': {
        const input = parseRpcParams(serviceRpcRegistry, method, params);
        const signal = new AbortController().signal;

        return this.locks.using(project.root, signal, () =>
          checkJavaScript(project.root, input.path, this.dataDir, signal),
        );
      }
      case 'worker.restoreFile': {
        return this.restoreFile(task, project, params);
      }
      case 'worker.files': {
        parseRpcParams(serviceRpcRegistry, method, params);
        const latest = new Map<string, ReturnType<Store['changedFiles']>[number]>();

        for (const edit of this.store.changedFiles(worker.runId)) {
          if (!latest.has(edit.path)) {
            latest.set(edit.path, edit);
          }
        }

        return [...latest.values()];
      }
      case 'worker.validateReply': {
        try {
          const handoff = parseHandoffText(params.text);
          parseRpcParams(serviceRpcRegistry, method, params);
          const envelope = parseProposalEnvelope(handoff);

          if (envelope.workerId !== worker.id || envelope.projectId !== project.id) {
            throw new Error('This reply belongs to a different task or project.');
          }

          this.validateProposal(worker, project, envelope);
          return { valid: true };
        } catch (error) {
          if (error instanceof ReplyValidationError) {
            return { valid: false, issue: error.issue };
          }

          throw error;
        }
      }
      case 'worker.import': {
        return this.importHandoff(task, project, params);
      }
      case 'worker.run': {
        if (params.envelopeId !== undefined) {
          return this.startDelivery(task, params);
        }

        if (params.envelopeHash !== undefined) {
          throw new Error(
            'Starting an accepted handoff requires its envelope ID and exact hash. No actions were started.',
          );
        }

        parseRpcParams(serviceRpcRegistry, method, params);
        this.run(worker.id);
        return { started: true };
      }
      case 'worker.resume': {
        parseRpcParams(serviceRpcRegistry, method, params);
        this.run(worker.id);
        return { started: true };
      }
      case 'worker.pause':
      case 'worker.cancel': {
        return this.pauseOrCancel(task, method, params);
      }
      case 'worker.approve': {
        return this.approve(task, project, params);
      }
      case 'worker.skip': {
        task.assertIdle();

        if (params.confirm !== true) {
          throw new Error('Explicit confirmation is required.');
        }

        const batch = worker.queue[0];

        if (!batch) {
          throw new Error('No queued action to skip.');
        }

        parseRpcParams(serviceRpcRegistry, method, params);
        const skipped = batch.actions[worker.cursor];

        if (skipped && isFileEdit(skipped)) {
          const marker: SkippedEdit = {
            workerId: worker.id,
            runId: worker.runId,
            actionHash: editDigest(JSON.stringify(skipped)),
          };
          this.store.set(`edit-skipped:${batch.id}_${worker.cursor}`, marker);
        }

        task.event('user', 'User skipped a quarantined or unwanted action.');
        worker.cursor++;
        task.discardCompletedBatch(batch);

        worker.pending = undefined;
        worker.approvedFingerprint = undefined;
        worker.error = undefined;
        task.move('paused');
        task.save();

        return { skipped: true };
      }
      case 'worker.rollback': {
        task.assertIdle();

        if (params.confirm !== true) {
          throw new Error('Confirm rollback; command side effects cannot be undone.');
        }

        parseRpcParams(serviceRpcRegistry, method, params);
        const controller = new AbortController();
        const result = await this.locks.using(project.root, controller.signal, () => {
          this.checkExpectedRun(worker, method, params);
          return this.workspace.rollback(project, worker.runId);
        });
        task.discardPlan();
        worker.error = undefined;
        task.move('paused');
        task.save();
        task.event('rollback', JSON.stringify(result));

        return result;
      }
      case 'worker.accept': {
        return this.acceptLegacyCompletion(task, params);
      }
      default: {
        throw new Error('Unknown request method.');
      }
    }
  }

  private async createWorker(params: Record<string, unknown>): Promise<Worker> {
    if (this.workers.size >= 200) {
      throw new Error('This preview supports at most 200 saved tasks. Closing a tab preserves its record.');
    }

    const project = this.catalog.get(params.projectId);
    const creation = parseWorkerCreation(params);
    parseRpcParams(serviceRpcRegistry, 'worker.create', params);
    const worker: Worker = {
      id: randomUUID(),
      projectId: project.id,
      ...creation,
      state: 'idle',
      queue: [],
      cursor: 0,
      runId: randomUUID(),
      iteration: 0,
      startedAt: 0,
      autoCommands: false,
      observations: [],
      repeatCount: 0,
      createdAt: Date.now(),
    };

    if (params.workspaceMode === 'worktree') {
      worker.worktree = await createWorktree(project.root, this.dataDir, worker.id);
    } else if (params.workspaceMode !== undefined && params.workspaceMode !== 'shared') {
      throw new Error('Choose shared workspace or worktree.');
    }

    const task = this.register(worker);
    task.save();
    task.event('created', 'Worker created. Nothing runs until you press Run.');

    return worker;
  }

  private async updateSettings(value: unknown): Promise<Settings> {
    if (this.activeTasks.length > 0) {
      throw new Error('Pause all workers before changing model settings.');
    }

    const next = parseModelSettings(value);
    parseRpcParams(serviceRpcRegistry, 'settings.update', { settings: value });

    if (next.coderModelPath) {
      if (!path.isAbsolute(next.coderModelPath) || !next.coderModelPath.toLowerCase().endsWith('.gguf')) {
        throw new Error('Select an absolute local .gguf file path. URLs are not accepted.');
      }

      if (!(await fs.stat(next.coderModelPath)).isFile()) {
        throw new Error('Select a local .gguf file, not a directory.');
      }
    }

    // Filesystem checks yield; a worker may have started in the meantime.
    if (this.activeTasks.length > 0) {
      throw new Error('Pause all workers before changing model settings.');
    }

    this.store.set('settings', next);
    this.settings = next;
    this.models.close();
    this.changed();

    return this.settings;
  }

  private checkExpectedRun(worker: Worker, method: string, params: Record<string, unknown>): void {
    if (params.expectedRun === undefined) {
      return;
    }

    const parsed = taskBoundarySchema.safeParse(params.expectedRun);

    if (!parsed.success) {
      throw new Error('The reviewed task boundary is invalid. Review the current task before applying it.', {
        cause: parsed.error,
      });
    }

    const expected = parsed.data;
    let sameRun = expected.runId === worker.runId;

    if (method === 'worker.run' && params.envelopeId !== undefined) {
      // Import may start a new run. The exact saved delivery must prove that run,
      // hash and epoch in startDelivery(), not the obsolete pre-import review ID.
      sameRun = true;
    }

    if (!sameRun || expected.epoch !== (worker.control?.epoch ?? 0)) {
      throw new Error(
        'This review belongs to an earlier task run. Nothing was changed; review the current task before applying it.',
      );
    }
  }

  private checkRunGate(worker: Worker, method: string, epoch: unknown): void {
    if (!gatedMethods.has(method)) {
      return;
    }

    if (this.interruptions.has(worker.id) || worker.control?.mode === 'stopped') {
      throw new Error('This task is stopped. Use Continue fresh; the old plan will not be replayed.');
    }

    if (epochMethods.has(method) && worker.control && (epoch ?? 0) !== worker.control.epoch) {
      throw new Error('This operation belongs to an earlier run. It was not executed.');
    }

    if (epoch !== undefined) {
      integer(epoch, 'epoch', 0, Number.MAX_SAFE_INTEGER);
    }
  }

  private async restoreFile(
    task: TaskRuntime,
    project: Project,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const worker = task.worker;
    task.assertIdle();

    if (params.confirm !== true) {
      throw new Error('Confirm restoring this journaled file.');
    }

    const stopped =
      worker.state === 'complete' || worker.state === 'cancelled' || worker.control?.mode === 'stopped';

    if (worker.queue.length > 0 || !stopped) {
      throw new Error('Stop the task before restoring a file while work is unfinished.');
    }

    const relative = text(params.path, 'file path', 1000);
    const expected = text(params.expectedHash, 'reviewed hash', 64);

    if (!/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error('Restore requires the current reviewed file hash.');
    }

    parseRpcParams(serviceRpcRegistry, 'worker.restoreFile', params);
    const result = await this.locks.using(project.root, new AbortController().signal, () => {
      this.checkExpectedRun(worker, 'worker.restoreFile', params);
      return this.workspace.rollback(project, worker.runId, relative, expected);
    });
    worker.completion = undefined;
    worker.humanAcceptanceReady = false;
    worker.error = undefined;
    worker.autoCommands = false;

    if (worker.state !== 'cancelled') {
      task.move('paused');
    }

    task.save();
    task.event('restore-file', 'Restored recorded edits for ' + relative + '. Other files were not changed.');

    return result;
  }

  private importHandoff(task: TaskRuntime, project: Project, params: Record<string, unknown>): unknown {
    const worker = task.worker;
    const reconcile = parseOptionalFlag(params.reconcile, 'handoff reconciliation');
    const envelope = parseProposalEnvelope(parseHandoffText(params.text));

    if (envelope.workerId !== worker.id || envelope.projectId !== project.id) {
      throw new Error('This handoff belongs to a different worker or project. Switch to its tab.');
    }

    parseRpcParams(serviceRpcRegistry, 'worker.import', params);

    // Reconciliation acknowledges only an exact retry. The epoch gate has
    // already run, even when Stop or Steer retired this batch.
    if (this.store.hasEnvelope(envelope.id)) {
      if (reconcile !== true) {
        throw new Error('This handoff was already imported. Duplicate execution is blocked.');
      }

      matchingDelivery(this.store, worker, envelope.id, digest(JSON.stringify(envelope)));
      return {
        queued: worker.queue.some((batch) => batch.id === envelope.id),
        acknowledged: true,
      };
    }

    task.assertIdle();

    if (worker.control) {
      if (envelope.replyTo && worker.control.retiredExchanges.includes(envelope.replyTo)) {
        throw new Error('This reply belongs to a stopped exchange. No actions were imported.');
      }

      if (worker.control.mode === 'fresh') {
        const savedProgress = parseTaskProgress(this.store.get(progressKey(worker.id)));

        if (
          !savedProgress?.lastReceipt?.exchangeId ||
          envelope.replyTo !== savedProgress.lastReceipt.exchangeId ||
          !['commit_intent', 'waiting_reply'].includes(savedProgress.stage)
        ) {
          throw new Error(
            'Fresh continuation requires a reply to its new request. Old replies cannot be reused.',
          );
        }
      }
    }

    if (worker.queue.length >= 20) {
      throw new Error('Queue is full (20 batches).');
    }

    const executable = this.validateProposal(worker, project, envelope);
    task.newRunIfNeeded();
    worker.humanAcceptanceReady = false;
    worker.completion = undefined;
    // Approval trust belongs to the previously reviewed batch, never new content.
    worker.autoCommands = false;

    const delivery: HandoffDelivery = {
      version: 1,
      workerId: worker.id,
      projectId: worker.projectId,
      runId: worker.runId,
      epoch: worker.control?.epoch ?? 0,
      hash: digest(JSON.stringify(envelope)),
      started: false,
    };
    this.store.transaction(() => {
      this.store.rememberEnvelope(envelope.id, worker.id);
      this.store.set(deliveryKey(envelope.id), delivery);

      if (worker.control) {
        worker.control.mode = 'active';
      }

      worker.queue.push(executable);
      this.store.saveWorker(worker);
    });

    worker.pending = undefined;
    worker.approvedFingerprint = undefined;
    worker.error = undefined;
    task.move('queued');
    task.save();
    task.event('import', envelope.summary);

    return { queued: true };
  }

  private startDelivery(task: TaskRuntime, params: Record<string, unknown>): unknown {
    const worker = task.worker;
    const envelopeId = id(params.envelopeId, 'envelope ID');
    const hash = text(params.envelopeHash, 'envelope hash', 64);
    const delivery = matchingDelivery(this.store, worker, envelopeId, hash);
    parseRpcParams(serviceRpcRegistry, 'worker.run', params);

    if (delivery.started) {
      // A lost start acknowledgement cannot run a command or edit again.
      return { started: true, acknowledged: true, state: worker.state };
    }

    if (
      task.running ||
      worker.state !== 'queued' ||
      worker.queue[0]?.id !== envelopeId ||
      worker.cursor !== 0 ||
      worker.pending ||
      worker.error
    ) {
      throw new Error(
        'The accepted batch is not at its untouched queue head. Review local work before continuing.',
      );
    }

    // Start intent is durable before any side effect is scheduled. On restart,
    // this boundary stays paused rather than automatically replaying the batch.
    this.store.set(deliveryKey(envelopeId), { ...delivery, started: true });
    this.run(worker.id);

    return { started: true };
  }

  private pauseOrCancel(task: TaskRuntime, method: string, params: Record<string, unknown>): unknown {
    const worker = task.worker;
    const epoch = params.epoch;
    if (epoch !== undefined && epoch !== (worker.control?.epoch ?? 0)) {
      throw new Error('This cancellation belongs to an earlier run. Current work was not changed.');
    }

    parseRpcParams(serviceRpcRegistry, method, params);

    // A final verification may have completed before this request arrived.
    if (method === 'worker.pause' && worker.state === 'complete' && !task.running) {
      return { stopping: false, completed: true };
    }

    if (
      method === 'worker.pause' &&
      worker.state === 'review' &&
      worker.queue.length === 0 &&
      !task.running
    ) {
      return { stopping: false, review: true };
    }

    task.abort(new Error('Stopped by user.'));
    let state: Worker['state'] = 'cancelled';

    if (method === 'worker.pause') {
      state = 'paused';
    }

    task.move(state);
    worker.pending = undefined;
    worker.approvedFingerprint = undefined;
    worker.autoCommands = false;

    if (method === 'worker.cancel') {
      worker.queue = [];
      worker.cursor = 0;
      this.followups.finish(worker, 'cancelled');
    }

    this.team.releaseOwner(worker.id);
    task.save();

    return { stopping: task.running };
  }

  private approve(task: TaskRuntime, project: Project, params: Record<string, unknown>): unknown {
    const worker = task.worker;
    task.assertIdle();

    if (!worker.pending || worker.pending.token !== params.token) {
      throw new Error('Approval expired or does not match this worker.');
    }

    const approve = parseOptionalFlag(params.approve, 'approval choice');
    const trustRun = parseOptionalFlag(params.trustRun, 'command trust');
    parseRpcParams(serviceRpcRegistry, 'worker.approve', params);

    if (approve !== true) {
      worker.pending = undefined;
      worker.error = 'Action denied by user.';
      task.move('blocked');
      task.save();

      return { denied: true };
    }

    if (worker.pending.revision !== project.revision) {
      worker.pending = undefined;
      task.move('blocked');
      task.save();
      throw new Error('Workspace changed while approval was pending. Run again to review a fresh approval.');
    }

    worker.approvedFingerprint = worker.pending.fingerprint;
    worker.autoCommands = trustRun === true;
    worker.pending = undefined;
    worker.error = undefined;
    task.move('queued');
    task.save();
    this.run(worker.id);

    return { approved: true };
  }

  private acceptLegacyCompletion(task: TaskRuntime, params: Record<string, unknown>): unknown {
    const worker = task.worker;
    const confirm = params.confirm;
    task.assertIdle();

    // A completed task is idempotent; old clients cannot fabricate a review.
    if (confirm === true && worker.state === 'complete' && worker.queue.length === 0) {
      parseRpcParams(serviceRpcRegistry, 'worker.accept', params);
      return { accepted: false, alreadyComplete: true };
    }

    if (
      confirm !== true ||
      worker.state !== 'review' ||
      worker.queue.length > 0 ||
      worker.humanAcceptanceReady !== true ||
      (worker.checks.length > 0 && !worker.activeFollowupId)
    ) {
      throw new Error(
        'Only an explicit finish with no objective checks can be manually accepted. ' +
          'A listed folder is not a completed goal.',
      );
    }

    parseRpcParams(serviceRpcRegistry, 'worker.accept', params);
    worker.completion = {
      version: 1,
      verification: 'legacy-accepted',
      summary: 'Manually accepted through a legacy client.',
      checked: worker.checks.length,
      at: Date.now(),
    };
    this.followups.finish(worker, 'completed');
    task.move('complete');
    worker.autoCommands = false;
    task.save();
    task.event('user', 'Goal accepted by the user (not independently proven by the model).');

    return { accepted: true };
  }

  /** Persist the stop fence before aborting; archive the cursor only after owned
   * execution settles. Already committed writes are never implicitly rolled back. */
  private async interruptTask(
    task: TaskRuntime,
    project: Project,
    params: Record<string, unknown>,
    steer: boolean,
  ): Promise<ControlResult> {
    const worker = task.worker;
    let request: ReturnType<typeof parseFollowup> | undefined;

    if (steer) {
      request = parseFollowup(params.request);

      if (!request.instruction.trim()) {
        throw new Error('Enter a steering instruction.');
      }
    }

    const operationId = id(request?.id ?? params.id, 'operation ID');
    const key = 'miter.controlOperation.' + operationId;
    const signature = digest(JSON.stringify({ workerId: worker.id, steer, request }));
    const previous = readControlOperation(this.store.get(key), operationId);

    if (previous) {
      if (previous.signature !== signature) {
        throw new Error('This control ID was used for another request.');
      }

      return previous.result;
    }

    if (this.interruptions.has(worker.id)) {
      throw new Error('This task is already stopping. Wait for it to finish.');
    }

    if (steer) {
      parseRpcParams(serviceRpcRegistry, 'worker.steer', params);
    } else {
      parseRpcParams(serviceRpcRegistry, 'worker.stop', params);
    }

    this.interruptions.add(worker.id);
    let stateMayHaveChanged = false;

    try {
      // Invalid selections must not replace a valid running request.
      if (request) {
        await this.followups.validateSteering(worker, project.root, request);
      }

      const raw = this.store.get(progressKey(worker.id));
      const progress = parseTaskProgress(raw);

      if (raw !== undefined && !progress) {
        throw new Error('Saved progress is incompatible. It was not overwritten.');
      }

      const retired = [...(worker.control?.retiredExchanges ?? [])];

      if (progress?.lastReceipt?.exchangeId && !retired.includes(progress.lastReceipt.exchangeId)) {
        retired.push(progress.lastReceipt.exchangeId);
      }

      let kind: 'steer' | 'stop' = 'stop';
      let reason = 'Stopped by you.';
      let abortMessage = 'Stopped by user.';

      if (steer) {
        kind = 'steer';
        reason = 'Steering instruction requested.';
        abortMessage = 'Steered by user.';
      }

      const nextControl = parseSchema(taskControlSchema, {
        version: 1,
        epoch: advanceCounter(worker.control?.epoch ?? 0, 'Task epoch'),
        mode: 'stopped',
        at: Date.now(),
        operationId,
        reason,
        retiredExchanges: retired,
      });
      let stoppedProgress: TaskProgress | undefined;
      let followupProgress: TaskProgress | undefined;
      let maxIterations = worker.maxIterations;

      if (progress) {
        stoppedProgress = parseProgressUpdate({
          ...progress,
          revision: advanceCounter(progress.revision, 'Task progress revision'),
          stage: 'report_due',
          phase: 'stopped',
          reason: 'Stopped. Completed files kept; next continuation replans from current files.',
          errorCode: undefined,
          lastReceipt: undefined,
          approvedReply: undefined,
          formatRepairs: 0,
          repeats: 0,
          lastActionsHash: undefined,
        });

        if (request) {
          // Reserve both revisions before publishing a stop; steering must not
          // discover an exhausted successor after retiring the current plan.
          followupProgress = prepareFollowupProgress(stoppedProgress, stoppedProgress.reason);
        }
      }

      if (request) {
        maxIterations = Math.max(
          worker.maxIterations,
          advanceCounter(worker.iteration, 'Task iteration budget', 8),
        );
      }

      // The new epoch and progress revision are durable before abort callbacks
      // can yield. Stale imports/saves stay fenced even after a host crash.
      this.store.transaction(() => {
        const archive: ControlArchive = {
          workerId: worker.id,
          runId: worker.runId,
          progress,
          queue: worker.queue,
          cursor: worker.cursor,
          at: Date.now(),
          kind,
        };
        this.store.set('miter.controlArchive.' + operationId, archive);
        if (stoppedProgress) {
          this.store.set(progressKey(worker.id), stoppedProgress);
        }

        this.store.saveWorker({ ...worker, control: nextControl });
      });
      worker.control = nextControl;
      stateMayHaveChanged = true;

      task.abort(new Error(abortMessage));
      this.changed();
      await task.wait();
      this.archiveQueue(worker, operationId);
      task.discardPlan();
      worker.error = undefined;
      this.team.releaseOwner(worker.id);
      task.move('paused');

      const control = worker.control;

      if (!control) {
        throw new Error('Run-control state was lost. Work remains stopped.');
      }

      if (request) {
        const followup = await this.locks.using(project.root, new AbortController().signal, () =>
          this.followups.enqueue(worker, project.root, request),
        );

        if (followup.status !== 'queued') {
          throw new Error('That steering request was already used. Submit a new request.');
        }

        this.followups.finish(worker, 'superseded');
        followup.status = 'active';
        followup.activatedAt = Date.now();
        this.followups.save(followup);
        worker.activeFollowupId = followup.id;
        control.mode = 'fresh';

        if (followupProgress) {
          this.store.set(progressKey(worker.id), followupProgress);
        }

        worker.maxIterations = maxIterations;
      }

      task.save();
      let message =
        'Stopped. Completed file changes kept; remaining plan archived. ' +
        'Continue fresh will inspect the current files.';

      if (request) {
        message = 'Steering now: ' + request.instruction;
      }

      task.event('control', message);
      const result: ControlResult = {
        stopped: !steer,
        ready: steer,
        epoch: control.epoch,
        operationId,
      };
      const operation: ControlOperation = { signature, result };
      this.store.set(key, operation);

      return result;
    } finally {
      this.interruptions.delete(worker.id);

      if (stateMayHaveChanged) {
        task.save();
      }
    }
  }

  private async activateFollowup(
    task: TaskRuntime,
    project: Project,
    assertCurrentRun?: () => void,
  ): Promise<FollowupActivation> {
    const worker = task.worker;
    assertCurrentRun?.();
    if (task.running || worker.queue.length > 0 || worker.pending || this.team.reason(worker.id)) {
      return {
        activated: false,
        reason: 'Current work must reach a safe boundary first.',
      };
    }

    if (worker.activeFollowupId && this.followups.get(worker.activeFollowupId)?.status === 'active') {
      return {
        activated: false,
        reason: 'The current follow-up is still in progress.',
      };
    }

    const raw = this.store.get(progressKey(worker.id));
    const progress = parseTaskProgress(raw);

    if (raw !== undefined && !progress) {
      throw new Error('Saved progress is incompatible; it was not reset.');
    }

    if (progress && ['commit_intent', 'waiting_reply', 'prepared', 'local_batch'].includes(progress.stage)) {
      return {
        activated: false,
        reason: 'Confirm the pending chat exchange before starting a follow-up.',
      };
    }

    const next = this.followups
      .list(worker.id)
      .find((followup) => followup.status === 'queued' || followup.status === 'blocked');

    if (!next || next.status === 'blocked') {
      return { activated: false, reason: next?.error };
    }

    if (!['idle', 'review', 'complete', 'paused', 'blocked', 'cancelled'].includes(worker.state)) {
      return { activated: false };
    }

    const maxIterations = Math.max(
      worker.maxIterations,
      advanceCounter(worker.iteration, 'Task iteration budget', 8),
    );
    let followupProgress: TaskProgress | undefined;

    if (progress) {
      followupProgress = prepareFollowupProgress(progress, 'Follow-up ready in the same conversation.');
    }

    try {
      await this.locks.using(project.root, new AbortController().signal, () =>
        this.followups.checkSelection(next, project.root, assertCurrentRun),
      );
    } catch (error) {
      this.changed();
      throw error;
    }

    assertCurrentRun?.();
    this.store.transaction(() => {
      // Follow-ups are additive history, not replacements for earlier requests.
      if (worker.activeFollowupId && this.followups.get(worker.activeFollowupId)?.status !== 'completed') {
        this.followups.finish(worker, 'superseded');
      }

      next.status = 'active';
      next.activatedAt = Date.now();
      this.followups.save(next);
      worker.activeFollowupId = next.id;
      worker.error = undefined;
      worker.humanAcceptanceReady = false;
      worker.completion = undefined;
      worker.autoCommands = false;
      worker.pending = undefined;
      worker.approvedFingerprint = undefined;
      worker.repeatCount = 0;
      worker.lastProposal = undefined;
      worker.maxIterations = maxIterations;

      if (progress && followupProgress) {
        this.store.set('miter.followup.checkpoint.' + next.id, progress);
        this.store.set(progressKey(worker.id), followupProgress);
      }

      this.store.saveWorker(worker);
    });

    task.move('paused');
    task.save();
    task.event('followup', 'Continuing this task: ' + next.instruction);

    return { activated: true, id: next.id };
  }

  /** Admission binds immutable read references; it never repairs model content
   * or substitutes a live hash. File preflight still runs under the project lock. */
  private validateProposal(worker: Worker, project: Project, envelope: ProposalEnvelope): Envelope {
    for (const [index, action] of envelope.actions.entries()) {
      if (action.type === 'finish' && index !== envelope.actions.length - 1) {
        throw new Error('finish must be the final action in a batch.');
      }

      if ('path' in action) {
        validateRelative(action.path, action.type === 'list');
      }

      if (action.type === 'command' && !project.profiles.some((profile) => profile.id === action.profileId)) {
        throw new Error(`Register the command profile ${action.profileId} yourself before importing it.`);
      }
    }

    return this.reads.resolve(worker, project, envelope);
  }

  run(workerId: string): void {
    if (this.closed) {
      throw new Error('Host is shutting down.');
    }

    const task = this.task(workerId);
    const worker = task.worker;
    task.assertIdle();

    if (this.interruptions.has(worker.id) || worker.control?.mode === 'stopped') {
      throw new Error('Task stopped. Use Continue fresh before running.');
    }

    if (worker.control?.mode === 'fresh' && worker.mode === 'local') {
      worker.control.mode = 'active';
      task.save();
    }

    if (worker.state === 'awaiting_approval') {
      throw new Error('Approve or reject the pending action first.');
    }

    if (worker.mode === 'handoff' && worker.queue.length === 0) {
      throw new Error('Import a handoff first. Or create a Local mode worker.');
    }

    task.newRunIfNeeded();
    worker.error = undefined;
    worker.startedAt = Date.now();
    let state: Worker['state'] = 'planning';

    if (worker.queue.length > 0) {
      state = 'queued';
    }

    task.move(state);
    task.save();

    task.start((signal) => this.loop(task, signal));
  }

  async wait(workerId: string): Promise<void> {
    await this.tasks.get(workerId)?.wait();
  }

  private async planLocalBatch(task: TaskRuntime, project: Project, signal: AbortSignal): Promise<Envelope> {
    const worker = task.worker;
    if (worker.iteration >= worker.maxIterations) {
      throw new Error('Iteration budget reached. Create a new worker or review the remaining scope.');
    }

    if (!this.settings.coderModelPath) {
      throw new Error(
        'Configure a local GGUF coding model in Settings. No cloud or pretend model is substituted.',
      );
    }

    task.move('planning');

    if (worker.observations.length === 0) {
      const files = await this.locks.using(project.root, signal, () => listFiles(project.root));
      task.remember('Initial project files: ' + JSON.stringify(files));
    }

    task.move('waiting_model');
    worker.iteration++;
    task.save();

    const context = await this.team.context(worker, project);
    const generated = parseModelOutput(
      await this.locks.using('inference', signal, () =>
        this.models.propose(localPrompt(worker, project) + this.followups.prompt(worker) + context, signal),
      ),
    );
    signal.throwIfAborted();

    const rawProposal: unknown = JSON.parse(generated);
    const draft = parseLocalDraft(rawProposal);
    const actions = draft.actions;
    const fingerprint = digest(JSON.stringify(actions));

    if (worker.lastProposal === fingerprint) {
      worker.repeatCount++;
    } else {
      worker.repeatCount = 0;
    }

    worker.lastProposal = fingerprint;

    if (worker.repeatCount >= 2) {
      throw new Error('Model repeated the same proposal three times. Stopped to avoid a loop.');
    }

    worker.error = undefined;
    const batch = this.validateProposal(worker, project, {
      protocol: VERSION,
      id: randomUUID(),
      workerId: worker.id,
      projectId: project.id,
      summary: draft.readSummary(),
      actions,
    });

    // A fresh local proposal also ends any trust granted to the previous batch.
    worker.autoCommands = false;
    this.store.transaction(() => {
      this.store.rememberEnvelope(batch.id, worker.id);
      worker.queue.push(batch);
      worker.cursor = 0;
      this.store.saveWorker(worker);
    });
    task.event('plan', batch.summary);

    return batch;
  }

  private async loop(task: TaskRuntime, signal: AbortSignal): Promise<void> {
    const worker = task.worker;
    const project = this.catalog.executionProject(worker);

    while (!this.closed) {
      signal.throwIfAborted();

      while (this.team.reason(worker.id)) {
        signal.throwIfAborted();
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }

      if (Date.now() - worker.startedAt > worker.maxMinutes * 60000) {
        throw new Error('Active run time budget reached. Review progress before continuing.');
      }

      let batch = worker.queue[0];

      if (!batch) {
        if (worker.mode === 'handoff') {
          task.move('review');
          worker.autoCommands = false;
          task.event(
            'handoff',
            'Batch finished. Export the report or import the next handoff. ' +
              'The goal has not been declared complete.',
          );
          return;
        }

        batch = await this.planLocalBatch(task, project, signal);
      }

      if (worker.cursor >= batch.actions.length) {
        task.discardCompletedBatch(batch);
        task.save();
        continue;
      }

      const action = batch.actions[worker.cursor];

      if (!action) {
        throw new Error('Queued action cursor is invalid. Inspect the saved plan before continuing.');
      }

      const actionId = `${batch.id}_${worker.cursor}`;
      task.move('waiting_lock');
      let finished = false;
      // Capture the admitted batch once, rather than asserting its presence in
      // callbacks that yield while Stop waits for this exact execution to settle.
      const executingBatch = batch;

      try {
        if (isFileEdit(action)) {
          await this.locks.using(project.root, signal, async () => {
            task.move('executing');
            signal.throwIfAborted();
            // Preflight the entire contiguous segment before writing any part,
            // and keep one project lock through publication of every edit.
            const plan = await this.workspace.plan(
              project,
              worker.id,
              worker.runId,
              executingBatch,
              worker.cursor,
            );
            signal.throwIfAborted();

            for (const step of plan.steps) {
              signal.throwIfAborted();
              const result = await this.workspace.commitStep(project, worker.id, worker.runId, step);
              task.recordAction(step.action, result);
              // Journal publication precedes cursor advancement. Recovery uses
              // the exact journal chain, never blindly replays the earlier write.
              worker.cursor = step.index + 1;
              task.save();
            }

            worker.cursor = plan.end;
          });

          task.discardCompletedBatch(executingBatch);
          task.save();
          continue;
        }

        await this.locks.using(project.root, signal, async () => {
          task.move('executing');
          signal.throwIfAborted();

          if (action.type === 'ask') {
            worker.cursor++;
            task.remember('Question for user: ' + action.question);
            throw new UserQuestion(action.question);
          }

          if (action.type === 'finish') {
            if (worker.queue.length > 1) {
              task.remember('Completion deferred: more queued batches remain.');
              return;
            }

            task.move('verifying');
            const result = await this.verify(task, project, action, actionId, signal);
            task.remember(JSON.stringify(result));

            if (!result.ok) {
              if (worker.mode === 'local') {
                task.event('verify', 'Verification failed. Returning evidence to the local coder.');
                return;
              }

              throw new Error('Goal verification failed. Export the report and fix the failing checks.');
            }

            worker.queue = [];
            worker.cursor = 0;
            worker.autoCommands = false;
            worker.humanAcceptanceReady = false;
            worker.completion = buildCompletion(
              worker,
              result.verification,
              action.summary,
              result.results.length,
              Date.now(),
            );
            this.followups.finish(worker, 'completed');
            this.team.releaseOwner(worker.id);
            task.move('complete');

            let message = 'Finished. No automated checks were configured.';

            if (worker.checks.length > 0) {
              message = 'Finished. Configured checks passed.';
            }

            task.event('goal', message);
            finished = true;
            return;
          }

          let result: unknown;
          let commandFailed = false;

          if (action.type === 'command') {
            const commandResult = await this.executeCommand(task, project, action, actionId, signal);
            result = commandResult;
            commandFailed = commandResult.code !== 0;
          } else {
            result = await this.execute(task, project, action, actionId, signal);
          }

          task.recordAction(action, result);

          if (commandFailed) {
            // Drop the stale remainder after a failing command. Local workers
            // replan from the evidence; handoff workers require a fresh reply.
            worker.cursor = executingBatch.actions.length;

            if (worker.mode === 'handoff') {
              throw new Error(
                'Command failed. Remaining actions were stopped. Export the report before importing a fix.',
              );
            }
          }
        });
      } catch (error) {
        if (error instanceof ApprovalNeeded || signal.aborted || error instanceof UserQuestion) {
          throw error;
        }

        if (error instanceof EditConflict) {
          await this.prepareEditRepair(task, project, executingBatch, error);

          if (worker.mode === 'local') {
            task.move('planning');
            continue;
          }

          task.move('review');
          task.save();
          return;
        }

        task.remember(
          JSON.stringify({
            action: actionRecord(action),
            error: errorMessage(error),
          }),
        );

        if (worker.mode === 'local') {
          worker.queue.shift();
          worker.cursor = 0;
          task.move('planning');
          task.event('repair', 'Action failed; returning bounded error evidence to the local coder.');
          continue;
        }

        throw error;
      }

      if (finished) {
        task.save();
        return;
      }

      worker.cursor++;
      task.discardCompletedBatch(executingBatch);
      task.save();
    }
  }

  private async prepareEditRepair(
    task: TaskRuntime,
    project: Project,
    batch: Envelope,
    error: EditConflict,
  ): Promise<void> {
    const worker = task.worker;
    const pending = worker.queue.slice();
    let current: RepairFileEvidence;

    try {
      const file = await fileText(project.root, error.path);
      current = {
        path: error.path,
        hash: file.hash,
        bytes: Buffer.byteLength(file.content),
      };

      // Evidence is either complete source or explicit omission, never a
      // silently truncated read carrying the complete file's hash.
      if (file.content.length <= 6000) {
        current.content = file.content;
      } else {
        current.contentOmitted = true;
      }
    } catch (readError) {
      current = { path: error.path, error: errorMessage(readError) };
    }

    const repair = buildEditRepair(
      batch,
      worker.cursor,
      pending,
      error,
      current,
      this.store.writes(worker.runId),
    );
    const message =
      `Edit plan needs updating: ${error.path}. ` +
      'Completed edits are preserved; the remaining plan was set aside.';

    this.store.transaction(() => {
      const archive: EditRepairArchive = {
        version: 1,
        workerId: worker.id,
        runId: worker.runId,
        cursor: worker.cursor,
        batches: pending,
        repair,
        time: Date.now(),
      };
      this.store.set(`edit-repair:${worker.runId}:${batch.id}`, archive);
      task.discardPlan();
      worker.error = message;
      this.store.saveWorker(worker);
    });

    // The full audit above is separate from the bounded, whole-JSON observation.
    task.remember(encodeRepairObservation(repair));
    task.event('repair', message);
  }

  private profile(project: Project, profileId: string): Profile {
    const profile = project.profiles.find((candidate) => candidate.id === profileId);

    if (!profile) {
      throw new Error(`Command profile not found: ${profileId}`);
    }

    return parseProfile(profile);
  }

  private command(
    task: TaskRuntime,
    project: Project,
    profile: Profile,
    actionId: string,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const worker = task.worker;
    let outputAt = 0;

    return this.commands.run(worker, project, profile, actionId, this.dataDir, signal, (line) => {
      if (Date.now() - outputAt > 500) {
        task.event('output', line);
        outputAt = Date.now();
      }
    });
  }

  private async executeCommand(
    task: TaskRuntime,
    project: Project,
    action: Extract<Action, { type: 'command' }>,
    actionId: string,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const profile = this.profile(project, action.profileId);
    const previous = this.commands.finished(actionId);

    if (previous) {
      return previous;
    }

    task.requireApproval(project, action, [profile]);

    return this.command(task, project, profile, actionId, signal);
  }

  private async execute(
    task: TaskRuntime,
    project: Project,
    action: Exclude<Action, { type: 'command' | 'write' | 'replace' | 'ask' | 'finish' }>,
    actionId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const worker = task.worker;
    switch (action.type) {
      case 'team_message':
      case 'team_pause':
      case 'team_resume': {
        const result = this.team.execute(worker, action, actionId);
        this.changed();
        return result;
      }
      case 'list': {
        return {
          files: await listFiles(project.root, action.path),
          limit: 300,
        };
      }
      case 'read': {
        return this.reads.read(worker, project, action, signal);
      }
      case 'search': {
        return searchFiles(project.root, action.query);
      }
      case 'diff': {
        return gitDiff(project.root, path.join(this.dataDir, 'runtime', worker.id), signal);
      }
    }
  }

  private async verify(
    task: TaskRuntime,
    project: Project,
    action: Extract<Action, { type: 'finish' }>,
    actionId: string,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    const worker = task.worker;
    const profiles = worker.checks
      .filter((check) => check.type === 'command')
      .map((check) => this.profile(project, check.profileId));

    if (profiles.length > 0) {
      const verificationKey = `verification:${actionId}`;

      const previous = this.store.get(verificationKey);

      if (previous !== undefined) {
        const parsed = verificationIntentSchema.safeParse(previous);
        const message =
          'This command verification attempt already ran or was interrupted. Inspect its effects, ' +
          'skip this finish step, and import a fresh finish batch. ' +
          'Cached test output is not fresh verification.';

        if (!parsed.success) {
          throw new Error(message, { cause: parsed.error });
        }

        throw new Error(message);
      }

      task.requireApproval(project, action, profiles);
      const intent: VerificationIntent = {
        status: 'started',
        time: Date.now(),
        revision: project.revision,
      };
      this.store.set(verificationKey, intent);
    }

    const results: CheckResult[] = [];
    let checkIndex = 0;

    // Commands run first so file checks include any generated outputs.
    for (const profile of profiles) {
      const result = await this.command(task, project, profile, `${actionId}_check_${checkIndex}`, signal);
      checkIndex++;
      results.push({
        check: { type: 'command', profileId: profile.id },
        ok: result.code === 0,
        detail: result,
      });
    }

    for (const check of worker.checks.filter((candidate) => candidate.type !== 'command')) {
      signal.throwIfAborted();

      try {
        if (check.type === 'exists') {
          const target = await safePath(project.root, check.path);
          await fs.access(target);
          results.push({ check, ok: true });
        } else {
          const file = await fileText(project.root, check.path);
          results.push({ check, ok: file.content.includes(check.text) });
        }
      } catch (error) {
        results.push({ check, ok: false, detail: errorMessage(error) });
      }
    }

    let verification: VerificationResult['verification'] = 'not-run';

    if (worker.checks.length > 0) {
      verification = 'passed';
    }

    return {
      ok: results.every((result) => result.ok),
      results,
      requiresHumanAcceptance: false,
      verification,
      summary: action.summary,
    };
  }

  report(worker: Worker, project: Project): string {
    return buildReport(worker, project, this.followups.prompt(worker), this.store.changedFiles(worker.runId));
  }

  quiesce(): Promise<void> {
    if (!this.quiescing) {
      this.quiescing = this.stopWriters().catch((error) => {
        this.quiescing = undefined;
        throw error;
      });
    }

    return this.quiescing;
  }

  private async stopWriters(): Promise<void> {
    this.closed = true;
    clearInterval(this.teamTimer);

    const activeTasks = this.activeTasks;

    for (const task of activeTasks) {
      task.abort(new Error('Host shutting down.'));
    }

    this.models.close();
    await Promise.all(activeTasks.map((task) => task.wait()));

    for (const task of this.tasks.values()) {
      task.stopWorkflow();
    }

    await this.models.settled?.();
  }

  async close(): Promise<void> {
    await this.quiesce();

    if (!this.storeClosed) {
      this.store.close();
      this.storeClosed = true;
    }
  }
}
