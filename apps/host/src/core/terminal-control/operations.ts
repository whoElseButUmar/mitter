import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  APP_VERSION,
  BUILD_ID,
  matchesBuild,
  projectSchema,
  workerSchema,
  type TaskBoundary,
  type Worker,
} from '../../../../../packages/protocol/src/index.js';
import {
  terminalClaimParamsSchema,
  terminalClaimResultSchema,
  terminalCommandSchema,
  terminalCompleteParamsSchema,
  terminalCompleteResultSchema,
  terminalListSchema,
  terminalOperationSchema,
  terminalPreviewResultSchema,
  terminalResumeParamsSchema,
  terminalStartParamsSchema,
  terminalStatusSchema,
  terminalStopParamsSchema,
  terminalTaskSchema,
  terminalVersionMismatchMessage,
  type TerminalControlRequest,
  type TerminalOperation,
  type TerminalResumeParams,
  type TerminalStartParams,
  type TerminalStopParams,
} from '../../../../../packages/protocol/src/terminal-control.js';
import { isProjectLaunchRequest } from '../../../../../packages/protocol/src/task-brief.js';
import type { Service } from '../service.js';
import { errorMessage, hasErrorCode } from '../types.js';

const pendingKey = 'miter.terminal.pending';
const pendingSchema = z
  .array(z.string().uuid())
  .max(32)
  .describe('Durable operation IDs awaiting browser dispatch.');
const receiptSchema = z
  .strictObject({
    operation: terminalOperationSchema,
    signature: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('SHA256 of the checked method and exact request.'),
    input: z
      .union([terminalStartParamsSchema, terminalStopParamsSchema, terminalResumeParamsSchema])
      .describe('The original checked request.'),
    claim: z
      .strictObject({
        sessionId: z.string().uuid().describe('The background relay that owns this claim.'),
        token: z.string().uuid().describe('The unique claim acknowledgement token.'),
      })
      .optional()
      .describe('The one browser dispatch claim; never reissued.'),
    acknowledgement: terminalCompleteParamsSchema
      .optional()
      .describe('The exact recorded browser acknowledgement.'),
  })
  .describe('A durable terminal request identity and its browser dispatch receipt.');
type Receipt = z.infer<typeof receiptSchema>;
type TerminalMutationParams = TerminalStartParams | TerminalStopParams | TerminalResumeParams;

function receiptKey(requestId: string): string {
  return 'miter.terminal.operation.' + requestId;
}

function latestKey(workerId: string): string {
  return 'miter.terminal.latest.' + workerId;
}

function signature(kind: TerminalOperation['kind'], input: TerminalMutationParams): string {
  return createHash('sha256').update(JSON.stringify({ kind, input })).digest('hex');
}

function boundary(worker: Worker): TaskBoundary {
  return { runId: worker.runId, epoch: worker.control?.epoch ?? 0 };
}

function sameBoundary(worker: Worker, expected: TaskBoundary): boolean {
  return worker.runId === expected.runId && (worker.control?.epoch ?? 0) === expected.epoch;
}

/** Owns durable admission and claims; it never executes browser commands itself. */
export class TerminalOperations {
  private pending: string[];
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private lastHeartbeat = 0;
  private browserSession: string | undefined;
  private rejectedRelay:
    { mismatch: Parameters<typeof terminalVersionMismatchMessage>[0]; at: number } | undefined;

  constructor(
    private readonly service: Service,
    private readonly now: () => number = Date.now,
  ) {
    const saved = service.store.get(pendingKey);
    this.pending = [];

    if (saved !== undefined) {
      this.pending = pendingSchema.parse(saved);
    }

    // Preparation or dispatch may have had effects before a lost acknowledgement.
    // Keep the receipt queryable, but require a fresh reviewed operation to continue.
    for (const requestId of [...this.pending]) {
      const receipt = this.read(requestId);

      if (receipt.operation.state === 'preparing' || receipt.operation.state === 'claimed') {
        this.finish(
          receipt,
          'interrupted',
          'The host restarted before this operation was acknowledged. Check task status before starting another operation.',
        );
      } else if (receipt.operation.state !== 'queued') {
        this.pending = this.pending.filter((id) => id !== requestId);
      }
    }

    service.store.set(pendingKey, this.pending);
  }

  private serialize<T>(action: () => Promise<T> | T): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new Error('Miter is closing or resetting. Reopen its workspace before trying again.'),
      );
    }

    const result = this.tail.then(action);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  private connected(): boolean {
    return this.browserSession !== undefined && this.now() - this.lastHeartbeat <= 5000;
  }

  private recentVersionMismatch() {
    if (!this.rejectedRelay || this.connected() || this.now() - this.rejectedRelay.at > 60_000) {
      return;
    }
    return this.rejectedRelay.mismatch;
  }

  private read(requestId: string): Receipt {
    const stored = this.service.store.get(receiptKey(requestId));

    if (stored === undefined) {
      throw new Error(
        'This terminal operation was not admitted by this Miter profile. Check its request ID.',
      );
    }

    const receipt = receiptSchema.parse(stored);

    if (receipt.operation.requestId !== requestId) {
      throw new Error('The saved terminal receipt does not match its request ID.');
    }

    if (
      receipt.input.requestId !== requestId ||
      receipt.signature !== signature(receipt.operation.kind, receipt.input)
    ) {
      throw new Error('The saved terminal receipt does not match its original request.');
    }

    return receipt;
  }

  private save(receipt: Receipt): void {
    const checked = receiptSchema.parse(receipt);
    this.service.store.transaction(() => {
      this.service.store.set(receiptKey(checked.operation.requestId), checked);
      this.service.store.set(pendingKey, this.pending);

      if (checked.operation.workerId) {
        this.service.store.set(latestKey(checked.operation.workerId), checked.operation.requestId);
      }
    });
  }

  private finish(receipt: Receipt, state: TerminalOperation['state'], error?: string): TerminalOperation {
    receipt.operation = { ...receipt.operation, state, updatedAt: this.now() };

    if (error !== undefined) {
      receipt.operation.error = error.slice(0, 2000);
    } else {
      delete receipt.operation.error;
    }

    this.pending = this.pending.filter((id) => id !== receipt.operation.requestId);
    this.save(receipt);
    return receipt.operation;
  }

  private reserve(kind: TerminalOperation['kind'], input: TerminalMutationParams): Receipt {
    if (this.pending.length >= 32) {
      throw new Error(
        'Miter already has 32 pending terminal operations. Let the browser catch up before starting another.',
      );
    }

    const receipt: Receipt = {
      operation: {
        requestId: input.requestId,
        kind,
        state: 'preparing',
        createdAt: this.now(),
        updatedAt: this.now(),
      },
      signature: signature(kind, input),
      input,
    };

    if ('workerId' in input) {
      receipt.operation.workerId = input.workerId;
      receipt.operation.expectedRun = input.expectedRun;
    }
    this.pending.push(input.requestId);
    this.save(receipt);
    return receipt;
  }

  private previous(
    kind: TerminalOperation['kind'],
    input: TerminalMutationParams,
  ): TerminalOperation | undefined {
    if (this.service.store.get(receiptKey(input.requestId)) === undefined) {
      return undefined;
    }

    const receipt = this.read(input.requestId);

    if (receipt.signature !== signature(kind, input)) {
      throw new Error(
        'This request ID already belongs to a different operation. Use a new request ID for new work.',
      );
    }

    return receipt.operation;
  }

  private requireBrowser(): void {
    if (!this.connected()) {
      const mismatch = this.recentVersionMismatch();
      if (mismatch) {
        throw new Error(terminalVersionMismatchMessage(mismatch));
      }
      throw new Error(
        'Open the latest Miter extension in the Chrome profile signed in to ChatGPT, then try again. Its terminal connection is not ready.',
      );
    }
  }

  private async start(input: TerminalStartParams): Promise<TerminalOperation> {
    const previous = this.previous('start', input);

    if (previous) {
      return previous;
    }

    const receipt = this.reserve('start', input);

    try {
      this.requireBrowser();

      if (!path.isAbsolute(input.projectPath) || path.normalize(input.projectPath) !== input.projectPath) {
        throw new Error('Use a normalized absolute project folder path.');
      }

      let exists = true;

      try {
        await fs.lstat(input.projectPath);
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          throw error;
        }

        exists = false;
      }

      const projectName = path.basename(input.projectPath).slice(0, 60);
      let project;

      if (exists) {
        project = projectSchema.parse(
          await this.service.handle('project.add', { root: input.projectPath, name: projectName }),
        );
      } else {
        if (!input.createProject) {
          throw new Error(
            'This project folder does not exist. Use --create to create that folder, or select an existing project.',
          );
        }

        project = projectSchema.parse(
          await this.service.handle('project.create', {
            parentRoot: path.dirname(input.projectPath),
            folderName: path.basename(input.projectPath),
            name: projectName,
          }),
        );
      }

      let mode = 'handoff';
      if (isProjectLaunchRequest(input.goal)) {
        mode = 'local';
      }
      const creation: Record<string, unknown> = {
        projectId: project.id,
        mode,
        goal: input.goal,
        checks: [],
        maxIterations: input.maxTurns,
        maxMinutes: input.maxMinutes,
        workspaceMode: 'shared',
      };

      if (input.name !== undefined) {
        creation.name = input.name;
      }

      const worker = workerSchema.parse(await this.service.handle('worker.create', creation));
      receipt.operation = {
        ...receipt.operation,
        state: 'queued',
        workerId: worker.id,
        expectedRun: boundary(worker),
        updatedAt: this.now(),
      };
      this.save(receipt);
      return receipt.operation;
    } catch (error) {
      return this.finish(receipt, 'failed', errorMessage(error));
    }
  }

  private requireResumableWorker(worker: Worker): void {
    if (worker.state === 'complete' || worker.state === 'cancelled') {
      throw new Error('This task has finished. Start a new task for additional work.');
    }

    if (worker.control?.mode === 'stopped') {
      throw new Error('This task was explicitly stopped. Use Continue fresh in Miter to review a new plan.');
    }

    if (worker.mode !== 'handoff') {
      throw new Error('This task does not use a connected AI chat. Continue it from the Miter workspace.');
    }

    if (worker.pending || worker.humanAcceptanceReady) {
      throw new Error('Review this task’s pending approval or result in Miter before resuming its chat.');
    }
  }

  private control(
    kind: 'stop' | 'resume',
    input: TerminalStopParams | TerminalResumeParams,
  ): TerminalOperation {
    const previous = this.previous(kind, input);

    if (previous) {
      return previous;
    }

    const receipt = this.reserve(kind, input);

    try {
      this.requireBrowser();
      const worker = this.worker(input.workerId);

      if (!sameBoundary(worker, input.expectedRun)) {
        throw new Error(
          'This operation belongs to an earlier task run. Read task status before changing its current run.',
        );
      }

      if (kind === 'resume') {
        this.requireResumableWorker(worker);
      }

      receipt.operation = {
        ...receipt.operation,
        workerId: worker.id,
        expectedRun: input.expectedRun,
        state: 'queued',
        updatedAt: this.now(),
      };
      this.save(receipt);
      return receipt.operation;
    } catch (error) {
      return this.finish(receipt, 'failed', errorMessage(error));
    }
  }

  private worker(workerId: string): Worker {
    const worker = this.service.workers.get(workerId);

    if (!worker) {
      throw new Error('Task not found in this Miter profile. Use miter list to see saved tasks.');
    }

    return worker;
  }

  private summarize(worker: Worker) {
    const project = this.service.projects.get(worker.projectId);

    if (!project) {
      throw new Error('The saved task project could not be found.');
    }

    return terminalTaskSchema.parse({
      id: worker.id,
      projectId: project.id,
      projectPath: project.root,
      name: worker.name,
      goal: worker.goal,
      state: worker.state,
      expectedRun: boundary(worker),
      completion: worker.completion,
      pendingApproval: worker.pending !== undefined,
      error: worker.error?.slice(0, 4000),
    });
  }

  private status(workerId: string) {
    const worker = this.worker(workerId);
    const recentId = this.service.store.get(latestKey(workerId));
    let operation: TerminalOperation | undefined;

    if (recentId !== undefined) {
      operation = this.read(z.string().uuid().parse(recentId)).operation;
    }

    return terminalStatusSchema.parse({
      worker: this.summarize(worker),
      browserConnected: this.connected(),
      progress: this.service.snapshot().bridgeProgress?.find((progress) => progress.workerId === workerId),
      operation,
      events: this.service.store
        .taskEvents(workerId)
        .slice(0, 20)
        .reverse()
        .map((event) => ({
          id: event.id,
          time: event.time,
          kind: event.kind.slice(0, 100),
          message: event.message.slice(0, 500),
        })),
    });
  }

  dispatch(request: TerminalControlRequest) {
    return this.serialize(async () => {
      switch (request.method) {
        case 'start':
          return this.start(request.params);
        case 'stop':
          return this.control('stop', request.params);
        case 'resume':
          return this.control('resume', request.params);
        case 'operation':
          return this.read(request.params.requestId).operation;
        case 'preview': {
          const worker = this.worker(request.params.workerId);
          if (worker.state !== 'complete') {
            throw new Error('Preview is available after this task completes.');
          }
          const preview = await this.service.handle('worker.previewStart', request.params);
          return terminalPreviewResultSchema.parse({ ...request.params, preview });
        }
        case 'status':
          return this.status(request.params.workerId);
        case 'list': {
          const tasks = [...this.service.workers.values()]
            .sort((left, right) => right.createdAt - left.createdAt)
            .slice(0, 100)
            .map((worker) => {
              const { goal, completion, error, ...summary } = this.summarize(worker);
              return summary;
            });
          return terminalListSchema.parse({
            browserConnected: this.connected(),
            browserVersionMismatch: this.recentVersionMismatch(),
            tasks,
          });
        }
      }
    });
  }

  claim(value: unknown) {
    const input = terminalClaimParamsSchema.parse(value);

    return this.serialize(() => {
      if (!matchesBuild(input.version, input.buildId)) {
        const mismatch = {
          extensionVersion: input.version,
          ...(input.buildId && { extensionBuildId: input.buildId }),
          hostVersion: APP_VERSION,
          hostBuildId: BUILD_ID,
        };
        this.rejectedRelay = { mismatch, at: this.now() };
        if (this.browserSession === input.sessionId) {
          this.lastHeartbeat = Number.NEGATIVE_INFINITY;
        }
        throw new Error(terminalVersionMismatchMessage(mismatch));
      }
      this.rejectedRelay = undefined;

      if (this.browserSession !== undefined && this.browserSession !== input.sessionId) {
        for (const requestId of [...this.pending]) {
          const receipt = this.read(requestId);

          if (receipt.operation.state === 'claimed') {
            this.finish(
              receipt,
              'interrupted',
              'The browser relay restarted before acknowledging this operation. Check task status; it was not dispatched again.',
            );
          }
        }
      }

      this.browserSession = input.sessionId;
      this.lastHeartbeat = this.now();

      if (input.available) {
        // The relay reports available only after dispatch and acknowledgement
        // finish. A previous claim here means its response was lost or rejected;
        // surface uncertainty instead of leaving monitoring stuck forever.
        for (const requestId of [...this.pending]) {
          const receipt = this.read(requestId);

          if (receipt.operation.state === 'claimed' && receipt.claim?.sessionId === input.sessionId) {
            this.finish(
              receipt,
              'interrupted',
              'The browser requested new work without acknowledging this operation. Check task status; the uncertain command was not dispatched again.',
            );
          }
        }

        for (const requestId of [...this.pending]) {
          const receipt = this.read(requestId);

          if (receipt.operation.state !== 'queued') {
            continue;
          }

          const workerId = receipt.operation.workerId;
          const expectedRun = receipt.operation.expectedRun;

          if (!workerId || !expectedRun) {
            this.finish(receipt, 'failed', 'The saved operation has no task execution boundary.');
            continue;
          }

          const worker = this.service.workers.get(workerId);

          if (!worker || !sameBoundary(worker, expectedRun)) {
            this.finish(
              receipt,
              'failed',
              'The task changed before browser dispatch. Read task status before starting a new operation.',
            );
            continue;
          }

          if (receipt.operation.kind === 'resume') {
            try {
              this.requireResumableWorker(worker);
            } catch (error) {
              this.finish(receipt, 'failed', errorMessage(error));
              continue;
            }
          }

          const claimToken = randomUUID();
          let command;

          if (receipt.operation.kind === 'start') {
            const start = terminalStartParamsSchema.parse(receipt.input);
            command = terminalCommandSchema.parse({
              kind: 'start',
              requestId,
              workerId,
              expectedRun,
              claimToken,
              consent: true,
              ...(isProjectLaunchRequest(start.goal) && { localPreview: true }),
              maxTurns: start.maxTurns,
              maxMinutes: start.maxMinutes,
            });
          } else {
            command = terminalCommandSchema.parse({
              kind: receipt.operation.kind,
              requestId,
              workerId,
              expectedRun,
              claimToken,
            });
          }

          receipt.operation = { ...receipt.operation, state: 'claimed', updatedAt: this.now() };
          receipt.claim = { sessionId: input.sessionId, token: claimToken };
          this.save(receipt);
          return terminalClaimResultSchema.parse({ command });
        }
      }

      return terminalClaimResultSchema.parse({ command: null });
    });
  }

  complete(value: unknown) {
    const input = terminalCompleteParamsSchema.parse(value);

    return this.serialize(() => {
      const receipt = this.read(input.requestId);

      if (receipt.claim?.sessionId !== input.sessionId || receipt.claim.token !== input.claimToken) {
        throw new Error('This acknowledgement does not match the operation’s browser claim.');
      }

      // Late receipts can acknowledge old work after an upgrade. Only a matching
      // poll establishes or refreshes a lease for new commands.

      if (receipt.acknowledgement) {
        if (JSON.stringify(receipt.acknowledgement) !== JSON.stringify(input)) {
          throw new Error('This browser claim already has a different acknowledgement.');
        }

        return terminalCompleteResultSchema.parse({ recorded: true });
      }

      if (receipt.operation.state !== 'claimed' && receipt.operation.state !== 'interrupted') {
        throw new Error('This operation has no unacknowledged browser dispatch.');
      }

      receipt.acknowledgement = input;

      if (input.ok) {
        this.finish(receipt, 'succeeded');
      } else {
        this.finish(
          receipt,
          'failed',
          input.error ?? 'The browser did not acknowledge this operation. Check task status before retrying.',
        );
      }

      return terminalCompleteResultSchema.parse({ recorded: true });
    });
  }
}
