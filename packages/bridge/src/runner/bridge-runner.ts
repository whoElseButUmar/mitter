import { z } from 'zod';
import { bootstrapDraftSchema, matchesBootstrapDraft, rawDraftDigest } from '../bootstrap-draft.js';
import {
  ReplyGapTracker,
  REPLY_GAP_IDLE_MS,
  hasEmptyResponseTail,
  type ReplyGapObservation,
} from '../reply-gap.js';
import { isHistoricalReply, isReplyFragment } from '../reply-window.js';
import { NativeRequestTimeout } from '../native-request.js';
import { isReadOnlyReply, isIncompleteReplyJSON } from '../../../protocol/src/reply-json.js';
import { assertFreshReplyExchange, boundReply, replyDigest, replyHeaders } from '../reply-recovery.js';
import type { ProposalEnvelope } from '../../../protocol/src/proposal.js';
import type { ImageAttachment } from '../../../protocol/src/schemas/image-attachments.js';
import { ReplyValidationError, correctionAdvice, type ReplyIssue } from '../../../protocol/src/validation.js';
import type { ReaderDiagnostic, TaskBoundary, Worker } from '../../../protocol/src/index.js';
import { IMAGE_UPLOAD_CHARS, parseRpcParams, RpcResultValidationError } from '../../../protocol/src/rpc.js';
import type { ChatView, DomRequest } from '../chat-dom.js';
import { isEmptyChat } from '../dom/types.js';
import { PageBridgeError } from '../page-transport.js';
import {
  matchesRecoverableWait,
  holdsSetupApproval,
  isUnsentBootstrap,
  taskProgressSchema,
  type TaskProgress,
} from '../progress.js';
import { taskPresentation } from '../presentation.js';
import { bridgeProgressLoadSchema } from './progress-load.js';

import {
  messagePayload,
  unwrapMessage,
  sameMessage,
  messageDigest,
  parseReceipt,
  matchesReceipt,
  type OutboundReceipt,
} from '../message-wire.js';
import {
  bridgeOptionsSchema,
  type BridgeStatus,
  type BridgeOptions,
  type BridgeDependencies,
  type BridgeResendResult,
} from './types.js';
import { readPageState } from '../transport/page-state.js';
import { conversationURL, chatStartURL, isTaskBootstrap, normalizeMessage } from './chat-identity.js';
import {
  buildReportPrompt,
  buildExchangeMessage,
  renewExchangeMessage,
  buildCorrectionPrompt,
  buildTaskLinkCorrection,
  buildMissingResponsePrompt,
  buildReplyRecoveryPrompt,
} from './prompts.js';
import {
  replyFingerprint,
  parseAssistantReply,
  checkReplyExchange,
  mistypedProjectHeaders,
  replyWaitExplanation,
} from './reply-validation.js';
import { recoverTaskProgress } from './progress-recovery.js';
import { CheckpointWriter } from './checkpoint-writer.js';
import {
  assistantReadShape,
  transcriptReadShape,
  readerDiagnostic,
  userReadShape,
  codeReplyReadShape,
  transcriptAncestryShape,
  userReceiptComparison,
} from './reader-diagnostics.js';
import { LateReplyWatch, LATE_REPLY_WATCH_MS, recoverableReceiveErrors } from './late-reply-watch.js';
import {
  bridgeRpcRegistry,
  requestBridgeRpc,
  type BridgeRpcMethod,
  type BridgeRpcResult,
} from './rpc-results.js';
const inFlight = new Set(['queued', 'planning', 'waiting_model', 'waiting_lock', 'executing', 'verifying']);

type TimedObservation = {
  fingerprint: string;
  since: number;
};

type RunnerOwner = {
  expectedRun: TaskBoundary;
  expectedBatchId: string | undefined;
  goal: string;
  mode: Worker['mode'];
  batch: string | undefined;
  destination: string;
};

type HostReconnect = {
  deadline: number;
  retryAt: number;
  attempts: number;
  workerBinding: string;
  progress: string;
};

function waitingWorkerBinding(worker: Worker): string {
  return JSON.stringify([
    worker.state,
    worker.iteration,
    worker.cursor,
    worker.observations,
    worker.activeFollowupId,
    worker.control?.mode,
  ]);
}

/** Coordinates page ownership, durable sending and host execution. Mutations
 * stay in this guarded lifecycle; extracted helpers never receive the runner. */
export class BridgeRunner {
  private generatedImageWait: TimedObservation | undefined;
  readonly status: BridgeStatus;
  private operationRunning = false;
  private expectedUserText = '';
  private expectedRenderedUserText = '';
  private messageCountBeforeSend = 0;
  private userTurnAcknowledged = false;
  private expectedUserMessageId = '';
  private adoptedAssistantReceipt = '';
  private priorUserIds = new Set<string>();
  private conflictingUserObservation: TimedObservation | undefined;
  private userVisibilitySince: number | undefined;
  private generationSeenAt: number | undefined;
  private readonly observations = new Map<string, string>();
  private previousUserText = '';
  private previousAssistantId = '';
  private previousAssistantText = '';
  private sentAt = 0;
  private replyCandidate: TimedObservation | undefined;
  private recoveryCandidate: TimedObservation | undefined;
  private repeatedActionBatches = 0;
  private pendingConversationBind: boolean;
  private bootstrapPrompt = '';
  private nextStepPrompt = '';
  private reconnectSince: number | undefined;
  private hostReconnect: HostReconnect | undefined;
  private recoveryPhase = 'connecting';
  private correctionAttempts = 0;
  private unlinkedCandidate: TimedObservation | undefined;
  // Busy reads restart candidate stability, not the overall task-link wait.
  private unlinkedWaitSince: number | undefined;
  private readonly bootstrapOrigin: string;
  private unreadableSince: number | undefined;
  private readerDiagnostic: ReaderDiagnostic | undefined;
  private pinnedConversation = '';
  private sendCommitAttempted = false;
  private pendingSend:
    | {
        text: string;
        messageId: string;
        startedAt: number;
        commitIntent: boolean;
        adoptBootstrapDraft?: true;
        composerSession?: string;
        imageAttachments?: ImageAttachment[];
        uploadedImages: number;
      }
    | undefined;
  private lastSendReadiness = '';
  private localPauseCheck: Promise<void> | undefined;
  private pendingDelivery:
    | {
        envelope: ProposalEnvelope;
        hash: string;
        imported: boolean;
        failures: number;
        retryAt: number;
      }
    | undefined;
  private readonly now: () => number;
  private activeTimeDeadline: number;
  private progress?: TaskProgress;
  private activeMillisecondsBeforeResume = 0;
  private lastHostSetupWaitMs = 0;
  private excludedSetupWaitMs = 0;
  private resumedAt = 0;
  private activeTimeStoppedAt: number | undefined;
  private readonly checkpointWriter: CheckpointWriter;
  private lastAcceptedActionsHash = '';
  private restoringPendingSend = false;
  private executionEpoch = 0;
  private owner: RunnerOwner | undefined;
  private starting = true;
  private operationDone?: () => void;
  private operationIdle: Promise<void> = Promise.resolve();
  private stopPending: Promise<void> | undefined;
  private readonly lateReplyWatch = new LateReplyWatch();
  private replyGap = new ReplyGapTracker();
  private gapObservation: ReplyGapObservation = {
    missing: false,
    elapsedMs: 0,
    started: false,
  };
  private gapLogged = '';
  private waitObservation = '';
  private waitUnchangedAt = 0;
  constructor(
    private options: BridgeOptions,
    private dependencies: BridgeDependencies,
  ) {
    // Automatic turns are capped lower than the host's worker loop (see
    // service.ts) because each automatic turn is a heavyweight browser handoff;
    // manual/continue use keeps the host's own bounds.
    if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 20) {
      throw new Error('Automatic mode supports 1–20 turns.');
    }
    if (!Number.isInteger(options.maxMinutes) || options.maxMinutes < 1 || options.maxMinutes > 60) {
      throw new Error('Automatic mode supports 1–60 minutes.');
    }
    // Receipt updates intentionally remain visible through the caller's options
    // object. Validate its serialized fields without replacing that shared owner.
    chatStartURL(options.url, options.newChat === true);
    const parsedOptions = bridgeOptionsSchema.safeParse(options);
    if (!parsedOptions.success) {
      throw new Error('Invalid bridge options. Reopen the task and choose its chat and limits again.', {
        cause: parsedOptions.error,
      });
    }
    this.now = dependencies.now || Date.now;
    this.checkpointWriter = new CheckpointWriter(
      (progress, epoch) => this.dependencies.saveProgress?.(progress, epoch),
      () => this.now(),
    );
    this.activeTimeDeadline = this.now() + options.maxMinutes * 60000;
    this.pendingConversationBind = options.newChat === true;
    this.bootstrapOrigin = new URL(options.url).origin;
    this.status = {
      bindingPending: this.pendingConversationBind,
      workerId: options.workerId,
      tabId: options.tabId,
      url: chatStartURL(options.url, this.pendingConversationBind),
      active: true,
      phase: 'connecting',
      reason: 'Connecting to ChatGPT…',
      turns: options.previousProgress?.turns ?? 0,
      maxTurns: options.previousProgress?.maxTurns ?? options.maxTurns,
      startedAt: options.previousProgress?.startedAt ?? this.now(),
      lowerBound: options.previousProgress?.lowerBound,
      activeMs: options.previousProgress?.activeMs,
      maxMinutes: options.previousProgress?.maxMinutes,
    };
    if (options.reattachRevision !== undefined) {
      if (options.expectedBatchId) {
        this.status.phase = 'waiting_approval';
        this.status.reason = 'Reconnecting to the project setup…';
      } else {
        this.status.phase = 'waiting_reply';
        this.status.reason = 'Reconnecting to the saved reply…';
      }
    }
    const worker = dependencies.snapshot()?.workers.find((worker) => worker.id === options.workerId);

    if (worker) {
      this.owner = this.captureOwner(worker);
      this.executionEpoch = this.owner.expectedRun.epoch;
    }
  }

  private queryRpc<Method extends BridgeRpcMethod>(
    method: Method,
    params: Record<string, unknown>,
  ): Promise<BridgeRpcResult<Method>> {
    if (method.startsWith('worker.') && this.owner) {
      params = { ...params, expectedRun: this.owner.expectedRun };
    }

    return requestBridgeRpc(
      (requestedMethod, requestedParams) => this.dependencies.rpc(requestedMethod, requestedParams),
      method,
      params,
    );
  }

  private async restoreProgress(): Promise<void> {
    if (this.progress) {
      return;
    }
    const worker = this.boundWorker();
    this.executionEpoch = this.owner?.expectedRun.epoch ?? worker.control?.epoch ?? 0;
    if (worker.control?.mode === 'stopped') {
      throw new PageBridgeError(
        'TASK_STOPPED',
        'Task stopped. Use Continue fresh; completed files and history are kept.',
      );
    }
    this.assertCanContinue();
    let loaded: unknown = { progress: null, importedCount: 0 };
    if (this.dependencies.loadProgress) {
      parseRpcParams(bridgeRpcRegistry, 'worker.bridgeLoad', { workerId: worker.id });
      loaded = await this.dependencies.loadProgress();
      this.assertCanContinue();
    }
    const goalHash = await messageDigest(worker.goal);
    this.assertCanContinue();
    let recoveryOptions = this.options;
    if (this.options.reattachRevision !== undefined) {
      const { progress: saved, setupResultBatchId } = bridgeProgressLoadSchema.parse(loaded);
      if (
        !matchesRecoverableWait(
          saved,
          this.options.reattachRevision,
          this.status.url,
          this.options.lastReceipt,
          worker,
          setupResultBatchId,
        )
      ) {
        throw new PageBridgeError(
          'PROGRESS_BINDING',
          'The saved reply changed before Miter could reconnect.',
        );
      }
      // Both receipts agree on this send. Leave legacy browser migration out of
      // cold recovery so the host's recorded counters and baselines stay exact.
      recoveryOptions = { ...this.options, lastReceipt: undefined };
    }
    const progress = recoverTaskProgress(loaded, worker, recoveryOptions, goalHash, () => this.now());

    const expectedBatchId = this.owner?.expectedBatchId;

    if (
      expectedBatchId !== undefined &&
      ((progress.stage !== 'local_batch' &&
        !(this.options.reattachRevision !== undefined && progress.stage === 'report_due')) ||
        progress.lastImportedId !== expectedBatchId ||
        !progress.conversationUrl)
    ) {
      throw new PageBridgeError(
        'PROGRESS_BINDING',
        'The checkpoint no longer names the exact reviewed local batch. Nothing was resumed or replayed.',
      );
    }

    if (
      progress.conversationUrl &&
      !this.pendingConversationBind &&
      conversationURL(progress.conversationUrl) !== this.owner?.destination
    ) {
      throw new PageBridgeError(
        'NAVIGATED',
        'The checkpoint belongs to a different conversation. Review this task’s saved chat before continuing.',
      );
    }
    if (
      loaded &&
      typeof loaded === 'object' &&
      'progress' in loaded &&
      loaded.progress === null &&
      progress.lowerBound
    ) {
      this.dependencies.log(
        'bridge.migrate',
        'Recovered legacy task history. Earlier unrecorded sends cannot be counted exactly; the displayed total is a known minimum.',
      );
    }
    // Import and progress acknowledgement cross two process boundaries. A
    // crash/lost response after the host accepted a batch must not strand its
    // queue or cause a fresh model send. Recover ONLY the exact accepted head
    // linked to this saved exchange (or the explicit selected-reply receipt).
    const head = worker.queue[0];
    if (
      head &&
      progress.stage !== 'local_batch' &&
      ['waiting_reply', 'commit_intent'].includes(progress.stage) &&
      head.workerId === worker.id &&
      head.projectId === worker.projectId &&
      ((!!head.replyTo && head.replyTo === progress.lastReceipt?.exchangeId) ||
        head.id === progress.approvedReply?.id)
    ) {
      const acceptedHead = await this.queryRpc('worker.handoffSeen', {
        workerId: worker.id,
        envelopeId: head.id,
      });
      this.assertCanContinue();
      if (acceptedHead.seen) {
        progress.lastImportedId = head.id;
        progress.stage = 'local_batch';
        this.dependencies.log(
          'bridge.reconcile',
          'Recovered the host-accepted batch after a lost import acknowledgement. No action or Send was replayed.',
        );
      }
    }
    this.progress = progress;
    if (progress.conversationUrl) {
      this.pinnedConversation = conversationURL(progress.conversationUrl);
      this.status.url = this.pinnedConversation;
    }
    this.resumedAt = this.now();
    this.excludedSetupWaitMs = 0;
    this.lastHostSetupWaitMs = this.boundWorker().setupWaitMs ?? 0;
    this.activeMillisecondsBeforeResume = progress.activeMs;
    if (progress.lastReceipt) {
      this.options.lastReceipt = progress.lastReceipt;
    } else if (worker.control) {
      this.options.lastReceipt = undefined;
    }
    this.status.turns = progress.turns;
    this.status.maxTurns = progress.maxTurns;
    this.status.lowerBound = progress.lowerBound;
    this.status.startedAt = progress.startedAt;
    this.status.activeMs = progress.activeMs;
    this.status.maxMinutes = progress.maxMinutes;
    this.lastAcceptedActionsHash = progress.lastActionsHash || '';
    this.repeatedActionBatches = progress.repeats;
    this.correctionAttempts = progress.formatRepairs;
    this.activeTimeDeadline = this.now() + Math.max(0, progress.maxMinutes * 60000 - progress.activeMs);
    await this.dependencies.verifyStartup?.();
    this.assertCanContinue();
    if (this.options.reattachRevision === undefined) {
      await this.checkpoint();
      this.assertCanContinue();
    }
  }
  /** Serialized durable boundary. Host CAS rejects stale writers; save before
   * Send/import/next-turn transitions, never recreate a counter on Resume. */
  private async checkpoint(stage?: TaskProgress['stage'], force = true): Promise<void> {
    if (!this.progress) {
      return;
    }
    if (stage) {
      this.progress.stage = stage;
    }
    await this.checkpointWriter.write(
      () => this.buildCheckpoint(),
      (progress, written) => {
        this.boundWorker();

        if (written) {
          this.progress = progress;
        }
        this.status.activeMs = progress.activeMs;
      },
      this.executionEpoch,
      force,
    );
  }

  private buildCheckpoint(): TaskProgress {
    this.boundWorker();
    const progress = this.progress;
    if (!progress) {
      throw new Error('Saved task progress is unavailable.');
    }
    const checkpoint: TaskProgress = {
      ...progress,
      turns: this.status.turns,
      maxTurns: this.status.maxTurns,
      lowerBound: !!this.status.lowerBound,
      activeMs: Math.max(
        progress.activeMs,
        this.activeMillisecondsBeforeResume +
          Math.max(0, (this.activeTimeStoppedAt ?? this.now()) - this.resumedAt - this.excludedSetupWaitMs),
      ),
      lastReceipt: parseReceipt(this.options.lastReceipt),
      repeats: this.repeatedActionBatches,
      formatRepairs: this.correctionAttempts,
      lastActionsHash: this.lastAcceptedActionsHash || undefined,
      phase: this.status.phase,
      reason: this.status.reason,
      errorCode: this.status.errorCode,
      updatedAt: this.now(),
    };
    delete checkpoint.readerDiagnostic;
    if (this.readerDiagnostic && (this.status.monitoring || this.status.errorCode)) {
      checkpoint.readerDiagnostic = this.readerDiagnostic;
    }
    delete checkpoint.monitoring;
    delete checkpoint.watchUntil;
    if (this.status.monitoring === true) {
      checkpoint.monitoring = true;
      checkpoint.watchUntil = this.status.watchUntil;
    }
    return checkpoint;
  }

  async flushed(): Promise<void> {
    await this.checkpointWriter.flushed();
  }

  async settled(): Promise<void> {
    await this.operationIdle;
    await this.stopPending;
    await this.checkpointWriter.flushed();
  }

  /** Closing a Chrome window can be part of quitting the browser. Retire
   * the reader without replacing its confirmed waiting checkpoint with Stop. */
  detachSetupApproval(): boolean {
    const worker = this.dependencies.snapshot()?.workers.find((item) => item.id === this.options.workerId);
    if (
      !this.status.active ||
      this.status.monitoring ||
      !worker ||
      !this.ownsWorker(worker) ||
      this.progress?.stage !== 'local_batch' ||
      !this.progress.lastImportedId ||
      !holdsSetupApproval(worker, this.progress.lastImportedId) ||
      !['running', 'waiting_approval'].includes(this.status.phase) ||
      this.pendingDelivery ||
      this.pendingSend
    ) {
      return false;
    }
    this.status.active = false;
    this.hostReconnect = undefined;
    return true;
  }

  detachSavedWait(): boolean {
    if (this.detachSetupApproval()) {
      return true;
    }
    if (
      !this.status.active ||
      this.status.monitoring ||
      !this.progress ||
      this.progress.stage !== 'waiting_reply' ||
      !this.progress.lastReceipt?.expectsReplyTo ||
      !this.progress.lastReceipt.exchangeId ||
      this.pendingSend ||
      this.pendingDelivery ||
      !(
        this.status.phase === 'waiting_reply' ||
        (this.status.phase === 'reconnecting' && this.recoveryPhase === 'waiting_reply')
      )
    ) {
      return false;
    }
    this.status.active = false;
    this.hostReconnect = undefined;
    return true;
  }

  /** An idle reply wait can reconnect by reading state. In-flight operations remain ambiguous. */
  hostDisconnected(): boolean {
    if (this.hostReconnect && this.status.active) {
      return true;
    }
    const worker = this.dependencies.snapshot()?.workers.find((item) => item.id === this.options.workerId);
    const progress = this.progress;
    let phase = this.status.phase;
    if (phase === 'reconnecting') {
      phase = this.recoveryPhase;
    }
    if (
      !this.status.active ||
      this.status.monitoring ||
      this.operationRunning ||
      this.lateReplyWatch.running ||
      phase !== 'waiting_reply' ||
      !progress ||
      progress.stage !== 'waiting_reply' ||
      !progress.lastReceipt?.expectsReplyTo ||
      !progress.lastReceipt.exchangeId ||
      this.pendingSend ||
      this.pendingDelivery ||
      !this.dependencies.reconnectHost ||
      !this.dependencies.loadProgress ||
      !worker ||
      !this.ownsWorker(worker) ||
      !['idle', 'review'].includes(worker.state) ||
      worker.queue.length !== 0 ||
      worker.pending ||
      worker.humanAcceptanceReady ||
      worker.control?.mode === 'stopped'
    ) {
      return false;
    }
    this.hostReconnect = {
      deadline: this.now() + 60000,
      retryAt: this.now(),
      attempts: 0,
      workerBinding: waitingWorkerBinding(worker),
      progress: JSON.stringify(taskProgressSchema.parse(progress)),
    };
    this.replyCandidate = undefined;
    this.recoveryCandidate = undefined;
    this.recoveryPhase = 'waiting_reply';
    this.status.errorCode = 'HOST_RECONNECTING';
    this.update(
      'reconnecting',
      'Reconnecting to the local host… The saved reply is waiting; nothing is being resent.',
    );
    return true;
  }

  private async reconnectWaitingHost(): Promise<void> {
    const recovery = this.hostReconnect;
    if (!recovery || this.operationRunning || !this.status.active) {
      return;
    }
    if (this.now() >= recovery.deadline || recovery.attempts >= 6) {
      this.hostReconnect = undefined;
      await this.stop(
        'The local host could not reconnect. Open Setup to check its connection, then Resume this saved reply. Nothing was resent.',
        'error',
        'HOST_RECONNECT_FAILED',
      );
      return;
    }
    if (this.now() < recovery.retryAt) {
      return;
    }
    this.operationRunning = true;
    this.operationIdle = new Promise((resolve) => {
      this.operationDone = resolve;
    });
    try {
      this.dependencies.checkAvailable?.();
      if (this.now() >= this.activeTimeDeadline) {
        throw new PageBridgeError(
          'TIME_LIMIT',
          'The task time limit was reached while reconnecting. Progress is saved.',
        );
      }
      recovery.attempts++;
      const reconnect = this.dependencies.reconnectHost;
      const loadProgress = this.dependencies.loadProgress;
      if (!reconnect || !loadProgress) {
        throw new PageBridgeError(
          'HOST_RECONNECT_FAILED',
          'The saved reply cannot be reconnected automatically. Open Setup, then Resume.',
        );
      }
      const fresh = await reconnect();
      if (this.hostReconnect !== recovery || !this.status.active) {
        return;
      }
      this.dependencies.checkAvailable?.();
      const worker = fresh.workers.find((item) => item.id === this.options.workerId);
      const current = this.boundWorker();
      if (
        !worker ||
        !this.ownsWorker(worker) ||
        waitingWorkerBinding(worker) !== recovery.workerBinding ||
        waitingWorkerBinding(current) !== recovery.workerBinding ||
        worker.queue.length ||
        current.queue.length ||
        worker.pending ||
        current.pending ||
        worker.humanAcceptanceReady ||
        current.humanAcceptanceReady
      ) {
        throw new PageBridgeError(
          'RUN_SUPERSEDED',
          'The task changed while the host was disconnected. Review its current state before resuming.',
        );
      }
      const loaded = bridgeProgressLoadSchema.parse(await loadProgress());
      if (this.hostReconnect !== recovery || !this.status.active) {
        return;
      }
      this.dependencies.checkAvailable?.();
      const latest = this.boundWorker();
      if (
        waitingWorkerBinding(latest) !== recovery.workerBinding ||
        latest.queue.length ||
        latest.pending ||
        latest.humanAcceptanceReady ||
        JSON.stringify(loaded.progress) !== recovery.progress
      ) {
        throw new PageBridgeError(
          'PROGRESS_BINDING',
          'Saved task progress changed while reconnecting. Resume after reviewing the current task; nothing was replayed.',
        );
      }
      if (this.now() >= recovery.deadline || this.now() >= this.activeTimeDeadline) {
        throw new PageBridgeError(
          'HOST_RECONNECT_FAILED',
          'The local host reconnected after the recovery window ended. Resume to check the saved reply.',
        );
      }
      this.hostReconnect = undefined;
      this.reconnectSince = undefined;
      this.status.errorCode = undefined;
      this.update('waiting_reply', 'Local host reconnected. Checking the saved reply; nothing was resent.');
      this.dependencies.log(
        'bridge.host.reconnected',
        'Fresh task and exact saved checkpoint confirmed. Only state reads were retried.',
      );
    } catch (error) {
      if (this.hostReconnect !== recovery || !this.status.active) {
        return;
      }
      let failure = error;
      try {
        this.dependencies.checkAvailable?.();
      } catch (guardError) {
        failure = new PageBridgeError('RUN_SUPERSEDED', errorMessage(guardError));
      }
      if (
        failure instanceof PageBridgeError ||
        failure instanceof RpcResultValidationError ||
        failure instanceof z.ZodError
      ) {
        this.hostReconnect = undefined;
        await this.stop(errorMessage(failure), 'error', bridgeErrorCode(failure) || 'HOST_RESPONSE_INVALID');
        return;
      }
      recovery.retryAt = this.now() + Math.min(16000, 1000 * 2 ** (recovery.attempts - 1));
      this.dependencies.log(
        'bridge.host.retry',
        'Read-only host reconnect attempt ' + recovery.attempts + '/6 failed: ' + errorMessage(failure),
      );
    } finally {
      this.operationRunning = false;
      this.operationDone?.();
    }
  }

  async interruptGeneration(): Promise<void> {
    try {
      const view = await this.requestPage('interrupt');
      this.dependencies.log(
        'bridge.interrupt',
        'Chat generation: ' + (view.interruptOutcome || 'not confirmed') + '. No user draft was altered.',
      );
    } catch (error) {
      this.dependencies.log(
        'bridge.interrupt',
        errorMessage(error) + ' Chat interruption was not confirmed.',
      );
    }
  }

  private update(phase: string, reason: string) {
    if (this.status.phase !== phase || this.status.reason !== reason) {
      this.dependencies.log('bridge.phase', `[${this.options.workerId.slice(0, 8)}] ${phase}: ${reason}`);
    }
    this.status.phase = phase;
    this.status.reason = reason;
    this.dependencies.publish({ ...this.status });
  }

  private captureOwner(worker: Worker): RunnerOwner {
    const expectedRun = this.options.expectedRun ?? {
      runId: worker.runId,
      epoch: worker.control?.epoch ?? 0,
    };

    return {
      expectedRun: { ...expectedRun },
      expectedBatchId: this.options.expectedBatchId,
      goal: worker.goal,
      mode: worker.mode,
      batch: JSON.stringify(worker.queue[0]),
      destination: chatStartURL(this.options.url, this.options.newChat === true),
    };
  }

  private ownsWorker(worker: Worker): boolean {
    const owner = this.owner;

    return (
      owner !== undefined &&
      worker.projectId === this.options.projectId &&
      worker.runId === owner.expectedRun.runId &&
      (worker.control?.epoch ?? 0) === owner.expectedRun.epoch &&
      worker.goal === owner.goal &&
      worker.mode === owner.mode &&
      (!this.starting ||
        (JSON.stringify(worker.queue[0]) === owner.batch &&
          (owner.expectedBatchId === undefined ||
            worker.queue[0]?.id === owner.expectedBatchId ||
            (this.options.reattachRevision !== undefined &&
              worker.state === 'review' &&
              !worker.queue.length))))
    );
  }

  private boundWorker(): Worker {
    const worker = this.dependencies
      .snapshot()
      ?.workers.find((worker) => worker.id === this.options.workerId);
    if (!worker || worker.projectId !== this.options.projectId) {
      throw new PageBridgeError(
        'RUN_SUPERSEDED',
        'Worker or project binding changed. Nothing else will run.',
      );
    }

    this.owner ??= this.captureOwner(worker);

    if (!this.ownsWorker(worker)) {
      throw new PageBridgeError(
        'RUN_SUPERSEDED',
        'The reviewed task run, goal, or queued batch changed. No replacement work will run.',
      );
    }

    return worker;
  }

  private matchesExpectedMessage(text: string) {
    return (
      (!!this.expectedUserText && sameMessage(text, this.expectedUserText)) ||
      (!!this.expectedRenderedUserText && sameMessage(text, this.expectedRenderedUserText))
    );
  }

  private accountForSetupWait(worker: Worker): void {
    const total = worker.setupWaitMs ?? 0;
    const unaccounted = Math.max(0, total - this.lastHostSetupWaitMs);
    const sinceResume = Math.max(0, this.now() - this.resumedAt - this.excludedSetupWaitMs);
    const waiting = Math.min(unaccounted, sinceResume);
    this.excludedSetupWaitMs += waiting;
    this.activeTimeDeadline += waiting;
    this.lastHostSetupWaitMs = total;
  }

  private assertCanContinue(checkTime = true) {
    this.dependencies.checkAvailable?.();

    if (
      this.boundWorker().control?.mode === 'stopped' ||
      (this.boundWorker().control?.epoch ?? 0) !== this.executionEpoch
    ) {
      throw new PageBridgeError(
        'RUN_SUPERSEDED',
        'This execution plan was stopped or replaced. No further action will run.',
      );
    }
    if (!this.status.active) {
      throw new Error('Session stopped.');
    }
    if (checkTime && this.now() >= this.activeTimeDeadline) {
      throw new PageBridgeError(
        'TIME_LIMIT',
        'The task’s active-time limit is reached. Progress is saved; add more time to continue.',
      );
    }
  }

  private logObservation(kind: string, message: string, key = message): boolean {
    if (key === (this.observations.get(kind) ?? '')) {
      return false;
    }
    this.observations.set(kind, key);
    this.dependencies.log(kind, message);
    return true;
  }

  private logAssistantReadShape(view: ChatView): void {
    const shape = assistantReadShape(view);
    if (!shape) {
      return;
    }
    const key = view.assistantId + '\n' + shape;
    this.logObservation('bridge.reply.structure', shape, key);
  }

  private parseObservedReply(view: ChatView): ProposalEnvelope {
    this.logAssistantReadShape(view);
    return parseAssistantReply(view, this.options.lastReceipt);
  }
  /** A literal code candidate is NOT an execution grant. The old recovery is
   * scoped to an exact user-approved hash; future replies must echo the exact
   * nonce in the current durable send record. Normal schema/policy checks and
   * the stable-completed-reply window are still applied before import.
   */
  private async selectDirectReply(view: ChatView): Promise<void> {
    if (
      !view.codeReply ||
      view.replyRecovery ||
      view.busy ||
      view.draft ||
      view.ready === false ||
      isReplyFragment(view) ||
      ['REPLY_IN_PROGRESS', 'NEWER_REPLY_UNREADABLE'].includes(view.codeReplyIssue || '')
    ) {
      return;
    }
    let envelope: ReturnType<typeof replyHeaders>;
    try {
      envelope = replyHeaders(view.codeReply.text, this.options.workerId, this.options.projectId);
    } catch {
      return;
    }
    const receipt = parseReceipt(this.options.lastReceipt);
    const approval = this.progress?.approvedReply;
    const manual =
      !!approval &&
      approval.url === view.url &&
      approval.id === envelope.id &&
      approval.hash ===
        (await replyDigest(boundReply(view.codeReply.text, this.options.workerId, this.options.projectId)));
    const correlated =
      !!receipt &&
      receipt.expectsReplyTo === true &&
      !!receipt.exchangeId &&
      receipt.exchangeId === envelope.replyTo &&
      receipt.workerId === envelope.workerId &&
      receipt.projectId === envelope.projectId &&
      receipt.goalHash === (await messageDigest(this.boundWorker().goal));
    if (!manual && !correlated) {
      return;
    }
    if (
      !manual &&
      view.lastUserText &&
      !view.lastUserCollapsed &&
      !view.lastUserTruncated &&
      !(await this.matchesSavedReceipt(view.lastUserText))
    ) {
      return;
    }
    // Known contradictory user turns remain barriers. Lack of role metadata is
    // no longer fatal when the reply itself can be correlated independently.
    if (
      view.transcript?.users &&
      !manual &&
      (view.lastRole !== 'assistant' ||
        (!view.lastUserCollapsed &&
          !view.lastUserTruncated &&
          !(await this.matchesSavedReceipt(view.lastUserText))))
    ) {
      return;
    }
    if (view.transcript?.unclassifiedTail && view.transcript.users) {
      return;
    }
    if (manual) {
      view.replyEvidence = 'user';
    } else {
      view.replyEvidence = 'exchange';
    }
    view.assistantText = view.codeReply.text;
    view.assistantId = envelope.id;
    view.assistantFormat = view.codeReply.format || 'code';
    delete view.assistantReadIssue;
    view.complete = true;
    view.lastRole = 'assistant';
    view.count = Math.max(1, view.count);
    const observation = envelope.id + ':' + view.replyEvidence;
    let reason =
      'Matched a literal JSON code reply to the pending exchange. Transcript-role detection was not needed.';
    if (manual) {
      reason = 'Using the exact reply explicitly selected by you. No bootstrap or turn is repeated.';
    } else if (view.codeReply.format === 'plain') {
      reason =
        'Matched a complete read-only plain JSON reply from an identified assistant message to the pending exchange.';
    }
    this.logObservation('bridge.reply.code', reason, observation);
  }
  /** Normalize only by a full saved receipt match, including during late watch. */
  private async normalizeUserEcho(view: ChatView): Promise<void> {
    // Different highlighters encode line boundaries as text nodes, BRs, or
    // block elements. Only select a lossless candidate if its COMPLETE message
    // matches the known outgoing text/receipt. Never repair code or accept a
    // shared exchange marker as proof by itself.
    if (
      view.lastUserCandidates?.length &&
      !(this.matchesExpectedMessage(view.lastUserText) || (await this.matchesSavedReceipt(view.lastUserText)))
    ) {
      for (const candidate of view.lastUserCandidates.slice(0, 6)) {
        if (
          candidate.length <= 160000 &&
          (this.matchesExpectedMessage(candidate) || (await this.matchesSavedReceipt(candidate)))
        ) {
          view.lastUserText = candidate;
          view.lastUserTruncated = false;
          this.dependencies.log(
            'bridge.user.read',
            'Verified the complete sent message against its saved receipt using a full-message representation.',
          );
          break;
        }
      }
    }
  }

  private async requestPage(
    op: DomRequest['op'],
    details: Pick<
      DomRequest,
      | 'text'
      | 'messageId'
      | 'composerSession'
      | 'staleDraft'
      | 'adoptBootstrapDraft'
      | 'image'
      | 'imageAttachments'
      | 'imageMode'
      | 'generatedImageIndex'
    > & { sourceReceipt?: OutboundReceipt } = {},
  ): Promise<ChatView> {
    // The new-chat route can be provisional. Only inspections may look across
    // that transition; writes remain pinned to the last proven exact URL.
    let expected = this.status.url;
    if (op === 'inspect' && this.pendingConversationBind) {
      expected = this.bootstrapOrigin;
    }
    let inspectionReceipt: OutboundReceipt | undefined;
    if (op === 'inspect') {
      inspectionReceipt = parseReceipt(this.options.lastReceipt);
    }
    let expectedReplyTo: string | undefined;
    if (
      !this.progress?.approvedReply &&
      (this.options.lastReceipt?.expectsReplyTo || this.options.lastReceipt?.imageMode)
    ) {
      expectedReplyTo = this.options.lastReceipt.exchangeId;
    }
    const { sourceReceipt, ...operationDetails } = details;
    if (op === 'read_generated_image') {
      inspectionReceipt = sourceReceipt;
      expectedReplyTo = sourceReceipt?.exchangeId;
    }
    const observation = await this.dependencies.page(this.options.tabId, {
      op,
      token: this.options.token,
      url: expected,
      ...operationDetails,
      expiresAt: this.activeTimeDeadline,
      allowConversationBind: this.pendingConversationBind,
      preservePause: this.options.reattachRevision !== undefined || undefined,
      includeHistory: op === 'inspect' && this.status.phase === 'connecting',
      receipt: inspectionReceipt,
      workerId: this.options.workerId,
      projectId: this.options.projectId,
      replyId: this.progress?.approvedReply?.id,
      replyTo: expectedReplyTo,
    });
    const result = readPageState(observation, op);
    if (op !== 'stop' && op !== 'interrupt') {
      await this.normalizeUserEcho(result);
    }
    if (op === 'inspect') {
      const receipt = this.options.lastReceipt;
      if (
        receipt?.exchangeId &&
        !result.replyRecovery &&
        this.correctionAttempts === 0 &&
        !this.progress?.approvedReply &&
        this.progress?.stage === 'waiting_reply'
      ) {
        const typo = mistypedProjectHeaders(result, receipt);
        const state = this.dependencies.snapshot();
        if (
          typo &&
          state &&
          !state.projects.some((item) => item.id === typo.projectId) &&
          !this.replyIdsBeforeSend(receipt).includes(typo.id) &&
          typo.id !== this.progress.lastImportedId &&
          (await this.matchesSavedReceipt(result.lastUserText))
        ) {
          result.replyRecovery = {
            kind: 'unreadable_reply',
            issue: 'PROJECT_ID_TYPO',
            exchangeId: receipt.exchangeId,
            userText: result.lastUserText,
            responseText: result.assistantText,
            format: 'code',
          };
        }
      }
      await this.selectDirectReply(result);
      this.logObservation(
        'bridge.reply.observe',
        codeReplyReadShape(result, !!this.options.lastReceipt?.exchangeId),
      );
    }
    if (op === 'stop' || op === 'interrupt') {
      return result;
    }
    if (result.disclosure) {
      const shape = `state=${result.disclosure.state}; attempts=${result.disclosure.attempts}; collapsed=${!!result.lastUserCollapsed}.`;
      this.logObservation('bridge.user.disclosure', shape);
    }
    this.assertCanContinue();
    if (result.stopped) {
      throw new Error('Stopped from the chat page.');
    }
    this.logObservation(
      'bridge.location',
      `Tab ${this.options.tabId}: expected ${expected}; observed ${result.url}; bootstrap=${this.pendingConversationBind}.`,
      result.url,
    );
    if (this.pendingConversationBind) {
      const actual = new URL(result.url);
      if (actual.origin !== this.bootstrapOrigin) {
        throw new PageBridgeError('NAVIGATED', 'The linked tab left ChatGPT. Nothing else will be sent.');
      }
      let bound = '';
      try {
        bound = conversationURL(result.url);
      } catch {}
      if (bound) {
        // Pin the first FINAL route as soon as it is observed after a Send.
        // It is not authentication and grants no permission to import; full
        // receipt checks still follow. Pinning prevents a missing DOM selector
        // from leaving bootstrap free to wander into another conversation.
        const committed =
          this.sendCommitAttempted ||
          (!!this.progress?.lastReceipt && ['commit_intent', 'waiting_reply'].includes(this.progress.stage));
        if (committed && !this.pinnedConversation) {
          this.pinnedConversation = bound;
          if (this.progress) {
            this.progress.conversationUrl = bound;
          }
          await this.checkpoint();
          this.dependencies.publish({ ...this.status });
          this.dependencies.log(
            'bridge.route.pinned',
            'Saved the first conversation route after Send. Message ownership still requires the saved receipt.',
          );
        }
        let assistantOwned = false;
        if (result.lastRole === 'assistant' && result.complete && !result.busy) {
          try {
            const envelope = this.parseObservedReply(result);
            assistantOwned =
              envelope.workerId === this.options.workerId && envelope.projectId === this.options.projectId;
          } catch {}
        }
        const userOwned =
          !!result.replyEvidence ||
          (!!result.replyRecovery && (await this.matchesSavedReceipt(result.replyRecovery.userText))) ||
          (!!result.lastUserText &&
            !result.lastUserTruncated &&
            (this.matchesExpectedMessage(result.lastUserText) ||
              normalizeMessage(messagePayload(result.lastUserText)) ===
                normalizeMessage(this.bootstrapPrompt) ||
              (await this.matchesSavedReceipt(result.lastUserText)) ||
              (this.options.resumeExisting === true &&
                isTaskBootstrap(result.lastUserText, this.boundWorker()))));
        if (this.pinnedConversation && bound !== this.pinnedConversation) {
          // Some page shells use a non-final /c/ alias. It can settle only
          // before the first imported reply, and only with a FULL matching
          // outgoing message. A stable UUID or missing role/text never permits
          // wandering into the other task's conversation seen in the log.
          const hasFinalConversationId =
            /\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              this.pinnedConversation,
            );
          if (hasFinalConversationId || !userOwned) {
            throw new PageBridgeError(
              'NAVIGATED',
              'The linked tab opened another conversation. Your progress is saved. Resume returns to the task’s recorded chat.',
            );
          }
          this.pinnedConversation = bound;
          if (this.progress) {
            this.progress.conversationUrl = bound;
          }
          await this.checkpoint();
        }
        const hasCommittedSend =
          this.sendCommitAttempted ||
          (!!this.progress?.lastReceipt && ['commit_intent', 'waiting_reply'].includes(this.progress.stage));
        if (!hasCommittedSend && !userOwned && !(this.options.resumeExisting && assistantOwned)) {
          throw new PageBridgeError(
            'NAVIGATED',
            'The new tab changed before the task was sent. Nothing was changed.',
          );
        }
        if (result.lastUserText && !userOwned) {
          // A post-Send snapshot may be partial or use a different literal-text
          // layout. Do not run a second, harsher ownership check here. The SAME
          // receipt confirmation path used by normal replies waits read-only,
          // logs the comparison, and bounds uncertainty below in confirmUserTurn.
          if (hasCommittedSend) {
            if (op === 'inspect') {
              this.checkTranscript(result);
            }
            return result;
          }
          throw new PageBridgeError(
            'CHAT_OWNERSHIP',
            'The selected conversation could not be matched to this task. Nothing was imported or sent.',
          );
        }
        if (userOwned || (assistantOwned && !result.lastUserText)) {
          if (this.status.url !== bound) {
            this.status.url = bound;
            this.dependencies.log(
              'bridge.bind',
              'Verified this task in its conversation. The route remains provisional until the first reply is validated.',
            );
            this.dependencies.publish({ ...this.status });
          }
          if (assistantOwned && !this.userTurnAcknowledged) {
            this.adoptedAssistantReceipt = replyFingerprint(result);
            this.userTurnAcknowledged = true;
            this.expectedUserMessageId = result.lastUserId || '';
            this.dependencies.log(
              'bridge.ack',
              'Owned assistant reply confirmed the task while its user turn was virtualized.',
            );
          }
        }
        // No ownership yet: acknowledge/wait logic below must see the actual
        // task message or reply before executing anything. Never adopt by URL.
      } else if (actual.pathname !== '/' && actual.pathname !== '') {
        if (!this.sendCommitAttempted) {
          throw new PageBridgeError(
            'NAVIGATED',
            'The new tab changed before the task was sent. Nothing was changed.',
          );
        }
        throw new PageBridgeError(
          'CHAT_BINDING_PENDING',
          'ChatGPT is creating the conversation. Waiting without sending again.',
          true,
        );
      }
    } else if (result.url !== this.status.url) {
      const actual = new URL(result.url);
      if (
        op === 'inspect' &&
        actual.origin === new URL(this.status.url).origin &&
        actual.pathname === '/' &&
        !result.lastUserText &&
        !result.assistantText &&
        !result.draft
      ) {
        throw new PageBridgeError(
          'CHAT_RELOADING',
          'The linked conversation is reloading. Waiting without sending again.',
          true,
        );
      }
      throw new PageBridgeError(
        'NAVIGATED',
        'The linked tab navigated to a different conversation. Resume returns to this task’s saved chat.',
      );
    }
    if (op === 'inspect') {
      this.checkTranscript(result);
    }
    return result;
  }
  /** Count-based, content-free evidence. A page handshake cannot tell us that
   * message selectors still work. Report a reader failure, not a fictitious
   * model wait or user edit, if the page has messages we cannot classify. */
  private checkTranscript(view: ChatView): void {
    const transcript = view.transcript;
    if (!transcript || view.replyEvidence) {
      this.unreadableSince = undefined;
      return;
    }
    if (
      this.progress?.approvedReply &&
      ['local_batch', 'report_due'].includes(this.progress.stage) &&
      this.progress.approvedReply.url === view.url
    ) {
      return;
    }
    // New sends carry a reply nonce. While waiting for it, absent role markers
    // are no longer a failure. Nothing is imported until a correlated complete
    // code payload appears; the normal task/reply timeout still applies.
    const shape = transcriptReadShape(transcript);
    const receiptDiscovery = transcript.receiptDiscovery;
    if (this.logObservation('bridge.transcript', shape)) {
      const ancestry = transcriptAncestryShape(transcript);
      if (ancestry) {
        this.dependencies.log('bridge.reader.shape', ancestry);
      }
    }
    if (transcript.scanLimited) {
      this.readerDiagnostic = readerDiagnostic(view, 'scan_limit');
      throw new PageBridgeError(
        'TRANSCRIPT_LIMIT',
        'The page is too large to inspect safely. No reply was imported. Open the linked chat near its latest messages, then Resume.',
      );
    }
    // This observation authorizes only a bounded recovery request. Its full
    // receipt and live ownership are checked again before any new message;
    // neither its response text nor an ambiguous old reply can be imported.
    if (
      view.replyRecovery &&
      this.progress?.stage === 'waiting_reply' &&
      this.options.lastReceipt?.expectsReplyTo &&
      view.replyRecovery.exchangeId === this.options.lastReceipt.exchangeId
    ) {
      this.unreadableSince = undefined;
      return;
    }
    // Roleless layouts can place message controls beside the matched user
    // bubble. While literal JSON is still growing, that shape grants only a
    // bounded read-only wait, never a response role or permission to import.
    if (
      this.options.lastReceipt?.expectsReplyTo &&
      transcript.roleAttributes === 0 &&
      transcript.alternativeRoles === 0 &&
      transcript.semanticRoles === 0 &&
      receiptDiscovery?.state === 'unknown_tail' &&
      receiptDiscovery.matches === 1 &&
      isReplyFragment(view)
    ) {
      this.unreadableSince = undefined;
      return;
    }
    // A verified send followed by an in-progress unlabelled response is not an
    // unsupported page yet. Wait read-only for its response controls to render;
    // task limits still apply and no action can pass the completion gate here.
    if (
      receiptDiscovery?.state === 'waiting_reply' &&
      receiptDiscovery.matches === 1 &&
      (view.busy || isReplyFragment(view))
    ) {
      this.unreadableSince = undefined;
      return;
    }
    if (this.options.lastReceipt?.expectsReplyTo && !transcript.users) {
      this.unreadableSince = undefined;
      return;
    }
    const pending =
      this.sendCommitAttempted ||
      (!!this.progress?.lastReceipt && ['commit_intent', 'waiting_reply'].includes(this.progress.stage));
    const missingAfterSend = pending && view.ready !== false && view.count === 0 && view.url.includes('/c/');
    if (transcript.state === 'unrecognized' || transcript.unclassifiedTail || missingAfterSend) {
      if (this.unreadableSince === undefined) {
        this.unreadableSince = this.now();
      }
      const waiting = this.now() - this.unreadableSince < 12000;
      if (waiting) {
        throw new PageBridgeError(
          'TRANSCRIPT_LOADING',
          'Waiting for the chat’s message structure to load. Nothing is being sent again.',
          true,
        );
      }
      let reason: ReaderDiagnostic['reason'] = 'awaiting_receipt';
      if (transcript.unclassifiedTail) {
        reason = 'unclassified_tail';
      }
      this.readerDiagnostic = readerDiagnostic(view, reason);
      throw new PageBridgeError(
        'TRANSCRIPT_UNSUPPORTED',
        'Miter could not read a complete reply for this task. Open the chat to check it. If the full JSON is present, select it with Use reply. Your files and progress are saved.',
      );
    }
    this.unreadableSince = undefined;
  }
  /** Invoked ONLY after the extension UI has shown and confirmed this exact
   * handoff. Unlike Resume, importing that chosen handoff does not depend on
   * reconstructing the old user bubble. Same host import/run/dedup gates.
   */
  async startWithReply(raw: string, url: string): Promise<void> {
    if (this.operationRunning) {
      throw new Error('The task is already starting.');
    }
    this.operationRunning = true;
    this.operationIdle = new Promise((resolve) => {
      this.operationDone = resolve;
    });
    try {
      const worker = this.boundWorker();
      const envelope = boundReply(raw, worker.id, worker.projectId);
      await this.restoreProgress();
      this.assertCanContinue();
      if (
        worker.mode !== 'handoff' ||
        !['idle', 'review', 'paused', 'blocked'].includes(worker.state) ||
        worker.queue.length ||
        worker.pending ||
        worker.humanAcceptanceReady
      ) {
        throw new Error('Resolve this task’s pending local work first.');
      }
      this.status.url = conversationURL(url);
      this.pinnedConversation = this.status.url;
      this.pendingConversationBind = false;
      this.status.bindingPending = false;
      const progress = this.progress;
      if (!progress) {
        throw new Error('Saved task progress is unavailable.');
      }
      assertFreshReplyExchange(worker, envelope.replyTo, progress);
      progress.conversationUrl = this.status.url;
      progress.approvedReply = {
        id: envelope.id,
        hash: await replyDigest(envelope),
        url: this.status.url,
        at: this.now(),
      };
      await this.checkpoint('waiting_reply');
      await this.loadTaskPrompts(worker.id);
      this.assertCanContinue();
      const page: ChatView = {
        url: this.status.url,
        count: 1,
        userCount: 0,
        lastRole: 'assistant',
        assistantId: envelope.id,
        assistantText: raw,
        lastUserText: '',
        busy: false,
        complete: true,
        draft: false,
        draftText: '',
        stopped: false,
        ready: true,
        assistantFormat: 'code',
        replyEvidence: 'user',
      };
      this.starting = false;
      await this.importEnvelope(envelope, worker, page);
      this.dependencies.log(
        'bridge.reply.accepted',
        'Applied the reply you selected. Saved turns and task identity were not reset.',
      );
    } catch (error) {
      await this.stop(errorMessage(error), 'error', bridgeErrorCode(error));
      throw error;
    } finally {
      this.operationRunning = false;
      this.operationDone?.();
    }
  }

  async start(): Promise<void> {
    if (this.operationRunning) {
      return;
    }
    this.operationRunning = true;
    this.operationIdle = new Promise((resolve) => {
      this.operationDone = resolve;
    });
    try {
      const worker = this.boundWorker();
      await this.restoreProgress();
      this.assertCanContinue();
      if (this.options.reattachRevision !== undefined) {
        // Cold setup attaches a monitor. Only the host's recorded user decision
        // may release the accepted batch or start a terminal.
        if (
          !this.options.expectedBatchId &&
          (worker.mode !== 'handoff' ||
            !['idle', 'review'].includes(worker.state) ||
            worker.pending ||
            worker.queue.length ||
            worker.humanAcceptanceReady ||
            worker.teamPaused)
        ) {
          throw new Error('The worker no longer has an outstanding reply.');
        }
        await this.loadTaskPrompts(worker.id);
        await this.dependencies.verifyStartup?.();
        this.assertCanContinue();
        this.starting = false;
        this.restoringPendingSend = true;
        this.sentAt = this.now();
        if (this.options.expectedBatchId) {
          this.update('waiting_approval', 'Waiting for the project setup result…');
        } else {
          this.update('waiting_reply', 'Checking the saved ChatGPT reply…');
        }
        return;
      }
      const continueBatch =
        this.options.resumeExisting === true &&
        !!worker.queue.length &&
        this.progress?.stage === 'local_batch' &&
        this.progress.lastImportedId === worker.queue[0]?.id;
      if (
        worker.mode !== 'handoff' ||
        !['idle', 'review', 'paused', 'blocked'].includes(worker.state) ||
        (worker.queue.length && !continueBatch) ||
        worker.pending
      ) {
        throw new Error(
          'This task has unfinished local work. Review its activity before starting another chat session.',
        );
      }
      if (worker.humanAcceptanceReady) {
        throw new Error('The result is ready for your review. Another chat is not needed.');
      }
      this.update('connecting', 'Connecting to ChatGPT…');
      await this.loadTaskPrompts(worker.id);
      this.assertCanContinue();
      if (continueBatch) {
        // Continue the previously imported local action IDs at the host's saved
        // cursor. Never re-import this batch or request another bootstrap.
        await this.dependencies.verifyStartup?.();
        this.assertCanContinue();
        this.update('running', 'Continuing saved local edits…');
        this.assertCanContinue();
        // The host may consume this head as soon as resume is sent; only run ownership remains pinned.
        this.starting = false;
        await this.queryRpc('worker.resume', {
          workerId: worker.id,
          epoch: this.executionEpoch,
        });
        this.assertCanContinue();
        this.dependencies.log(
          'bridge.resume.local',
          'Continued the saved imported batch. Turn count retained; no new message sent.',
        );
        return;
      }
      this.starting = false;
      await this.initialise();
    } catch (error) {
      if (this.options.reattachRevision !== undefined && this.starting) {
        await this.stop(errorMessage(error), 'error', bridgeErrorCode(error));
        throw error;
      }
      if (!this.recover(error, 'connecting')) {
        await this.stop(errorMessage(error), 'error', bridgeErrorCode(error));
        throw error;
      }
    } finally {
      this.operationRunning = false;
      this.operationDone?.();
    }
  }

  async hasOutgoingDraft(text: string, exchangeId: string): Promise<boolean> {
    const receipt = this.options.lastReceipt;
    if (!this.status.active || !receipt || receipt.exchangeId !== exchangeId) {
      return false;
    }
    if (text === this.expectedUserText) {
      return true;
    }
    if (!receipt.composerHash) {
      return false;
    }
    return matchesBootstrapDraft(text, {
      exchangeId,
      rawHash: receipt.composerHash,
    });
  }

  private async initialise(): Promise<void> {
    this.assertCanContinue();
    const worker = this.boundWorker();
    if (
      !worker.activeFollowupId &&
      this.progress?.approvedReply &&
      ['local_batch', 'report_due'].includes(this.progress.stage)
    ) {
      this.update('running', 'Continuing the reply you selected…');
      return;
    }
    if (worker.control?.mode === 'fresh' && this.progress?.stage === 'report_due') {
      const current = await this.requestPage('probe');
      this.assertCanContinue();
      if (current.draft) {
        throw new PageBridgeError('DRAFT_CONFLICT', 'Your draft is safe. Move or send it before continuing.');
      }
      if (current.ready === false || current.busy) {
        if (this.now() - this.resumedAt > 60000) {
          throw new PageBridgeError(
            'CHAT_BUSY',
            'The previous reply is still running or the composer is not ready. No new request was sent.',
          );
        }
        this.update('connecting', 'Waiting for the previous reply to stop before continuing fresh…');
        return;
      }
      await this.send(
        this.bootstrapPrompt +
          '\n\nFRESH CONTINUATION FROM SAVED WORK\n' +
          (await this.loadReportPrompt(worker)),
        current,
      );
      return;
    }
    const freshComposer =
      this.options.newChat === true && isUnsentBootstrap(this.progress) && !this.options.lastReceipt;
    if (freshComposer && this.dependencies.canBootstrap?.() === false) {
      this.update('connecting', 'Waiting for the other task to open its conversation…');
      return;
    }
    let page = await this.requestPage('inspect');
    if (page.ready === false) {
      this.update('connecting', 'Waiting for the ChatGPT page to be ready…');
      if (this.now() - this.resumedAt > 60000) {
        throw new PageBridgeError(
          'CHAT_NOT_READY',
          'ChatGPT’s composer is unavailable. Open chat to check page loading and sign in if needed, then resume this task. No new Send was attempted.',
        );
      }
      return;
    }
    if (
      page.draft &&
      !page.busy &&
      freshComposer &&
      page.url === this.bootstrapOrigin &&
      page.count === 0 &&
      page.transcript?.state === 'empty'
    ) {
      const proof = await this.dependencies.inspectBootstrapDraft?.(page.draftText);
      this.assertCanContinue();
      if (proof === 'pending') {
        this.update('connecting', 'Waiting for the other task’s reply before using this chat…');
        return;
      }
      if (proof) {
        const verified = bootstrapDraftSchema.parse(proof);
        page = await this.requestPage('clear_draft', {
          text: page.draftText,
          composerSession: page.composerSession,
          staleDraft: verified,
        });
        this.assertCanContinue();
        if (page.outcome !== 'cleared' || page.draft) {
          throw new PageBridgeError('DRAFT_CONFLICT', 'The restored draft could not be cleared safely.');
        }
        this.dependencies.log(
          'bridge.draft.recovered',
          'Cleared an exact previously confirmed task draft. Nothing was resent.',
        );
      }
    }
    const receipt = parseReceipt(this.options.lastReceipt);
    const receiptBound =
      !!receipt &&
      receipt.workerId === worker.id &&
      receipt.projectId === worker.projectId &&
      receipt.goalHash === (await messageDigest(worker.goal));
    const receiptMatches = async (text: string): Promise<boolean> => {
      if (!receiptBound || !receipt) {
        return false;
      }
      return matchesReceipt(text, receipt);
    };
    const ownedReceipt =
      !!page.replyEvidence ||
      (this.options.resumeExisting === true &&
        !page.lastUserTruncated &&
        !!page.lastUserText &&
        (await receiptMatches(page.lastUserText)));
    this.assertCanContinue();
    const emptyBootstrapChat =
      this.pendingConversationBind &&
      chatStartURL(page.url, true) === this.bootstrapOrigin &&
      isEmptyChat(page) &&
      !page.busy;
    if (page.draft && (await receiptMatches(page.draftText))) {
      if (this.progress && ['commit_intent', 'waiting_reply'].includes(this.progress.stage)) {
        throw new PageBridgeError(
          'SEND_UNCERTAIN_DRAFT',
          'A prior Send may have happened, but its draft is still present. It was not sent twice. Check the linked chat before continuing.',
        );
      }
      let mode: 'adopt-bootstrap' | undefined;
      if (emptyBootstrapChat && this.progress?.stage === 'prepared' && this.status.turns === 0) {
        mode = 'adopt-bootstrap';
      }
      await this.send(messagePayload(page.draftText), page, mode);
      return;
    }
    if (this.progress?.stage === 'prepared' && receiptBound && receipt?.imageMode && !page.draft) {
      if (page.busy) {
        this.update('connecting', 'Waiting for ChatGPT before restoring the unsent image request…');
        return;
      }
      if (
        page.lastUserTruncated ||
        !page.lastUserText ||
        (receipt.priorUserId && page.lastUserId !== receipt.priorUserId) ||
        (await messageDigest(page.lastUserText)) !== receipt.priorUserHash ||
        (await messageDigest(replyFingerprint(page))) !== receipt.priorAssistantHash
      ) {
        throw new PageBridgeError(
          'PREPARED_MESSAGE_CHANGED',
          'The saved image request could not be verified in this chat. No image was requested again.',
        );
      }
      const [action] = this.parseObservedReply(page).actions;
      if (action?.type !== 'generateImage') {
        throw new PageBridgeError('PREPARED_MESSAGE_CHANGED', 'The original image request is unavailable.');
      }
      await this.send(action.prompt, page, 'generate-image');
      return;
    }
    if (
      this.progress?.stage === 'prepared' &&
      receiptBound &&
      receipt?.imageAttachments?.length &&
      receipt.exchangeId &&
      !receipt.replacesExchangeId &&
      !page.draft
    ) {
      if (page.busy) {
        this.update('connecting', 'Waiting for the chat before restoring the image attachments…');
        return;
      }
      const previousText = page.lastUserText;
      if (
        page.lastUserTruncated ||
        (previousText && (await messageDigest(previousText)) !== receipt.priorUserHash) ||
        (receipt.priorUserHash && !previousText) ||
        (receipt.priorUserId && page.lastUserId !== receipt.priorUserId)
      ) {
        throw new PageBridgeError(
          'PREPARED_MESSAGE_CHANGED',
          'The chat changed while the images were being prepared. Open the original chat to continue.',
        );
      }
      let prompt = this.bootstrapPrompt;
      const bootstrap = buildExchangeMessage(prompt, receipt.exchangeId, worker);
      if (!(await receiptMatches(bootstrap))) {
        prompt = await this.loadReportPrompt(worker);
        if (worker.control?.mode === 'fresh') {
          prompt = this.bootstrapPrompt + '\n\nFRESH CONTINUATION FROM SAVED WORK\n' + prompt;
        }
      }
      await this.send(prompt, page);
      return;
    }
    if (freshComposer && emptyBootstrapChat && page.draft) {
      const frame = unwrapMessage(page.draftText);
      if (frame && page.draftText === buildExchangeMessage(this.bootstrapPrompt, frame.exchangeId, worker)) {
        // The host has no previous Send and the full draft matches this exact task.
        await this.send(frame.payload, page, 'adopt-bootstrap');
        return;
      }
    }
    if (
      this.progress?.stage === 'prepared' &&
      receiptBound &&
      receipt?.replacesExchangeId &&
      receipt.exchangeId
    ) {
      // A service-worker restart can occur after the new receipt is saved but
      // before prepare inserts it. The older visible reply cannot acknowledge it.
      if (
        page.draft ||
        page.busy ||
        page.lastUserTruncated ||
        !page.lastUserText ||
        (await messageDigest(page.lastUserText)) !== receipt.priorUserHash
      ) {
        throw new PageBridgeError(
          'PREPARED_MESSAGE_CHANGED',
          'The reviewed message is no longer fully visible. No resend was attempted.',
        );
      }
      const restored = renewExchangeMessage(
        page.lastUserText,
        receipt.replacesExchangeId,
        receipt.exchangeId,
        worker,
      );
      if (restored === undefined || !(await receiptMatches(restored))) {
        throw new PageBridgeError(
          'PREPARED_MESSAGE_CHANGED',
          'The saved resend could not be reconstructed exactly. Nothing was sent.',
        );
      }
      await this.send(restored, page);
      return;
    }
    const ownedText = messagePayload(page.lastUserText);
    const ownedUser =
      ownedReceipt ||
      normalizeMessage(ownedText) === normalizeMessage(this.bootstrapPrompt) ||
      ownedText.startsWith(this.nextStepPrompt + '\n\nBEGIN UNTRUSTED MITTER REPORT') ||
      (this.options.resumeExisting === true && isTaskBootstrap(page.lastUserText, worker));
    let ownedAssistant = false;
    if (this.options.resumeExisting && page.complete && !page.busy && page.lastRole === 'assistant') {
      try {
        const envelope = this.parseObservedReply(page);
        ownedAssistant = envelope.workerId === worker.id && envelope.projectId === worker.projectId;
      } catch {}
    }
    if (worker.activeFollowupId && this.progress?.stage === 'report_due') {
      if (page.draft) {
        throw new PageBridgeError(
          'DRAFT_CONFLICT',
          'Your draft is safe. Send or move it before continuing the follow-up.',
        );
      }
      if (page.busy) {
        this.update('connecting', 'Waiting for the current reply before sending your follow-up…');
        return;
      }
      if (!ownedUser && !ownedReceipt) {
        throw new PageBridgeError(
          'CHAT_OWNERSHIP',
          'The saved conversation could not be verified. Your follow-up is queued, not lost.',
        );
      }
      await this.send(await this.loadReportPrompt(worker), page);
      return;
    }
    const pendingSend =
      !!receiptBound && !!this.progress && ['commit_intent', 'waiting_reply'].includes(this.progress.stage);
    // A restart can briefly show the PREVIOUS owned exchange while the latest
    // committed send is absent. Never interpret that older reply as permission
    // to resend the latest report. Await its saved receipt, read-only.
    if (pendingSend && !ownedReceipt && !page.draft) {
      this.restoringPendingSend = true;
      this.expectedUserText = '';
      this.expectedRenderedUserText = '';
      this.userTurnAcknowledged = false;
      this.expectedUserMessageId = '';
      this.priorUserIds = new Set();
      if (receipt?.priorUserId) {
        this.priorUserIds.add(receipt.priorUserId);
      }
      this.previousUserText = '';
      if (ownedUser) {
        this.previousUserText = page.lastUserText;
      }
      this.sentAt = this.now();
      this.userVisibilitySince = undefined;
      this.status.turns = Math.max(this.status.turns, receipt?.turn ?? 0);
      this.update('waiting_reply', 'Confirming the saved send… Nothing will be sent twice.');
      await this.checkpoint();
      return;
    }
    // A draft conflict can pause a brand-new task before its first send. The
    // durable exact-zero checkpoint distinguishes that case from a missing
    // conversation with earlier sends or imported work. Only a blank new-chat
    // root can continue; an uncertain or prepared send still requires recovery.
    const unsentNewChat = freshComposer && emptyBootstrapChat && !page.draft;
    if (this.options.resumeExisting && !ownedUser && !ownedAssistant && !page.draft && !unsentNewChat) {
      if (page.count === 0 || (page.busy && !page.lastUserText)) {
        this.update('connecting', 'Reopening the saved chat… Waiting for this task’s messages.');
        if (this.now() - this.resumedAt > 60000) {
          throw new PageBridgeError(
            'CHAT_NOT_LOADED',
            'The saved chat did not load this task. Sign in or choose its original chat. Nothing was sent.',
          );
        }
        return;
      }
      throw new PageBridgeError(
        'CHAT_OWNERSHIP',
        'This chat does not show the current task. Nothing was sent; choose its original chat.',
      );
    }
    if (
      page.draft &&
      normalizeMessage(messagePayload(page.draftText || '')) !== normalizeMessage(this.bootstrapPrompt)
    ) {
      // A pending report from this same run is safe to reuse, never a user draft.
      const next = await this.loadReportPrompt(worker);
      if (normalizeMessage(messagePayload(page.draftText || '')) !== normalizeMessage(next)) {
        throw new PageBridgeError(
          'DRAFT_CONFLICT',
          'Your draft is safe. Send or move it, then resume Mitter.',
        );
      }
      await this.send(next, page);
      return;
    }
    if (ownedAssistant && !ownedUser && page.lastUserText) {
      throw new PageBridgeError(
        'USER_ECHO_UNREADABLE',
        'The reply belongs to this task, but Mitter could not verify the preceding report. Progress is saved; copy diagnostics instead of sending again.',
      );
    }
    if ((ownedUser || ownedAssistant) && !page.draft) {
      this.adoptedAssistantReceipt = '';
      if (ownedAssistant && !page.lastUserText) {
        this.adoptedAssistantReceipt = replyFingerprint(page);
      }
      if (ownedUser) {
        this.expectedUserText = page.lastUserText;
      } else {
        this.expectedUserText = this.bootstrapPrompt;
      }
      this.userTurnAcknowledged = true;
      this.expectedUserMessageId = '';
      if (ownedUser) {
        this.expectedUserMessageId = page.lastUserId || '';
      }
      this.priorUserIds = new Set((page.userIds || []).filter((id) => id !== this.expectedUserMessageId));
      this.messageCountBeforeSend = page.count;
      if (page.lastRole === 'assistant') {
        this.messageCountBeforeSend = Math.max(0, page.count - 1);
      }
      this.sentAt = this.now();
      const observed =
        page.observedTaskTurns?.find(
          (taskTurns) => taskTurns.workerId === worker.id && taskTurns.projectId === worker.projectId,
        )?.count ?? 0;
      this.status.turns = Math.max(this.status.turns, receipt?.turn ?? 0, observed, 1);
      // Old builds did not record every outgoing send. Preserve a known lower
      // bound rather than presenting a fabricated exact history.
      await this.checkpoint('waiting_reply');
      let replyReason = 'Checking the existing reply…';
      if (page.busy) {
        replyReason = 'ChatGPT is working…';
      }
      this.update('waiting_reply', replyReason);
      this.dependencies.log(
        'bridge.adopt',
        'Reusing the existing task exchange; the initial prompt was not resent.',
      );
      if (page.complete && !page.busy && page.lastRole === 'assistant') {
        if (
          receipt?.priorAssistantHash &&
          (await messageDigest(replyFingerprint(page))) === receipt.priorAssistantHash
        ) {
          this.replyCandidate = undefined;
          return;
        }
        let envelope: ProposalEnvelope;
        try {
          envelope = this.parseObservedReply(page);
        } catch {
          // Resume follows the SAME bounded format-repair path as a live turn,
          // instead of throwing on the old reply before recovery can run.
          this.replyCandidate = { fingerprint: replyFingerprint(page), since: this.now() };
          return;
        }
        if (envelope.workerId !== worker.id || envelope.projectId !== worker.projectId) {
          if (
            page.replyRecovery?.issue === 'PROJECT_ID_TYPO' &&
            receipt &&
            mistypedProjectHeaders(page, receipt)
          ) {
            return; // The normal receive loop rechecks the live receipt before a fresh correction.
          }
          throw new Error('The existing reply has the wrong worker/project IDs. No actions were imported.');
        }
        const seen = await this.queryRpc('worker.handoffSeen', {
          workerId: worker.id,
          envelopeId: envelope.id,
        });
        this.assertCanContinue();
        if (seen.seen) {
          this.dependencies.log(
            'bridge.resume',
            'This batch was already imported; requesting the next step without replaying it.',
          );
          await this.send(await this.loadReportPrompt(worker), page);
          return;
        }
        // Even an adopted reply is observed twice before execution.
        this.replyCandidate = { fingerprint: replyFingerprint(page), since: this.now() };
      }
      return;
    }
    if (page.busy) {
      this.update('connecting', 'Waiting for ChatGPT to finish its current reply…');
      return;
    }
    let initialPrompt = this.bootstrapPrompt;
    if (worker.state === 'review') {
      initialPrompt = await this.loadReportPrompt(worker);
    }
    await this.send(initialPrompt, page);
  }

  private async loadTaskPrompts(workerId: string): Promise<void> {
    this.bootstrapPrompt = await this.queryRpc('worker.prompt', { workerId, kind: 'bootstrap' });
    this.assertCanContinue();
    this.nextStepPrompt = await this.queryRpc('worker.prompt', { workerId, kind: 'next' });
    this.assertCanContinue();
  }

  private async loadReportPrompt(worker: Worker): Promise<string> {
    const nextStepPrompt = await this.queryRpc('worker.prompt', {
      workerId: worker.id,
      kind: 'next',
    });
    this.assertCanContinue();
    const report = await this.queryRpc('worker.report', {
      workerId: worker.id,
    });
    this.assertCanContinue();
    // Refresh registered commands and project context for this new exchange.
    // Pending sends retain their saved bytes. Explicit resends use the reviewed body.
    this.nextStepPrompt = nextStepPrompt;
    return buildReportPrompt(this.nextStepPrompt, report);
  }

  private async send(
    text: string,
    page: ChatView,
    mode?: 'resend' | 'adopt-bootstrap' | 'generate-image',
  ): Promise<void> {
    this.assertCanContinue();
    if (this.status.turns >= this.status.maxTurns) {
      throw new PageBridgeError(
        'TURN_LIMIT',
        'The task’s turn budget is used. Progress is saved; add more turns to continue.',
      );
    }
    if (page.busy) {
      throw new Error('ChatGPT is busy. Nothing was sent.');
    }
    if (page.draft && normalizeMessage(messagePayload(page.draftText || '')) !== normalizeMessage(text)) {
      throw new PageBridgeError('DRAFT_CONFLICT', 'Your draft is safe. Mitter will not overwrite it.');
    }
    // Never rewrite an existing, exact Mitter draft. Fresh messages use a
    // literal transport block so report/code Markdown cannot corrupt the echo.
    let savedPrepared: OutboundReceipt | undefined;
    if (this.progress?.stage === 'prepared') {
      savedPrepared = parseReceipt(this.options.lastReceipt);
    }
    let expectsReplyTo = false;
    let replacesExchangeId = savedPrepared?.replacesExchangeId;
    const imageMode = mode === 'generate-image' || savedPrepared?.imageMode === true;
    let imageExchange: string | undefined;
    if (imageMode) {
      imageExchange = savedPrepared?.exchangeId || crypto.randomUUID();
      if (page.draft) {
        text = page.draftText;
      } else {
        const description = text.replace(/\s+/g, ' ').trim();
        text = `Create one image. ${description} Request reference ${imageExchange} (leave this reference out of the image).`;
      }
    } else if (page.draft) {
      text = page.draftText;
      const saved = parseReceipt(this.options.lastReceipt);
      const frame = unwrapMessage(text);
      const worker = this.boundWorker();
      // An interrupted prepare already contains its replyTo contract. Reusing
      // those exact bytes must retain correlation, not downgrade to a legacy
      // unlinked send. This is allowed only against the saved full receipt.
      expectsReplyTo =
        !!frame &&
        ((mode === 'adopt-bootstrap' && !saved) ||
          (saved?.expectsReplyTo === true &&
            frame.exchangeId === saved.exchangeId &&
            saved.workerId === worker.id &&
            saved.projectId === worker.projectId &&
            saved.goalHash === (await messageDigest(worker.goal)) &&
            (await matchesReceipt(text, saved))));
    } else if (mode === 'resend') {
      if (this.options.lastReceipt?.imageMode) {
        throw new PageBridgeError(
          'IMAGE_SEND_UNCONFIRMED',
          'The image request was not resent. Check the linked chat for its result.',
        );
      }
      if (!(await this.matchesSavedReceipt(text))) {
        throw new PageBridgeError(
          'RESEND_MISMATCH',
          'The saved prompt is unavailable or changed. Nothing was resent.',
        );
      }
      const previous = this.options.lastReceipt;
      const nextId = crypto.randomUUID();
      if (previous?.expectsReplyTo && previous.exchangeId) {
        const renewed = renewExchangeMessage(text, previous.exchangeId, nextId, this.boundWorker());
        if (renewed === undefined) {
          throw new PageBridgeError(
            'RESEND_MISMATCH',
            'The original reply contract could not be verified. Nothing was resent.',
          );
        }
        text = renewed;
        replacesExchangeId = previous.exchangeId;
      } else {
        text = buildExchangeMessage(messagePayload(text), nextId, this.boundWorker());
      }
      expectsReplyTo = true;
    } else if (savedPrepared?.replacesExchangeId && (await this.matchesSavedReceipt(text))) {
      expectsReplyTo = true;
    } else {
      const exchangeId = savedPrepared?.exchangeId || crypto.randomUUID();
      expectsReplyTo = true;
      text = buildExchangeMessage(text, exchangeId, this.boundWorker());
    }
    if (text.length > 160000) {
      throw new PageBridgeError(
        'MESSAGE_TOO_LARGE',
        'The task report is too large to send safely. No message was inserted.',
      );
    }
    this.waitObservation = '';
    this.waitUnchangedAt = this.now();
    this.restoringPendingSend = false;
    this.unreadableSince = undefined;
    this.expectedUserText = text;
    this.expectedRenderedUserText = '';
    this.messageCountBeforeSend = page.count;
    this.previousUserText = page.lastUserText;
    this.previousAssistantId = page.assistantId;
    this.previousAssistantText = page.assistantText;
    this.userTurnAcknowledged = false;
    this.adoptedAssistantReceipt = '';
    this.expectedUserMessageId = '';
    this.priorUserIds = new Set(page.userIds || []);
    if (page.lastUserId) {
      this.priorUserIds.add(page.lastUserId);
    }
    this.conflictingUserObservation = undefined;
    this.userVisibilitySince = undefined;
    this.observations.delete('bridge.user.observe');
    this.replyCandidate = undefined;
    this.recoveryCandidate = undefined;
    this.unlinkedCandidate = undefined;
    this.unlinkedWaitSince = undefined;
    this.sentAt = this.now();
    if (savedPrepared && !(await this.matchesSavedReceipt(text))) {
      throw new PageBridgeError(
        'PREPARED_MESSAGE_CHANGED',
        'The saved unsent message cannot be reconstructed exactly. Its draft was left untouched; review it before continuing.',
      );
    }
    const messageId = savedPrepared?.messageId || crypto.randomUUID();
    let preparationReason = 'Preparing the next step…';
    if (this.status.turns === 0) {
      preparationReason = 'Preparing your task…';
    }
    this.update('sending', preparationReason);
    const worker = this.boundWorker();
    let images: ImageAttachment[] | undefined;
    if (!imageMode) {
      images = this.imagesForSend(worker, savedPrepared, mode === 'resend');
    }
    const frame = unwrapMessage(text);
    const goalHash = await messageDigest(worker.goal);
    const textHash = await messageDigest(text);
    const receipt: OutboundReceipt = {
      workerId: worker.id,
      projectId: worker.projectId,
      goalHash,
      textHash,
      renderedHash: textHash,
      at: this.now(),
      messageId,
      priorReplyIds: page.codeReplyIds?.slice(-64),
      exchangeId: imageExchange || frame?.exchangeId,
    };
    if (imageMode) {
      receipt.imageMode = true;
    }
    if (replacesExchangeId) {
      receipt.replacesExchangeId = replacesExchangeId;
    }
    if (expectsReplyTo) {
      receipt.expectsReplyTo = true;
    }
    if (images?.length) {
      receipt.imageAttachments = images;
    }
    let payloadHash: string | undefined;
    if (frame) {
      payloadHash = await messageDigest(frame.payload);
    }
    receipt.payloadHash = payloadHash;
    receipt.turn = this.status.turns + 1;
    receipt.priorUserId = page.lastUserId || undefined;
    let priorUserHash: string | undefined;
    if (page.lastUserText) {
      priorUserHash = await messageDigest(page.lastUserText);
    }
    receipt.priorUserHash = priorUserHash;
    let priorAssistantHash: string | undefined;
    if (page.assistantText) {
      priorAssistantHash = await messageDigest(replyFingerprint(page));
    }
    receipt.priorAssistantHash = priorAssistantHash;
    // Save the receipt BEFORE changing the page, not after a readiness timer.
    // The host is authoritative: browser migration metadata must never get
    // ahead of a prepared checkpoint and make an unsent draft look submitted.
    this.options.lastReceipt = receipt;
    await this.checkpoint('prepared');
    this.assertCanContinue();
    try {
      await this.dependencies.saveReceipt?.(receipt);
    } catch {
      throw new PageBridgeError(
        'RECEIPT_SAVE_FAILED',
        'Resume information could not be saved. No new Send was attempted.',
      );
    }
    this.assertCanContinue();
    this.pendingSend = {
      text,
      messageId,
      startedAt: this.now(),
      commitIntent: false,
      uploadedImages: 0,
      ...(images?.length && { imageAttachments: images }),
      ...(mode === 'adopt-bootstrap' && { adoptBootstrapDraft: true }),
    };
    this.lastSendReadiness = '';
    await this.advanceSend();
  }

  private imagesForSend(
    worker: Worker,
    savedPrepared: OutboundReceipt | undefined,
    resend: boolean,
  ): ImageAttachment[] | undefined {
    if (savedPrepared) {
      return savedPrepared.imageAttachments;
    }
    if (resend) {
      return this.options.lastReceipt?.imageAttachments;
    }
    let images: ImageAttachment[] | undefined;
    if (this.status.turns === 0) {
      images = worker.imageAttachments;
    }
    if (
      worker.activeFollowupId &&
      this.progress?.imageFollowupId !== worker.activeFollowupId &&
      worker.activeFollowupImages?.length
    ) {
      return [...(images ?? []), ...worker.activeFollowupImages];
    }
    return images;
  }

  private async attachImage(
    attachment: ImageAttachment,
    details: Pick<DomRequest, 'text' | 'messageId' | 'composerSession' | 'imageAttachments'>,
  ): Promise<ChatView> {
    let result = await this.requestPage('attach_image', { ...details, image: { attachment } });
    if (result.readiness === 'image_needed') {
      if (!this.dependencies.loadImage) {
        throw new PageBridgeError(
          'IMAGE_UNAVAILABLE',
          'Open this task in the Chrome profile where you attached its images.',
        );
      }
      let base64: string;
      try {
        base64 = await this.dependencies.loadImage(attachment);
      } catch (error) {
        throw new PageBridgeError(
          'IMAGE_UNAVAILABLE',
          'Miter could not open an attached image. Check the Chrome profile where it was added.',
          false,
          { cause: error },
        );
      }
      this.assertCanContinue();
      result = await this.requestPage('attach_image', { ...details, image: { attachment, base64 } });
    }
    return result;
  }
  /** Short, background-driven steps. A hidden page never owns our readiness
   * deadline. Retrying preparation is non-sending; commit retries require a
   * document-local proof and the same message ID/bytes/ledger. */
  private async advanceSend(): Promise<void> {
    const pending = this.pendingSend;
    if (!pending) {
      return;
    }
    this.assertCanContinue();
    if (this.now() - pending.startedAt >= 120000) {
      if (pending.commitIntent) {
        await this.finishSendObservation(
          'Send confirmation is delayed. Checking this chat without clicking again.',
        );
        return;
      }
      throw new PageBridgeError(
        'SEND_NOT_READY',
        'ChatGPT’s composer did not become ready within two minutes. The saved draft is intact; no Send was attempted. Check sign-in, network, or browser suspension, then Resume.',
      );
    }
    let prepared: ChatView | undefined;
    const attachments = pending.imageAttachments;
    const imageMetadata = {
      ...(attachments?.length && { imageAttachments: attachments }),
      ...(this.options.lastReceipt?.imageMode && { imageMode: true as const }),
    };
    try {
      if (!pending.commitIntent) {
        prepared = await this.requestPage('prepare', {
          text: pending.text,
          messageId: pending.messageId,
          adoptBootstrapDraft: pending.adoptBootstrapDraft,
          ...imageMetadata,
        });
        this.assertCanContinue();
        if (prepared.outcome === 'pending') {
          this.sendReadiness(prepared.readiness || 'send_not_ready');
          return;
        }
        if (!['prepared', 'already_clicked', 'already_sent'].includes(prepared.outcome || '')) {
          throw new PageBridgeError(
            'INVALID_PAGE_STATE',
            'The page did not confirm preparation. Nothing was sent.',
            true,
          );
        }
        if (pending.composerSession !== prepared.composerSession) {
          pending.uploadedImages = 0;
        }
        if (prepared.composerSession === undefined) {
          delete pending.composerSession;
        } else {
          pending.composerSession = prepared.composerSession;
        }
        const image = attachments?.[pending.uploadedImages];
        if (image && prepared.outcome === 'prepared') {
          if (!pending.composerSession) {
            throw new PageBridgeError(
              'IMAGE_UNAVAILABLE',
              'Reload Miter to enable images in the chat composer.',
            );
          }
          const upload = await this.attachImage(image, {
            text: pending.text,
            messageId: pending.messageId,
            composerSession: pending.composerSession,
            ...imageMetadata,
          });
          this.assertCanContinue();
          if (upload.outcome === 'attached') {
            pending.uploadedImages++;
          } else if (upload.outcome !== 'pending') {
            throw new PageBridgeError('INVALID_PAGE_STATE', 'The chat did not confirm the image.');
          }
          this.sendReadiness('uploading_images');
          if (pending.uploadedImages < (attachments?.length || 0)) {
            return;
          }
        }
        this.expectedRenderedUserText = prepared.renderedDraftText || '';
        if (this.options.lastReceipt) {
          const receipt: OutboundReceipt = {
            ...this.options.lastReceipt,
            renderedHash: await messageDigest(this.expectedRenderedUserText || pending.text),
          };
          if (prepared.outcome === 'prepared' && prepared.draftText === pending.text) {
            receipt.composerHash = await rawDraftDigest(pending.text);
          }
          if (
            this.status.turns === 0 &&
            this.options.newChat === true &&
            receipt.composerHash &&
            receipt.exchangeId &&
            prepared.url === this.bootstrapOrigin
          ) {
            receipt.bootstrapDraft = bootstrapDraftSchema.parse({
              workerId: receipt.workerId,
              projectId: receipt.projectId,
              goalHash: receipt.goalHash,
              exchangeId: receipt.exchangeId,
              origin: this.bootstrapOrigin,
              rawHash: receipt.composerHash,
            });
          }
          this.assertCanContinue();
          this.options.lastReceipt = receipt;
          await this.checkpoint('prepared');
          this.assertCanContinue();
          try {
            await this.dependencies.saveReceipt?.(receipt);
          } catch {
            throw new PageBridgeError(
              'RECEIPT_SAVE_FAILED',
              'Resume information could not be saved. Your draft is safe; no Send was attempted.',
            );
          }
          this.assertCanContinue();
        }
        let sendReason = 'Sending the results to ChatGPT…';
        if (this.status.turns === 0) {
          sendReason = 'Sending your task…';
        }
        this.update('sending', sendReason);
        if (this.progress) {
          delete this.progress.approvedReply;
          const followupId = this.boundWorker().activeFollowupId;
          if (followupId && attachments?.length) {
            this.progress.imageFollowupId = followupId;
          }
        }
        this.sendCommitAttempted = true;
        this.status.turns++;
        await this.checkpoint('commit_intent');
        this.assertCanContinue();
        pending.commitIntent = true;
      }
      let result: ChatView;
      if (prepared && ['already_clicked', 'already_sent'].includes(prepared.outcome || '')) {
        result = prepared;
      } else {
        result = await this.requestPage('commit', {
          text: pending.text,
          messageId: pending.messageId,
          composerSession: pending.composerSession,
          adoptBootstrapDraft: pending.adoptBootstrapDraft,
          ...imageMetadata,
        });
      }
      this.assertCanContinue();
      if (result.outcome === 'pending') {
        this.sendReadiness(result.readiness || 'send_not_ready');
        return;
      }
      if (!['clicked', 'already_clicked', 'already_sent'].includes(result.outcome || '')) {
        throw new PageBridgeError('INVALID_PAGE_STATE', 'Invalid commit acknowledgement.', true);
      }
      await this.finishSendObservation('Waiting for ChatGPT…');
    } catch (error) {
      this.assertCanContinue();
      let bridgeError: PageBridgeError | undefined;
      if (error instanceof PageBridgeError) {
        bridgeError = error;
      }
      const notClicked = [
        'COMPOSER_MISSING',
        'SEND_NOT_READY',
        'EDITOR_REPLACED',
        'BUSY',
        'COMPOSER_BUSY',
        'INSERT_REJECTED',
      ];
      if (!pending.commitIntent && bridgeError?.code === 'IMAGE_DOCUMENT_CHANGED' && attachments?.length) {
        delete pending.composerSession;
        pending.uploadedImages = 0;
        this.sendReadiness('uploading_images');
        return;
      }
      if (pending.commitIntent && bridgeError?.code === 'COMMIT_DOCUMENT_CHANGED') {
        await this.finishSendObservation(
          'The chat document changed. Checking for the saved message; nothing is being sent twice.',
        );
        return;
      }
      if (
        pending.commitIntent &&
        bridgeError &&
        ['INVALID_PAGE_STATE', 'INVALID_BRIDGE_REPLY'].includes(bridgeError.code)
      ) {
        await this.finishSendObservation('Checking the send acknowledgement. Nothing is being sent twice.');
        return;
      }
      if (bridgeError && (bridgeError.transient || notClicked.includes(bridgeError.code))) {
        if (
          pending.commitIntent &&
          bridgeError.transient &&
          !notClicked.includes(bridgeError.code) &&
          this.lastSendReadiness !== bridgeError.code
        ) {
          this.dependencies.log(
            'bridge.send.uncertain',
            'A commit acknowledgement was interrupted. Same-document verification is required; no new send ID will be created.',
          );
        }
        if (pending.commitIntent && !pending.composerSession && !notClicked.includes(bridgeError.code)) {
          // An older page cannot prove its commit ledger survived. Read only.
          await this.finishSendObservation('Checking the send acknowledgement. Nothing is being sent twice.');
          return;
        }
        this.sendReadiness(bridgeError.code);
        return;
      }
      throw error;
    }
  }

  private sendReadiness(readiness: string): void {
    if (readiness !== this.lastSendReadiness) {
      this.lastSendReadiness = readiness;
      this.dependencies.log(
        'bridge.send.readiness',
        readiness + '; background retry; no new exchange or blind resend.',
      );
    }
    let reason =
      'Waiting for ChatGPT’s Send button… The saved prompt will be sent when ready; no click is needed.';
    if (readiness === 'TAB_FROZEN' || readiness === 'TAB_DISCARDED') {
      reason =
        'Chrome suspended the linked chat. Waiting for it to become available; the saved prompt is not being resent.';
    } else if (readiness === 'generating' || readiness === 'BUSY') {
      reason = 'Waiting for ChatGPT to finish before sending the saved prompt…';
    } else if (readiness === 'uploading_images') {
      reason = 'Waiting for the images to upload before sending…';
    } else if (this.pendingSend?.commitIntent) {
      reason = 'Confirming this prepared send in the same document…';
    }
    this.update('sending', reason);
  }

  private async finishSendObservation(reason: string): Promise<void> {
    this.assertCanContinue();
    this.pendingSend = undefined;
    this.lastSendReadiness = '';
    this.sentAt = this.now();
    await this.checkpoint('waiting_reply');
    this.assertCanContinue();
    this.dependencies.log(
      'bridge.send',
      `Turn ${this.status.turns} reserved; checking the actual sent message. No new send ID was created during recovery.`,
    );
    this.update('waiting_reply', reason);
  }

  private async confirmBootstrapDraft(): Promise<void> {
    const proof = this.options.lastReceipt?.bootstrapDraft;
    if (proof) {
      await this.dependencies.confirmBootstrapDraft?.(proof);
      this.assertCanContinue();
    }
  }

  private async importEnvelope(envelope: ProposalEnvelope, worker: Worker, page: ChatView): Promise<void> {
    if (envelope.workerId !== worker.id || envelope.projectId !== worker.projectId) {
      throw new Error('Reply has the wrong worker/project IDs. No actions were imported.');
    }
    checkReplyExchange(envelope, this.options.lastReceipt, page.assistantFormat);
    const seen = await this.queryRpc('worker.handoffSeen', {
      workerId: worker.id,
      envelopeId: envelope.id,
    });
    this.assertCanContinue();
    if (seen.seen) {
      this.dependencies.log(
        'bridge.resume',
        'Already imported; requesting the next step without repeating actions.',
      );
      await this.send(await this.loadReportPrompt(worker), page);
      return;
    }
    // Preflight paths and read references before import so rejected batches
    // can be corrected without queuing any actions.
    if (envelope.actions.some((action) => 'path' in action)) {
      const admission = await this.queryRpc('worker.validateReply', {
        workerId: worker.id,
        text: JSON.stringify(envelope),
        epoch: this.executionEpoch,
      });
      this.assertCanContinue();
      if (admission.valid !== true) {
        if (page.replyEvidence === 'user') {
          throw new ReplyValidationError(admission.issue);
        }
        await this.repairReply(worker, page, new ReplyValidationError(admission.issue));
        return;
      }
    }
    this.finalizeConversationBinding();
    const firstAction = envelope.actions[0];
    if (firstAction?.type === 'generateImage') {
      await this.send(firstAction.prompt, page, 'generate-image');
      return;
    }
    try {
      await this.stageReplyImages(envelope, worker);
    } catch (error) {
      this.assertCanContinue();
      if (page.replyEvidence === 'user' || error instanceof NativeRequestTimeout) {
        throw error;
      }
      await this.repairReply(worker, page, error);
      return;
    }
    const content = await messageDigest(JSON.stringify(envelope.actions));
    if (content === this.lastAcceptedActionsHash) {
      this.repeatedActionBatches++;
    } else {
      this.repeatedActionBatches = 0;
    }
    this.lastAcceptedActionsHash = content;
    if (this.repeatedActionBatches >= 2) {
      throw new Error('Three identical proposals. Stopped to avoid an endless loop.');
    }
    this.assertCanContinue();
    this.update('running', 'Accepting the verified reply locally…');
    const hash = await replyDigest(envelope);
    this.assertCanContinue();
    this.pendingDelivery = {
      envelope,
      hash,
      imported: false,
      failures: 0,
      retryAt: 0,
    };
    await this.advanceDelivery();
  }

  private async stageReplyImages(envelope: ProposalEnvelope, worker: Worker): Promise<void> {
    const indices = new Set<number>();
    for (const action of envelope.actions) {
      if (action.type === 'saveImage' && action.source.type === 'generated') {
        indices.add(action.source.index);
      }
    }
    if (!indices.size) {
      return;
    }

    const receipt = parseReceipt(this.options.lastReceipt);
    if (!envelope.replyTo || receipt?.exchangeId !== envelope.replyTo) {
      throw new Error('Generated images must be imported from the reply to this task’s current message.');
    }

    this.update('running', 'Saving the generated images to your project…');
    for (const index of indices) {
      const readImage = async (sourceReceipt: OutboundReceipt) => {
        const view = await this.requestPage('read_generated_image', {
          generatedImageIndex: index,
          sourceReceipt,
        });
        this.assertCanContinue();
        return view.generatedImage;
      };
      let image = await readImage(receipt);
      const previous = this.progress?.imageSourceReceipt;
      if (!image && previous && previous.exchangeId !== receipt.exchangeId) {
        image = await readImage(previous);
      }
      if (!image) {
        throw new Error(
          `Generated image ${index} could not be read from this task’s chat. Use an available image or generate one before requesting saveImage. Do not use a guessed URL or Base64.`,
        );
      }
      for (let offset = 0; offset < image.base64.length; offset += IMAGE_UPLOAD_CHARS) {
        const data = image.base64.slice(offset, offset + IMAGE_UPLOAD_CHARS);
        const params = {
          workerId: worker.id,
          epoch: this.executionEpoch,
          envelopeId: envelope.id,
          exchangeId: envelope.replyTo,
          index,
          contentType: image.contentType,
          offset,
          total: image.base64.length,
          data,
        };
        let result;
        try {
          result = await this.queryRpc('worker.stageImage', params);
        } catch (error) {
          this.assertCanContinue();
          if (!(error instanceof NativeRequestTimeout)) {
            throw error;
          }
          result = await this.queryRpc('worker.stageImage', params);
        }
        this.assertCanContinue();
        if (result.received !== offset + data.length) {
          throw new Error('The local helper did not acknowledge the exact image chunk.');
        }
      }
    }
  }

  private async continueImageReply(page: ChatView, worker: Worker): Promise<boolean> {
    const receipt = parseReceipt(this.options.lastReceipt);
    if (
      !page.generatedImageCount ||
      !receipt?.exchangeId ||
      !this.progress ||
      page.busy ||
      page.draft ||
      (!receipt.imageMode &&
        (page.codeReply || page.unlinkedReply || isIncompleteReplyJSON(page.assistantText)))
    ) {
      this.generatedImageWait = undefined;
      return false;
    }
    const fingerprint = receipt.exchangeId + ':' + page.generatedImageCount;
    if (this.generatedImageWait?.fingerprint !== fingerprint) {
      this.generatedImageWait = { fingerprint, since: this.now() };
      return true;
    }
    if (this.now() - this.generatedImageWait.since < 3500) {
      return true;
    }
    if (
      this.pendingConversationBind &&
      (!this.pinnedConversation ||
        this.pinnedConversation !== this.status.url ||
        this.pinnedConversation !== page.url)
    ) {
      return true;
    }
    // The reader verified the exact receipt and that no later user turn
    // replaced it. That proof also lets an image-only first reply bind the tab.
    this.finalizeConversationBinding();
    this.progress.imageSourceReceipt = receipt;
    const report = await this.loadReportPrompt(worker);
    this.assertCanContinue();
    await this.send(
      report +
        '\n\nThe images from your immediately preceding response are ready. Return only the JSON actions now. Use saveImage with source.type "generated" and the one-based image index, with a new project-relative filename. Keep any public web image requested in the task. Do not generate the same image again or paste a URL for the generated image. Wait for the successful file paths in the next report before using them.',
      page,
    );
    this.generatedImageWait = undefined;
    return true;
  }

  private finalizeConversationBinding(): void {
    if (!this.pendingConversationBind) {
      return;
    }
    conversationURL(this.status.url);
    this.pendingConversationBind = false;
    this.status.bindingPending = false;
    this.dependencies.publish({ ...this.status });
    this.dependencies.log('bridge.bind', 'Conversation binding finalized after an owned, complete reply.');
  }
  /** Only retry a missing native acknowledgement, using the SAME canonical
   * envelope and host receipt. Never resend a prompt, re-import a different
   * proposal, retry a failed file operation or auto-resume a stopped command. */
  private async advanceDelivery(): Promise<void> {
    const delivery = this.pendingDelivery;
    if (!delivery || this.now() < delivery.retryAt) {
      return;
    }
    this.assertCanContinue();
    const worker = this.boundWorker();
    const envelope = delivery.envelope;
    try {
      if (!delivery.imported) {
        await this.queryRpc('worker.import', {
          workerId: worker.id,
          text: JSON.stringify(envelope),
          epoch: this.executionEpoch,
          reconcile: true,
        });
        this.assertCanContinue();
        delivery.imported = true;
        if (this.progress) {
          this.progress.lastImportedId = envelope.id;
        }
        await this.checkpoint('local_batch');
        this.assertCanContinue();
        if (envelope.replyTo && envelope.replyTo === this.options.lastReceipt?.exchangeId) {
          await this.confirmBootstrapDraft();
          try {
            await this.dependencies.rememberAnsweredDraft?.(envelope.replyTo);
          } catch {
            this.dependencies.log('bridge.draft.history', 'Could not retain the answered draft fingerprint.');
          }
          this.assertCanContinue();
        }
      }
      await this.queryRpc('worker.run', {
        workerId: worker.id,
        epoch: this.executionEpoch,
        envelopeId: envelope.id,
        envelopeHash: delivery.hash,
      });
      this.assertCanContinue();
      this.pendingDelivery = undefined;
      this.correctionAttempts = 0;
      this.update('running', 'Applying the accepted batch locally…');
      this.dependencies.log(
        'bridge.import',
        `Imported ${envelope.id}; ${envelope.actions.length} validated actions.`,
      );
    } catch (error) {
      this.assertCanContinue();
      if (
        !(error instanceof NativeRequestTimeout) ||
        !['worker.import', 'worker.run'].includes(error.method)
      ) {
        throw error;
      }
      delivery.failures++;
      if (delivery.failures >= 4) {
        throw new PageBridgeError(
          'LOCAL_ACK_TIMEOUT',
          'The local host is not acknowledging this saved batch. Progress is retained. Reconnect and Resume local work; do not resend the chat prompt.',
        );
      }
      delivery.retryAt = this.now() + Math.min(8000, 1000 * 2 ** (delivery.failures - 1));
      this.dependencies.log(
        'bridge.local.reconcile',
        `${error.method}: checking the same batch receipt; attempt ${delivery.failures}/3. No prompt resent.`,
      );
      this.update(
        'running',
        'Confirming the saved local batch… Edits will not be imported or started twice.',
      );
    }
  }

  private async repairReply(worker: Worker, page: ChatView, error: unknown): Promise<void> {
    let issue: ReplyIssue | undefined;
    if (error instanceof ReplyValidationError) {
      issue = error.issue;
    }
    const reason = errorMessage(error);
    let diagnosis = reason;
    if (issue) {
      diagnosis = correctionAdvice(issue);
    }
    this.dependencies.log(
      'bridge.reply.invalid',
      `${diagnosis} Format=${page.assistantFormat || 'unknown'}; characters=${page.assistantText.length}. Rejected reply content is not logged.`,
    );
    if (this.correctionAttempts >= 2) {
      if (issue) {
        let actionLocation = '';
        if (issue.actionIndex !== undefined) {
          actionLocation = ', action ' + (issue.actionIndex + 1);
        }
        throw new PageBridgeError(
          'REPLY_SCHEMA',
          `Miter received the reply, but its action data is invalid (${issue.code}${actionLocation}). Two correction attempts did not resolve it. No rejected actions ran. Resume rechecks the reply; Stop then Continue fresh requests current file reads.`,
        );
      }
      throw new PageBridgeError(
        'REPLY_FORMAT',
        'Mitter could not safely read the reply after two correction attempts. No actions from those replies ran. Resume rechecks the current reply; details are in the console.',
      );
    }
    this.correctionAttempts++;
    let correctionKind = 'format';
    let repairReason = 'Correcting the reply format… No file changes from that reply.';
    if (issue) {
      correctionKind = 'action-data';
      repairReason = 'Reply received, but its action data needs correction. No rejected changes ran.';
    }
    this.dependencies.log(
      'bridge.repair',
      `Requesting ${correctionKind} correction ${this.correctionAttempts}/2. No actions from the rejected reply were imported.`,
    );
    this.update('repairing', repairReason);
    const report = await this.loadReportPrompt(worker);
    this.assertCanContinue();
    await this.send(buildCorrectionPrompt(report, diagnosis, this.correctionAttempts, !!issue), page);
    if (!this.pendingSend) {
      let waitingReason = 'Waiting for ChatGPT to correct its reply…';
      if (issue) {
        waitingReason = 'Waiting for the corrected action data or requested file reads…';
      }
      this.update('waiting_reply', waitingReason);
    }
  }
  /** Recover a *transport* mistake, never execute an unlinked payload.
   * Rewriting the replyTo locally would approve an unproven action batch. Instead
   * request a fresh linked response only when a single new task reply follows a
   * recorded pre-send reply on the same pinned conversation. Legacy checkpoints
   * may use their persisted last-imported ID as the baseline. Ambiguity/drafts
   * stop the attempt. Correction sends use the ordinary saved budget and receipt.
   */
  private async recoverUnlinkedReply(page: ChatView, worker: Worker): Promise<boolean> {
    const receipt = parseReceipt(this.options.lastReceipt);
    if (!receipt?.expectsReplyTo || page.replyEvidence) {
      return false;
    }
    if (page.busy || page.ready === false) {
      this.unlinkedCandidate = undefined;
      return false;
    }
    if (page.draft) {
      throw new PageBridgeError('DRAFT_CONFLICT', 'Your draft is safe. Miter paused while you are writing.');
    }
    if (page.codeReplyIssue === 'NEWER_USER_MESSAGE') {
      // The direct-code lane can still see the PRIOR reply while our next report
      // is now the latest user turn. That is normal waiting, not an intervention.
      // Only a complete, exact saved receipt may take this path. Returning false
      // grants no reply authority: normal user-ID/duplicate and completion checks
      // still run, and an unrelated/truncated/unknown message still stops below.
      const prior = this.replyIdsBeforeSend(receipt);
      const onlyPriorReplies =
        page.codeReplyCount === 0 &&
        !page.unlinkedReply &&
        !!page.codeReplyIds?.length &&
        page.codeReplyIds.every((id) => prior.includes(id));
      // Once the next assistant starts streaming, the last role is no longer
      // 'user'. The only parseable code can STILL be the previous reply. An
      // exact current user receipt plus exclusively pre-send code IDs permits
      // waiting/normal parsing, not executing any of those old code blocks.
      const growingOwnedReply =
        page.lastRole === 'assistant' && onlyPriorReplies && !page.transcript?.unclassifiedTail;
      const ownLatestReport =
        !!page.transcript?.users &&
        (page.lastRole === 'user' || growingOwnedReply) &&
        !page.lastUserTruncated &&
        !!page.lastUserText &&
        (await this.matchesSavedReceipt(page.lastUserText));
      if (ownLatestReport || (onlyPriorReplies && this.waitingForSentSource(page))) {
        return false;
      }
      throw new PageBridgeError(
        'CHAT_INTERVENED',
        'A later user message is visible. Miter paused without importing or sending.',
      );
    }
    const candidate = page.unlinkedReply;
    if (!candidate) {
      return false;
    }
    // Do not interfere with an authenticated ordinary transcript, which has its
    // own completion/format-repair path and may support an older reply format.
    if (page.transcript?.users) {
      if (page.lastRole !== 'assistant' || !(await this.matchesSavedReceipt(page.lastUserText))) {
        return false;
      }
      if (page.complete && page.assistantText) {
        return false;
      }
    }
    const prior = this.replyIdsBeforeSend(receipt);
    const isNew = !prior.includes(candidate.id) && candidate.id !== this.progress?.lastImportedId;
    if (!isNew) {
      return false;
    }
    // This is only a freshness observation, not permission to execute. Keep
    // action-schema errors visible for the corrected exchange instead of
    // throwing before the bounded task-link correction can run.
    replyHeaders(candidate.text, worker.id, worker.projectId);
    const fingerprint = await messageDigest(candidate.text);
    const observation = candidate.id + ':' + fingerprint;
    if (observation !== this.unlinkedCandidate?.fingerprint) {
      this.unlinkedCandidate = { fingerprint: observation, since: this.now() };
      this.unlinkedWaitSince ??= this.now();
      this.update('waiting_reply', 'Reply received. Checking its task link…');
      return true;
    }
    if (this.now() - this.unlinkedCandidate.since < 3000) {
      return true;
    }
    const safe = await this.canCorrectUnlinkedReply(page, worker);
    if (!safe) {
      if (this.now() - (this.unlinkedWaitSince ?? this.now()) > 12000) {
        throw new PageBridgeError(
          'REPLY_LINK_MISSING',
          'A code reply is visible, but its task link cannot be verified. Use reply to review it. No actions ran and no Send was repeated.',
        );
      }
      return true;
    }
    const seen = await this.queryRpc('worker.handoffSeen', {
      workerId: worker.id,
      envelopeId: candidate.id,
    });
    this.assertCanContinue();
    if (seen.seen) {
      throw new PageBridgeError(
        'REPLY_LINK_MISSING',
        'This reply was already imported. No actions were repeated. Use reply or review the task history.',
      );
    }
    if (this.correctionAttempts >= 2) {
      throw new PageBridgeError(
        'REPLY_LINK_MISSING',
        'The visible reply still has no valid task link after two corrections. Use reply to review it. Progress is saved.',
      );
    }
    this.correctionAttempts++;
    this.dependencies.log(
      'bridge.reply.relink',
      `Requesting task-link correction ${this.correctionAttempts}/2 for one new, unimported reply. No actions from it ran.`,
    );
    const report = await this.loadReportPrompt(worker);
    this.assertCanContinue();
    await this.send(buildTaskLinkCorrection(report), page);
    if (!this.pendingSend) {
      this.update('waiting_reply', 'Waiting for the corrected task-linked reply…');
    }
    return true;
  }
  /** Shared by active and late receive paths. This grants only a bounded
   * correction request, NEVER execution of the stale envelope. A prior reply,
   * ambiguous/new user turn, draft or changed route cannot qualify. */
  private async canCorrectUnlinkedReply(page: ChatView, worker: Worker): Promise<boolean> {
    const receipt = parseReceipt(this.options.lastReceipt);
    const candidateReply = page.unlinkedReply;
    if (
      !receipt?.expectsReplyTo ||
      !receipt.exchangeId ||
      !candidateReply ||
      page.busy ||
      page.draft ||
      page.ready === false ||
      page.stopped ||
      isReplyFragment(page) ||
      page.transcript?.scanLimited ||
      page.transcript?.unclassifiedTail ||
      [
        'NEWER_USER_MESSAGE',
        'NEWER_TASK_REPLY',
        'AMBIGUOUS_REPLIES',
        'REPLY_IN_PROGRESS',
        'NEWER_REPLY_UNREADABLE',
      ].includes(page.codeReplyIssue || '')
    ) {
      return false;
    }
    const prior = this.replyIdsBeforeSend(receipt);
    if (
      prior.includes(candidateReply.id) ||
      candidateReply.id === this.progress?.lastImportedId ||
      candidateReply.replyTo === receipt.exchangeId
    ) {
      return false;
    }
    try {
      const headers = replyHeaders(candidateReply.text, worker.id, worker.projectId);
      if (headers.id !== candidateReply.id || headers.replyTo !== candidateReply.replyTo) {
        return false;
      }
    } catch {
      return false;
    }
    const route = this.progress?.conversationUrl || this.pinnedConversation || this.status.url;
    if (
      page.url !== route ||
      !route.includes('/c/') ||
      receipt.workerId !== worker.id ||
      receipt.projectId !== worker.projectId ||
      receipt.goalHash !== (await messageDigest(worker.goal))
    ) {
      return false;
    }
    const ids = page.codeReplyIds || [];
    const index = ids.indexOf(candidateReply.id);
    const fresh = ids.filter((id) => !prior.includes(id) && id !== this.progress?.lastImportedId);
    if (fresh.length !== 1 || index < 0 || !candidateReply.hasCopyControl) {
      return false;
    }
    if (page.transcript?.users) {
      return (
        page.lastRole === 'assistant' &&
        !page.lastUserTruncated &&
        !!page.lastUserText &&
        (await this.matchesSavedReceipt(page.lastUserText))
      );
    }
    return index > 0 && ids.slice(0, index).some((id) => prior.includes(id));
  }

  private async matchesSavedReceipt(text: string): Promise<boolean> {
    const receipt = parseReceipt(this.options.lastReceipt);
    const worker = this.boundWorker();
    if (
      !receipt ||
      receipt.workerId !== worker.id ||
      receipt.projectId !== worker.projectId ||
      receipt.goalHash !== (await messageDigest(worker.goal))
    ) {
      return false;
    }
    return matchesReceipt(text, receipt);
  }

  private replyIdsBeforeSend(receipt?: OutboundReceipt): string[] {
    if (receipt?.priorReplyIds) {
      return receipt.priorReplyIds;
    }
    const importedId = this.progress?.lastImportedId;
    if (importedId) {
      return [importedId];
    }
    return [];
  }

  private isPriorUser(page: ChatView): boolean {
    return (
      (!!page.lastUserId && this.priorUserIds.has(page.lastUserId)) ||
      (!!page.lastUserText && normalizeMessage(page.lastUserText) === normalizeMessage(this.previousUserText))
    );
  }

  private waitingForSentSource(page: ChatView): boolean {
    const receipt = this.options.lastReceipt;
    const exchange = receipt?.exchangeId;
    if (
      !receipt?.composerHash ||
      !receipt.expectsReplyTo ||
      !exchange ||
      page.lastUserTruncated ||
      (receipt.acknowledgedUserId && receipt.acknowledgedUserId !== page.lastUserId) ||
      page.transcript?.unclassifiedTail ||
      page.transcript?.receiptDiscovery?.state !== 'mismatch' ||
      (!page.busy && page.complete && page.codeReply?.replyTo === exchange)
    ) {
      return false;
    }
    // The wrapper is only a reason to keep waiting. Recovery still requires
    // the full saved composer hash and the corresponding completed reply.
    return [page.lastUserText, ...(page.lastUserCandidates ?? [])].some(
      (text) => unwrapMessage(text)?.exchangeId === exchange,
    );
  }

  private async confirmUserTurn(page: ChatView): Promise<boolean> {
    // A long model generation is not a failed send. Give the page its normal
    // hydration/expansion grace after generation ends; the persisted overall
    // task budget still bounds this wait. Never authorize from busy alone.
    if (page.replyEvidence) {
      if (page.draft) {
        throw new PageBridgeError(
          'DRAFT_CONFLICT',
          'Your draft is safe. Mitter paused while you are writing.',
        );
      }
      if (page.busy) {
        return false;
      }
      this.userTurnAcknowledged = true;
      return true;
    }
    if (
      this.options.lastReceipt?.expectsReplyTo &&
      (page.transcript?.users === 0 ||
        (page.transcript?.strategy === 'receipt' && page.transcript.receiptDiscovery?.state === 'collapsed'))
    ) {
      // Revealing a roleless bubble is presentation only. Until its full hash
      // matches, retain the modern code-correlation wait rather than applying
      // the legacy 45-second user-echo timeout to a still-collapsed candidate.
      if (['AMBIGUOUS_REPLIES', 'NEWER_TASK_REPLY'].includes(page.codeReplyIssue || '')) {
        throw new PageBridgeError(
          'REPLY_LINK_MISSING',
          'Several replies conflict with the pending task link. Use reply to select the intended one. Nothing was imported or resent.',
        );
      }
      if (page.draft && !this.matchesExpectedMessage(page.draftText || '')) {
        throw new PageBridgeError(
          'DRAFT_CONFLICT',
          'Your draft is safe. Mitter paused while you are writing.',
        );
      }
      if (!page.busy && this.now() - Math.max(this.sentAt, this.waitUnchangedAt) > 300000) {
        throw new PageBridgeError(
          'REPLY_LINK_MISSING',
          'The reply could not be linked automatically. Use reply to choose the existing code; no Send was repeated.',
        );
      }
      return false;
    }
    if (page.busy) {
      this.generationSeenAt = this.now();
    }
    const idleElapsed = (since: number) => this.now() - Math.max(since, this.generationSeenAt ?? since);
    const exact =
      !page.lastUserTruncated &&
      (this.matchesExpectedMessage(page.lastUserText) || (await this.matchesSavedReceipt(page.lastUserText)));
    const visible = !!page.lastUserText || !!page.lastUserId;
    const prior =
      this.isPriorUser(page) ||
      (!!this.options.lastReceipt?.priorUserHash &&
        (await messageDigest(page.lastUserText)) === this.options.lastReceipt.priorUserHash);
    const idChanged =
      !!this.expectedUserMessageId && !!page.lastUserId && page.lastUserId !== this.expectedUserMessageId;
    // Two distinct current user turns with the same text still mean a second
    // send. An optimistic -> persisted ID replacement is allowed only when the
    // old turn is gone and the complete body is identical.
    const duplicate = exact && idChanged && (page.userIds || []).includes(this.expectedUserMessageId);
    const shape = userReadShape(
      page,
      this.userTurnAcknowledged,
      exact,
      prior,
      duplicate,
      this.expectedUserText.length,
    );
    if (this.logObservation('bridge.user.observe', shape) && !exact && visible) {
      this.dependencies.log(
        'bridge.user.compare',
        await userReceiptComparison(
          page,
          parseReceipt(this.options.lastReceipt),
          this.restoringPendingSend,
          this.progress?.stage || 'legacy',
        ),
      );
    }
    if (page.draft && !this.matchesExpectedMessage(page.draftText || '')) {
      throw new PageBridgeError(
        'DRAFT_CONFLICT',
        'Your draft is safe. Automatic mode paused while you are writing.',
      );
    }
    if (exact && !duplicate) {
      if (!this.userTurnAcknowledged) {
        this.dependencies.log(
          'bridge.ack',
          'Exact outgoing user message confirmed. DOM message counts are not used as identity.',
        );
      } else if (idChanged) {
        this.dependencies.log(
          'bridge.user.rebind',
          'The page replaced a user-message ID; its full text still matches.',
        );
      }
      if (
        this.restoringPendingSend ||
        this.status.reason.startsWith('Confirming the task’s first message') ||
        this.status.reason.startsWith('Reading the full sent message')
      ) {
        let replyReason = 'Checking the existing reply…';
        if (page.busy) {
          replyReason = 'ChatGPT is working…';
        }
        this.update('waiting_reply', replyReason);
      }
      this.restoringPendingSend = false;
      this.expectedUserText = page.lastUserText;
      this.userTurnAcknowledged = true;
      this.expectedUserMessageId = page.lastUserId || this.expectedUserMessageId;
      this.conflictingUserObservation = undefined;
      this.userVisibilitySince = undefined;
      const receipt = parseReceipt(this.options.lastReceipt);
      if (receipt) {
        const hash = await messageDigest(page.lastUserText);
        if (receipt.acknowledgedHash !== hash || receipt.acknowledgedUserId !== this.expectedUserMessageId) {
          this.options.lastReceipt = {
            ...receipt,
            acknowledgedHash: hash,
            acknowledgedUserId: this.expectedUserMessageId || undefined,
          };
          await this.dependencies.saveReceipt?.(this.options.lastReceipt);
          await this.checkpoint();
        }
      }
      if (page.draft) {
        return false;
      } // Own sent draft is still clearing; do not execute yet.
      await this.confirmBootstrapDraft();
      return true;
    }
    if (page.lastUserCollapsed) {
      // The page is withholding text behind its own disclosure, not showing a
      // different human instruction. The reader expands only our known latest
      // user bubble. Until the COMPLETE receipt matches, never send or import.
      this.conflictingUserObservation = undefined;
      if (this.userVisibilitySince === undefined) {
        this.userVisibilitySince = this.now();
      }
      if (!page.busy && idleElapsed(this.userVisibilitySince) > 30000) {
        throw new PageBridgeError(
          'MESSAGE_COLLAPSED',
          'ChatGPT kept the sent message collapsed, so Mitter could not verify its full text. No message was sent again. Open chat and expand Show more, then Resume; your saved progress is unchanged.',
        );
      }
      this.update('waiting_reply', 'Reading the full sent message… Your progress is saved.');
      return false;
    }
    // Preserve the established safe-resume path when the user turn is absent:
    // only the exact, already-validated owned assistant reply adopted at startup.
    if (
      !visible &&
      this.userTurnAcknowledged &&
      this.adoptedAssistantReceipt &&
      replyFingerprint(page) === this.adoptedAssistantReceipt &&
      !page.busy &&
      page.complete
    ) {
      return true;
    }
    if (
      this.pendingConversationBind &&
      !this.userTurnAcknowledged &&
      visible &&
      !prior &&
      !page.lastUserTruncated
    ) {
      // Before the first acknowledgement there is no confirmed baseline from
      // which to infer a human edit. Wait for the exact saved message instead
      // of accusing the user or requesting another model reply. This does not
      // authorize adoption by matching IDs/markers alone.
      if (this.userVisibilitySince === undefined) {
        this.userVisibilitySince = this.now();
      }
      if (!page.busy && (idleElapsed(this.sentAt) > 45000 || idleElapsed(this.userVisibilitySince) > 45000)) {
        throw new PageBridgeError(
          'FIRST_SEND_UNCONFIRMED',
          'Mitter could not verify the first task message on the page. No send was repeated and no reply was imported. Resume checks the same chat; Copy diagnostics shows the comparison.',
        );
      }
      this.update('waiting_reply', 'Confirming the task’s first message… Nothing will be sent twice.');
      return false;
    }
    if (!visible || prior || page.lastUserTruncated) {
      // Virtualization, hydration and truncation are lack of evidence, not a
      // foreign message. Wait read-only; never click Send again or import a reply.
      this.conflictingUserObservation = undefined;
      if (this.userVisibilitySince === undefined) {
        this.userVisibilitySince = this.now();
      }
      if (
        !page.busy &&
        ((!this.userTurnAcknowledged && idleElapsed(this.sentAt) > 45000) ||
          idleElapsed(this.userVisibilitySince) > 45000)
      ) {
        throw new PageBridgeError(
          'USER_TURN_UNCONFIRMED',
          'The send could not be confirmed in the page. No send was repeated. Resume rechecks the existing conversation.',
        );
      }
      return false;
    }
    if (this.waitingForSentSource(page)) {
      this.conflictingUserObservation = undefined;
      this.userVisibilitySince ??= this.now();
      if (!page.busy && idleElapsed(this.userVisibilitySince) > 120000) {
        throw new PageBridgeError(
          'SAVED_SEND_MISMATCH',
          'Miter could not verify ChatGPT’s displayed copy of the sent message. Resume to recheck the same chat.',
        );
      }
      this.update('waiting_reply', 'Waiting for ChatGPT to finish so Miter can verify the sent message.');
      return false;
    }
    // A partially hydrated bubble must be observed unchanged twice before it is
    // called an intervention. Nothing executes during this bounded grace period.
    const observation = (page.lastUserId || '') + '\n' + page.lastUserText;
    if (observation !== this.conflictingUserObservation?.fingerprint) {
      this.conflictingUserObservation = { fingerprint: observation, since: this.now() };
      return false;
    }
    if (this.now() - this.conflictingUserObservation.since < 1800) {
      return false;
    }
    // On a legacy Resume, a stable hash mismatch alone does not prove that the
    // user changed anything. Keep the same task/chat, but report missing proof
    // honestly rather than blaming an edit. Do not bypass the check or resend.
    if (this.restoringPendingSend) {
      throw new PageBridgeError(
        'SAVED_SEND_MISMATCH',
        'Mitter could not match this older chat message to its saved send. Nothing was resent or replayed. Your task and files are preserved; Copy diagnostics shows the comparison.',
      );
    }
    throw new PageBridgeError(
      'CHAT_INTERVENED',
      'The latest chat message no longer matches Mitter’s confirmed exchange. Automatic mode paused. Your files are preserved.',
    );
  }

  private recover(error: unknown, phase: string): boolean {
    if (
      !this.status.active ||
      !(error instanceof PageBridgeError) ||
      !error.transient ||
      phase === 'sending'
    ) {
      return false;
    }
    if (['TAB_FROZEN', 'TAB_DISCARDED'].includes(error.code)) {
      if (phase !== 'reconnecting') {
        this.recoveryPhase = phase;
      }
      this.update(
        'reconnecting',
        'Chrome suspended this chat. Waiting for the document to resume; nothing is being resent.',
      );
      return true;
    }
    if (this.reconnectSince === undefined) {
      this.reconnectSince = this.now();
      if (phase !== 'reconnecting') {
        this.recoveryPhase = phase;
      }
    }
    const savedReport =
      this.progress?.stage === 'report_due' && ['running', 'waiting_approval'].includes(this.recoveryPhase);
    let reconnectLimitMs = 30000;
    let reconnectStartedAt = this.reconnectSince;
    if (this.recoveryPhase === 'connecting') {
      reconnectLimitMs = 60000;
      reconnectStartedAt = this.resumedAt;
    }
    if (savedReport) {
      reconnectLimitMs = 300000;
    }
    if (this.now() - reconnectStartedAt >= reconnectLimitMs) {
      return false;
    }
    if (savedReport) {
      this.update(
        'reconnecting',
        'Local batch saved. Reconnecting to send its report; no files or prompts are being repeated.',
      );
      return true;
    }
    let reconnectReason = 'Reconnecting to the chat… Your progress is saved.';
    if (error.code === 'TRANSCRIPT_LOADING') {
      reconnectReason = 'Reading the chat messages… Nothing is being sent again.';
    }
    this.update('reconnecting', reconnectReason);
    return true;
  }

  private recoveryWorkerReady(worker: Worker | undefined): boolean {
    return (
      !!worker &&
      this.ownsWorker(worker) &&
      ['idle', 'review'].includes(worker.state) &&
      worker.queue.length === 0 &&
      !worker.pending &&
      !worker.humanAcceptanceReady &&
      (worker.control?.epoch ?? 0) === this.executionEpoch &&
      worker.control?.mode !== 'stopped'
    );
  }

  private async canRecoverUnreadableReply(page: ChatView): Promise<boolean> {
    const receipt = parseReceipt(this.options.lastReceipt);
    const observation = page.replyRecovery;
    const route = this.progress?.conversationUrl || this.pinnedConversation || this.status.url;
    if (
      !receipt?.expectsReplyTo ||
      !receipt.exchangeId ||
      !observation ||
      observation.exchangeId !== receipt.exchangeId ||
      !observation.responseText.trim() ||
      this.progress?.stage !== 'waiting_reply' ||
      this.pendingDelivery ||
      this.pendingSend ||
      page.url !== route ||
      this.status.url !== route ||
      !route.includes('/c/') ||
      page.stopped ||
      page.busy ||
      page.draft ||
      page.ready === false ||
      page.transcript?.scanLimited
    ) {
      return false;
    }
    if (!(await this.matchesSavedReceipt(observation.userText))) {
      return false;
    }
    if (
      observation.issue === 'PROJECT_ID_TYPO' &&
      (this.correctionAttempts !== 0 ||
        !mistypedProjectHeaders(page, receipt) ||
        observation.responseText !== page.assistantText)
    ) {
      return false;
    }
    // A complete contradictory user turn wins over fallback discovery. The
    // reader must never turn a stale adjacent carrier into permission to send.
    return (
      !page.lastUserText || (!page.lastUserTruncated && (await this.matchesSavedReceipt(page.lastUserText)))
    );
  }

  /** Retire an unreadable/ambiguous exchange, not its source text. A fresh
   * nonce and current host report let the model continue without selecting a
   * duplicate reply, guessing JSON characters or replaying accepted actions. */
  private async recoverUnreadableReply(page: ChatView, worker: Worker): Promise<boolean> {
    if (!(await this.canRecoverUnreadableReply(page))) {
      this.recoveryCandidate = undefined;
      return false;
    }
    const observation = page.replyRecovery;
    if (!observation) {
      return false;
    }
    const fingerprint = await messageDigest(JSON.stringify(observation));
    this.assertCanContinue();
    if (fingerprint !== this.recoveryCandidate?.fingerprint) {
      this.recoveryCandidate = { fingerprint, since: this.now() };
      this.update('waiting_reply', 'Checking the reply before requesting an automatic correction…');
      return true;
    }
    // Missing Stop controls must not turn a still-streaming source string into
    // a correction. Fragments get the same two-minute quiet period as gaps.
    let quietMs = 15000;
    if (isReplyFragment(page) || isIncompleteReplyJSON(observation.responseText)) {
      quietMs = REPLY_GAP_IDLE_MS;
    }
    if (this.now() - this.recoveryCandidate.since < quietMs) {
      return true;
    }
    const snapshot = await this.queryRpc('state', {});
    this.assertCanContinue();
    const current = snapshot.workers.find(
      (item) => item.id === worker.id && item.projectId === worker.projectId,
    );
    if (!this.recoveryWorkerReady(current)) {
      this.recoveryCandidate = undefined;
      return true;
    }
    if (observation.issue === 'PROJECT_ID_TYPO') {
      const receipt = this.options.lastReceipt;
      const typo = receipt && mistypedProjectHeaders(page, receipt);
      if (
        !typo ||
        this.correctionAttempts !== 0 ||
        snapshot.projects.some((item) => item.id === typo.projectId) ||
        (await this.queryRpc('worker.handoffSeen', { workerId: worker.id, envelopeId: typo.id })).seen
      ) {
        throw new PageBridgeError(
          'REPLY_LINK_MISSING',
          'The reply addresses a different project. Nothing was imported or resent.',
        );
      }
      this.assertCanContinue();
    }
    const report = await this.loadReportPrompt(worker);
    this.assertCanContinue();
    // Report loading can race a native import or completion. Re-query the host
    // instead of depending only on its asynchronously published UI snapshot.
    const refreshed = await this.queryRpc('state', {});
    this.assertCanContinue();
    if (
      !this.recoveryWorkerReady(refreshed.workers.find((item) => item.id === worker.id)) ||
      !this.recoveryWorkerReady(this.boundWorker())
    ) {
      this.recoveryCandidate = undefined;
      return true;
    }
    const fresh = await this.requestPage('inspect');
    this.assertCanContinue();
    if (
      !(await this.canRecoverUnreadableReply(fresh)) ||
      (await messageDigest(JSON.stringify(fresh.replyRecovery))) !== fingerprint
    ) {
      this.recoveryCandidate = undefined;
      return true;
    }
    this.assertCanContinue();
    if (!this.recoveryWorkerReady(this.boundWorker())) {
      this.recoveryCandidate = undefined;
      return true;
    }
    if (this.correctionAttempts >= 2) {
      throw new PageBridgeError(
        'REPLY_RECOVERY_EXHAUSTED',
        'The chat still has no usable reply after two automatic recovery requests. Progress is saved; Miter stopped sending corrections.',
      );
    }
    this.correctionAttempts++;
    await this.checkpoint();
    this.assertCanContinue();
    if (!this.recoveryWorkerReady(this.boundWorker())) {
      this.recoveryCandidate = undefined;
      return true;
    }
    this.dependencies.log(
      'bridge.reply.recovery',
      `Verified the current receipt and response twice. Retiring the ${observation.kind} exchange and requesting a fresh reply (${this.correctionAttempts}/2). No rejected actions ran.`,
    );
    let prompt = buildReplyRecoveryPrompt(report, observation.kind === 'duplicate_send');
    if (observation.issue === 'PROJECT_ID_TYPO') {
      prompt +=
        '\nThe previous projectId did not match. Copy the workerId and projectId exactly from the current contract.';
    }
    await this.send(prompt, fresh);
    return true;
  }

  /** A sent prompt and an absent response are different from an uncertain
   * Send. Ask once for a fresh answer only after two idle minutes, a full exact
   * user receipt, an empty response tail and a second live check. The existing
   * durable repair budget caps this at two per accepted batch, even on restart.
   * Never click the provider's Retry, replay the original send or cached JSON. */
  private async recoverAbsentReply(page: ChatView, worker: Worker): Promise<boolean> {
    const receipt = parseReceipt(this.options.lastReceipt);
    if (!receipt?.expectsReplyTo || !receipt.exchangeId || this.progress?.stage !== 'waiting_reply') {
      return false;
    }
    const prior = this.replyIdsBeforeSend(receipt);
    this.gapObservation = this.replyGap.observe(page, receipt.exchangeId, prior, this.now());
    const gap = this.gapObservation;
    if (!gap.missing) {
      this.gapLogged = '';
      return false;
    }
    if (gap.started && this.gapLogged !== receipt.exchangeId) {
      this.gapLogged = receipt.exchangeId;
      this.dependencies.log(
        'bridge.reply.gap',
        'The current response was observed, then its readable content disappeared. Retaining the pending exchange; no partial or cached reply will be applied.',
      );
    }
    if (
      gap.elapsedMs < REPLY_GAP_IDLE_MS ||
      !hasEmptyResponseTail(page) ||
      !(await this.matchesSavedReceipt(page.lastUserText))
    ) {
      return false;
    }
    const route = this.progress.conversationUrl || this.status.url;
    if (
      page.url !== route ||
      !route.includes('/c/') ||
      this.pendingConversationBind ||
      this.pendingDelivery ||
      this.pendingSend
    ) {
      return false;
    }
    const snapshot = await this.queryRpc('state', {});
    this.assertCanContinue();
    const current = snapshot.workers.find(
      (item) => item.id === worker.id && item.projectId === worker.projectId,
    );
    if (
      !current ||
      current.mode !== 'handoff' ||
      !['idle', 'review'].includes(current.state) ||
      current.queue.length ||
      current.pending ||
      current.humanAcceptanceReady ||
      (current.control?.epoch ?? 0) !== this.executionEpoch ||
      current.control?.mode === 'stopped'
    ) {
      return false;
    }
    // The DOM may have recovered, a draft may have been entered or Pause may
    // have been clicked while the native check was in flight. No stale snapshot
    // can authorize even a recovery message. Defer to the next ordinary tick.
    const fresh = await this.requestPage('inspect');
    this.assertCanContinue();
    if (
      this.options.lastReceipt?.exchangeId !== receipt.exchangeId ||
      fresh.url !== route ||
      !hasEmptyResponseTail(fresh) ||
      !(await this.matchesSavedReceipt(fresh.lastUserText))
    ) {
      return true;
    }
    if (this.correctionAttempts >= 2) {
      throw new PageBridgeError(
        'REPLY_RECOVERY_EXHAUSTED',
        'ChatGPT has not supplied a readable response after two recovery requests. No missing reply was executed. Check the linked chat; Miter will not keep sending messages.',
      );
    }
    this.correctionAttempts++;
    await this.checkpoint();
    this.assertCanContinue();
    this.dependencies.log(
      'bridge.reply.recovery',
      `Verified the exact sent message and empty response tail twice. Requesting a fresh response (${this.correctionAttempts}/2); no prior batch or Send is replayed.`,
    );
    await this.send(buildMissingResponsePrompt(this.nextStepPrompt), fresh);
    return true;
  }
  /** Bounded no-progress guard. A completed-but-unusable code widget must not
   * disappear into a generic model wait. This never grants import permission. */
  private observeReplyWait(page: ChatView): boolean {
    // Empty, confirmed ordinary exchanges need a no-progress guard too.
    // Before confirmation, keep the more specific receipt/identity diagnosis;
    // a missing sent-message proof is not a model response-format failure.
    const prior = this.replyIdsBeforeSend(this.options.lastReceipt);
    const history = isHistoricalReply(page, prior);
    const fragment = isReplyFragment(page);
    const codeLane = page.codeRead || page.codeReplyIssue || page.codeReply || page.unlinkedReply;
    if (!codeLane && page.assistantText && !history) {
      return false;
    }
    if (page.busy || page.ready === false) {
      this.waitUnchangedAt = this.now();
      this.waitObservation = '';
      return history;
    }
    // Historical blocks do not reset the current reply's idle deadline, and do
    // not supply its error reason. A fresh fragment does reset that deadline.
    let observation = 'history';
    if (!history) {
      observation = JSON.stringify([
        page.assistantId,
        page.assistantText,
        page.complete,
        page.codeReply?.id,
        page.codeReply?.text.length,
        page.codeReplyIssue,
        page.codeReplyIds,
        page.codeRead?.fingerprint,
        page.codeRead?.issue,
      ]);
    }
    if (observation !== this.waitObservation) {
      this.waitObservation = observation;
      this.waitUnchangedAt = this.now();
      if (fragment) {
        this.generationSeenAt = this.now();
      }
    }
    if (!codeLane && !this.userTurnAcknowledged) {
      return history;
    }
    const visible =
      !history &&
      (!!page.codeReply || !!page.unlinkedReply || !!page.assistantText || !!page.codeRead?.characters);
    const elapsed = this.now() - this.waitUnchangedAt;
    let idleLimitMs = 120000;
    if (visible && !fragment) {
      idleLimitMs = 45000;
    }
    if (!page.replyEvidence && elapsed >= idleLimitMs) {
      let waitIssue = page.codeReplyIssue;
      let readerObservation = page.codeRead;
      if (history) {
        waitIssue = 'WAITING_CURRENT_REPLY';
        readerObservation = undefined;
      }
      this.dependencies.log(
        'bridge.wait.blocked',
        JSON.stringify({
          issue: waitIssue,
          read: readerObservation,
          complete: page.complete,
          busy: page.busy,
          elapsedMs: elapsed,
        }),
      );
      const explanation = replyWaitExplanation(page, fragment);
      if (!visible && this.gapObservation.started) {
        throw new PageBridgeError(
          'REPLY_DISAPPEARED',
          'The current response started, then disappeared from the readable page. No partial response was applied. Its sent-message/response boundary could not be verified for automatic recovery. Still checking the same chat.',
        );
      }
      if (visible) {
        throw new PageBridgeError(
          'REPLY_UNREADABLE',
          'A reply is visible. ' +
            explanation +
            ' Use reply to inspect it, or Stop then Continue fresh. No rejected actions ran.',
        );
      }
      throw new PageBridgeError(
        'REPLY_NOT_ADVANCING',
        'No new readable reply appeared. Progress is saved. Use reply or Stop then Continue fresh instead of waiting indefinitely.',
      );
    }
    if (history) {
      let historyReason = 'Waiting for the current reply… Earlier replies are already accounted for.';
      if (this.gapObservation.started) {
        historyReason =
          'The current reply disappeared. Checking for its return before requesting a fresh response…';
      }
      this.update('waiting_reply', historyReason);
    } else if (fragment) {
      this.update('waiting_reply', 'Receiving the current JSON reply… Waiting for it to finish.');
    } else if (visible && !page.replyEvidence && elapsed >= 8000) {
      this.update('waiting_reply', 'Reply detected. Checking its full JSON and task link…');
    }
    // Still run draft/user-turn checks in the caller before honoring this hold.
    return (
      history ||
      page.codeReplyIssue === 'REPLY_IN_PROGRESS' ||
      page.codeReplyIssue === 'NEWER_REPLY_UNREADABLE'
    );
  }
  /** Best-effort independent Pause observation. A missing page cannot hold
   * local edits hostage, but the floating page Pause control must still work.
   * At most one bounded transport request is in flight. An obsolete response
   * cannot stop a new phase or a new coordinator, and never mutates a receipt. */
  private pollLocalPause(): void {
    if (this.localPauseCheck) {
      return;
    }
    const current = () => this.status.active && ['running', 'waiting_approval'].includes(this.status.phase);
    const pause = async () => {
      if (current()) {
        await this.stop('Paused from the chat page.', 'stopped', 'STOPPED');
      }
    };
    const job = this.dependencies
      .page(this.options.tabId, {
        op: 'control',
        token: this.options.token,
        url: this.progress?.conversationUrl || this.status.url,
        expiresAt: this.now() + 15000,
      })
      .then(async (observation) => {
        const view = readPageState(observation, 'control');
        if (view.stopped) {
          await pause();
        }
      })
      .catch(async (error) => {
        if (error instanceof PageBridgeError && error.code === 'STOPPED') {
          await pause();
        }
      })
      .finally(() => {
        if (this.localPauseCheck === job) {
          this.localPauseCheck = undefined;
        }
      });
    this.localPauseCheck = job;
    // Stop itself normally resolves errors into status. Keep a final rejection
    // handler nevertheless; no background timer may create an unhandled error.
    void job.catch(() => {});
  }

  private teamPhase: string | undefined;
  async tick(): Promise<void> {
    if (this.hostReconnect) {
      await this.reconnectWaitingHost();
      return;
    }
    if (this.status.monitoring) {
      await this.watchForReply();
      return;
    }
    // The watcher becomes active before its durable resume checkpoint ends.
    // Do not overlap a normal poll with that handover or replace its idle barrier.
    if (this.operationRunning || this.lateReplyWatch.running || !this.status.active) {
      return;
    }
    this.operationRunning = true;
    this.operationIdle = new Promise((resolve) => {
      this.operationDone = resolve;
    });
    let phase = this.status.phase;
    if (phase === 'reconnecting') {
      phase = this.recoveryPhase;
    }
    try {
      // Snapshot loss and held teammates are still inside the same guarded
      // lifecycle. Neither is allowed to throw an unhandled timer rejection or
      // bypass the stopped epoch / active-time budget.
      let worker = this.boundWorker();
      const localExecution = ['running', 'waiting_approval'].includes(this.teamPhase ?? phase);
      this.assertCanContinue(!localExecution);
      if (localExecution) {
        // Only the host knows how long the user really waited, particularly when Chrome
        // suspended the tab. Read the current batch and its clock before charging time.
        const fresh = await this.queryRpc('state', {});
        const current = fresh.workers.find(
          (item) => item.id === this.options.workerId && item.projectId === this.options.projectId,
        );
        if (!current) {
          throw new Error('The task is no longer available.');
        }
        if (!this.ownsWorker(current)) {
          throw new PageBridgeError('RUN_SUPERSEDED', 'Task stopped or replaced.');
        }
        this.accountForSetupWait(current);
        this.assertCanContinue();
        worker = current;
      }
      if (worker.teamPaused) {
        this.teamPhase ??= phase;
        this.update('waiting_team', worker.teamPaused);
        return;
      }
      if (this.teamPhase) {
        phase = this.teamPhase;
        this.teamPhase = undefined;
        this.update(phase, 'Continuing after team coordination…');
      }
      if (localExecution) {
        this.pollLocalPause();
      }
      if (this.pendingDelivery) {
        await this.advanceDelivery();
        return;
      }
      if (worker.state === 'complete') {
        await this.stop(taskPresentation(worker).detail, 'complete');
        return;
      }
      if (worker.humanAcceptanceReady) {
        await this.stop('Ready for your review', 'review');
        return;
      }
      if (this.pendingSend) {
        await this.advanceSend();
        return;
      }
      if (phase === 'connecting') {
        await this.initialise();
        this.reconnectSince = undefined;
        return;
      }
      if (localExecution) {
        // The accepted batch already passed the chat authority checks. Its
        // filesystem/approval lifecycle must not depend on a hidden chat's
        // DOM, a changing code widget, or the provider being reachable.
        if (worker.state === 'awaiting_approval') {
          this.update('waiting_approval', 'A command needs your approval');
          return;
        }
        if (['blocked', 'paused', 'cancelled'].includes(worker.state)) {
          throw new Error(worker.error || `Worker ${worker.state}. Review before continuing.`);
        }
        if (worker.state !== 'review') {
          let executionReason = 'Applying the accepted batch locally…';
          if (worker.state === 'waiting_lock') {
            executionReason = 'Waiting for another local task to release these files…';
          }
          this.update('running', executionReason);
          return;
        }
        if (worker.queue.length) {
          throw new Error('Unexpected queued work. Stopped rather than mixing batches.');
        }
        await this.checkpoint('report_due');
        // Preserve the existing visible phase and durable stage, but recovery
        // now knows local files are saved and only the report remains to send.
      }
      const page = await this.requestPage('inspect');
      this.assertCanContinue();

      // Roleless reads can return during user confirmation. An interrupted read
      // must end reply stability before any of those exits, not the overall wait.
      if (
        phase === 'waiting_reply' &&
        (page.busy ||
          !page.complete ||
          isReplyFragment(page) ||
          ['REPLY_IN_PROGRESS', 'NEWER_REPLY_UNREADABLE'].includes(page.codeReplyIssue || ''))
      ) {
        this.replyCandidate = undefined;
      }

      if (this.status.phase === 'reconnecting') {
        let recoveredReason = 'Waiting for ChatGPT…';
        if (phase === 'running') {
          recoveredReason = 'Working on your project…';
        }
        this.update(phase, recoveredReason);
      }
      this.reconnectSince = undefined;
      if (page.ready === false) {
        throw new PageBridgeError('PAGE_LOADING', 'The chat is reloading.', true);
      }
      // React may clear its composer after the click response has returned.
      // The exact saved outgoing draft is not evidence of a human intervention.
      // Wait read-only; never run a correction or import while it is present.
      if (
        phase === 'waiting_reply' &&
        page.draft &&
        (this.matchesExpectedMessage(page.draftText) || (await this.matchesSavedReceipt(page.draftText)))
      ) {
        if (!page.busy && this.now() - this.sentAt > 45000) {
          throw new PageBridgeError(
            'SEND_UNCERTAIN_DRAFT',
            'The prepared prompt is still in ChatGPT’s input. Send was requested but not confirmed; watching for it to clear without a duplicate click.',
          );
        }
        this.update(
          'waiting_reply',
          'Waiting for ChatGPT to clear the submitted prompt… Nothing is being sent twice.',
        );
        return;
      }
      if (phase === 'waiting_reply' && (await this.continueImageReply(page, worker))) {
        return;
      }
      if (phase === 'waiting_reply' && this.options.lastReceipt?.imageMode) {
        const ownedImageTurn = await this.confirmUserTurn(page);
        if (page.busy || !page.complete || page.lastRole !== 'assistant' || !ownedImageTurn) {
          this.unreadableSince = undefined;
        } else {
          this.unreadableSince ??= this.now();
          if (this.now() - this.unreadableSince > 30000) {
            throw new PageBridgeError(
              'GENERATED_IMAGE_UNAVAILABLE',
              'ChatGPT finished without an image Miter could save. Open the linked chat to check the result.',
            );
          }
        }
        this.update('waiting_reply', 'Waiting for ChatGPT’s generated image…');
        return;
      }
      if (phase === 'waiting_reply' && (await this.recoverUnreadableReply(page, worker))) {
        return;
      }
      if (phase === 'waiting_reply' && (await this.recoverUnlinkedReply(page, worker))) {
        return;
      }
      if (phase === 'waiting_reply' && (await this.recoverAbsentReply(page, worker))) {
        return;
      }
      const holdReply = phase === 'waiting_reply' && this.observeReplyWait(page);
      if ((this.expectedUserText || this.restoringPendingSend) && !(await this.confirmUserTurn(page))) {
        return;
      }
      if (holdReply) {
        this.replyCandidate = undefined;
        return;
      }
      if (this.pendingConversationBind && page.url !== this.status.url) {
        return;
      }
      if (page.draft && (localExecution || this.userTurnAcknowledged)) {
        throw new PageBridgeError(
          'DRAFT_CONFLICT',
          'You started a draft. Automatic mode paused and left it untouched.',
        );
      }
      if (localExecution) {
        if (page.busy) {
          this.update('running', 'Local batch saved. Waiting for ChatGPT to be ready for its report…');
          return;
        }
        await this.send(await this.loadReportPrompt(worker), page);
        return;
      }
      if (phase !== 'waiting_reply') {
        return;
      }
      // A thinking model can take longer than the old fixed three-minute limit.
      // Keep waiting while generation is visible, bounded by the session budget.
      if (this.now() - this.sentAt > 300000 && !page.busy && !page.complete) {
        throw new PageBridgeError(
          'REPLY_NOT_ADVANCING',
          'ChatGPT has not returned a reply. Open the linked chat to check it.',
        );
      }
      if (
        (page.count <= this.messageCountBeforeSend &&
          page.assistantId === this.previousAssistantId &&
          page.assistantText === this.previousAssistantText) ||
        page.lastRole !== 'assistant' ||
        page.busy ||
        !page.complete
      ) {
        this.replyCandidate = undefined;
        return;
      }
      const candidate = replyFingerprint(page);
      const receipt = parseReceipt(this.options.lastReceipt);
      if (receipt?.priorAssistantHash && (await messageDigest(candidate)) === receipt.priorAssistantHash) {
        this.replyCandidate = undefined;
        return;
      }
      if (candidate !== this.replyCandidate?.fingerprint) {
        this.replyCandidate = { fingerprint: candidate, since: this.now() };
        return;
      }
      if (this.now() - this.replyCandidate.since < 1800) {
        return;
      }
      if (this.pendingConversationBind && !this.status.url.includes('/c/')) {
        if (this.now() - this.sentAt > 60000) {
          throw new PageBridgeError(
            'CHAT_BIND_TIMEOUT',
            'ChatGPT has not supplied this task’s conversation link. The reply was not executed.',
          );
        }
        this.update('waiting_reply', 'Waiting for the conversation to be saved…');
        return;
      }
      let envelope: ProposalEnvelope;
      try {
        envelope = this.parseObservedReply(page);
      } catch (error) {
        // A code widget can stream without a detectable Stop button. Never
        // interrupt an open file-content string just because the DOM stayed
        // unchanged for the normal 1.8-second complete-reply stability check.
        // No source is reconstructed; after 15 quiet seconds the existing
        // bounded correction path handles a genuinely truncated reply.
        if (isIncompleteReplyJSON(page.assistantText) && this.now() - this.replyCandidate.since < 15000) {
          this.update('waiting_reply', 'Receiving the file changes… Waiting for the complete JSON reply.');
          return;
        }
        await this.repairReply(worker, page, error);
        return;
      }
      await this.importEnvelope(envelope, worker, page);
    } catch (error) {
      // A rejected or failed read breaks continuous completion evidence, even
      // when transient recovery keeps the same send and overall wait alive.
      if (phase === 'waiting_reply') {
        this.replyCandidate = undefined;
        this.recoveryCandidate = undefined;
      }
      if (this.status.active && !this.recover(error, phase)) {
        await this.stop(errorMessage(error), 'error', bridgeErrorCode(error));
      }
    } finally {
      if (this.status.active) {
        try {
          await this.checkpoint(undefined, false);
        } catch (error) {
          await this.stop(errorMessage(error), 'error', bridgeErrorCode(error));
        }
      }
      this.operationRunning = false;
      this.operationDone?.();
    }
  }
  /** Inspect only the recorded task tab. No send/import happens in this method. */
  private async watchView(): Promise<ChatView> {
    const route = this.progress?.conversationUrl || this.status.url;
    const observation = await this.dependencies.page(this.options.tabId, {
      op: 'inspect',
      token: this.options.token,
      url: route,
      expiresAt: this.now() + 15000,
      allowConversationBind: this.pendingConversationBind && !route.includes('/c/'),
      workerId: this.options.workerId,
      projectId: this.options.projectId,
      receipt: parseReceipt(this.options.lastReceipt),
      replyTo: this.options.lastReceipt?.exchangeId,
    });
    return readPageState(observation, 'inspect');
  }

  private async watchCandidate(
    view: ChatView,
  ): Promise<{ text?: string; reason: ReaderDiagnostic['reason'] }> {
    const receipt = this.options.lastReceipt;
    if (!receipt?.expectsReplyTo || !receipt.exchangeId || view.stopped) {
      return { reason: 'awaiting_receipt' };
    }
    if (view.busy) {
      return { reason: 'busy' };
    }
    if (view.draft) {
      return { reason: 'draft' };
    }
    if (view.ready === false) {
      return { reason: 'not_ready' };
    }
    if (view.transcript?.scanLimited) {
      return { reason: 'scan_limit' };
    }
    if (view.transcript?.unclassifiedTail) {
      return { reason: 'unclassified_tail' };
    }
    const route = this.progress?.conversationUrl || this.status.url;
    if (route.includes('/c/') && view.url !== route) {
      return { reason: 'different_conversation' };
    }
    try {
      conversationURL(view.url);
    } catch {
      return { reason: 'different_conversation' };
    }
    if ((view.codeReplyCount ?? 0) > 1 || view.codeReplyIssue === 'AMBIGUOUS_REPLIES') {
      return { reason: 'ambiguous_reply' };
    }
    if (['NEWER_USER_MESSAGE', 'NEWER_TASK_REPLY'].includes(view.codeReplyIssue || '')) {
      return { reason: 'newer_message' };
    }
    // Reuse the normal read-only authority checks. A collapsed/virtualized
    // sent bubble must not make late recovery stricter than the active reader,
    // but a complete contradictory user turn still blocks both paths.
    delete view.replyEvidence;
    await this.normalizeUserEcho(view);
    if (
      view.lastUserText &&
      !view.lastUserCollapsed &&
      !view.lastUserTruncated &&
      !(await this.matchesSavedReceipt(view.lastUserText))
    ) {
      return { reason: 'receipt_mismatch' };
    }
    await this.selectDirectReply(view);
    let raw = '';
    if (view.replyEvidence) {
      raw = view.assistantText;
    } else if (view.complete && !view.assistantReadIssue) {
      raw = view.assistantText;
    }
    if (!raw || !view.complete) {
      return { reason: 'incomplete_reply' };
    }
    let failure: ReaderDiagnostic['reason'] = 'invalid_reply';
    try {
      const envelope = boundReply(raw, this.options.workerId, this.options.projectId);
      if (view.assistantFormat === 'plain' && !isReadOnlyReply(envelope)) {
        return { reason: 'invalid_reply' };
      }
      if (envelope.replyTo !== receipt.exchangeId || envelope.id === this.progress?.lastImportedId) {
        return { reason: 'wrong_exchange' };
      }
      if (envelope.actions.some((action) => 'path' in action)) {
        failure = 'validation_rejected';
        const admission = await this.queryRpc('worker.validateReply', {
          workerId: this.options.workerId,
          text: JSON.stringify(envelope),
          epoch: this.executionEpoch,
        });
        if (admission.valid !== true) {
          return { reason: 'validation_rejected' };
        }
      }
      if (
        !view.replyEvidence &&
        view.lastUserText &&
        (view.lastUserTruncated || !(await this.matchesSavedReceipt(view.lastUserText)))
      ) {
        return { reason: 'receipt_mismatch' };
      }
      return { reason: 'verifying_reply', text: raw };
    } catch {
      return { reason: failure };
    }
  }

  private async recordWatchDiagnostic(view: ChatView, reason: ReaderDiagnostic['reason']): Promise<void> {
    if (!this.status.monitoring) {
      return;
    }
    const detail = readerDiagnostic(view, reason);
    if (JSON.stringify(this.progress?.readerDiagnostic) === JSON.stringify(detail)) {
      return;
    }
    this.readerDiagnostic = detail;
    this.logObservation('bridge.watch.reader', JSON.stringify(detail));
    // The observation accompanies the existing watch. Its write cannot change
    // the watch deadline, grant authority, or turn a reporting failure into Stop.
    try {
      await this.checkpoint();
    } catch {
      this.logObservation('bridge.watch.diagnostics', 'Could not save the latest reader diagnostic.');
    }
  }

  private resumeWatchClock(): void {
    if (!this.status.monitoring) {
      throw Error('Reply monitoring was stopped.');
    }
    if (!this.progress) {
      throw Error('Saved task progress is unavailable.');
    }
    const worker = this.boundWorker();
    if ((worker.control?.epoch ?? 0) !== this.executionEpoch || worker.control?.mode === 'stopped') {
      throw new PageBridgeError('RUN_SUPERSEDED', 'Task stopped or replaced.');
    }
    const used = Math.max(this.progress.activeMs, this.status.activeMs || 0);
    if (used >= this.progress.maxMinutes * 60000) {
      throw new PageBridgeError(
        'TIME_LIMIT',
        'The active-time budget is exhausted. Add time before continuing.',
      );
    }
    this.activeMillisecondsBeforeResume = used;
    this.resumedAt = this.now();
    this.lastHostSetupWaitMs = worker.setupWaitMs ?? 0;
    this.excludedSetupWaitMs = 0;
    this.activeTimeStoppedAt = undefined;
    this.activeTimeDeadline = this.now() + this.progress.maxMinutes * 60000 - used;
    this.status.monitoring = false;
    delete this.status.receiving;
    delete this.status.watchUntil;
    this.readerDiagnostic = undefined;
    this.status.active = true;
    this.status.errorCode = undefined;
    this.reconnectSince = undefined;
    this.waitObservation = '';
    this.waitUnchangedAt = this.now();
    this.userVisibilitySince = undefined;
    this.unlinkedCandidate = undefined;
    this.unlinkedWaitSince = undefined;
  }

  private publishWatchStatus(): void {
    if (this.status.errorCode === 'TRANSCRIPT_UNSUPPORTED') {
      this.update(
        'waiting_reply',
        'Checking the chat for a complete reply. Miter will continue automatically when it arrives.',
      );
      return;
    }
    this.update('error', this.lateReplyWatch.reason);
  }

  private async watchForReply(): Promise<void> {
    if (this.operationRunning || this.lateReplyWatch.running) {
      return;
    }
    if (this.now() >= (this.status.watchUntil || 0)) {
      await this.stop(
        `The ${LATE_REPLY_WATCH_MS / 60000}-minute reply watch ended. Use Resume to check again.`,
        'stopped',
      );
      return;
    }
    if (!this.lateReplyWatch.canPoll(this.now())) {
      return;
    }
    this.lateReplyWatch.beginPoll(this.now());
    this.operationIdle = new Promise((resolve) => {
      this.operationDone = resolve;
    });
    const pollDone = this.operationDone;
    try {
      const worker = this.boundWorker();
      if (worker.control?.mode === 'stopped' || (worker.control?.epoch ?? 0) !== this.executionEpoch) {
        await this.stop('This execution plan was stopped or replaced.');
        return;
      }
      if (worker.state === 'complete') {
        await this.stop('Task complete.', 'complete');
        return;
      }
      const view = await this.watchView();
      if (!this.status.monitoring) {
        return;
      }
      if (this.now() >= (this.status.watchUntil || 0)) {
        await this.stop(
          `The ${LATE_REPLY_WATCH_MS / 60000}-minute reply watch ended. Use Resume to check again.`,
          'stopped',
        );
        return;
      }
      if (this.lateReplyWatch.readSucceeded()) {
        this.dependencies.log(
          'bridge.watch.reconnected',
          'The reply reader is responding again. No prompt was resent.',
        );
        this.publishWatchStatus();
      }
      if (view.stopped) {
        await this.stop('Paused from the chat page.');
        return;
      }
      const route = this.progress?.conversationUrl || this.status.url;
      if (route.includes('/c/') && view.url !== route) {
        await this.stop(
          'The linked tab left this task’s conversation. Resume returns to its saved chat.',
          'stopped',
          'NAVIGATED',
        );
        return;
      }
      if (!view.draft && (view.busy || isReplyFragment(view))) {
        this.lateReplyWatch.clearCandidate();
        this.status.receiving = true;
        let receivingReason =
          'Receiving a new JSON reply. Miter is waiting for a complete, verified answer; nothing is being resent.';
        if (view.busy) {
          receivingReason =
            'ChatGPT is generating a reply. Miter will verify its task link before continuing; nothing is being resent.';
        }
        this.update('waiting_reply', receivingReason);
        let reason: ReaderDiagnostic['reason'] = 'incomplete_reply';
        if (view.busy) {
          reason = 'busy';
        }
        await this.recordWatchDiagnostic(view, reason);
        return;
      }
      const { text, reason } = await this.watchCandidate(view);
      await this.recordWatchDiagnostic(view, reason);
      if (!this.status.monitoring) {
        return;
      }
      const correction =
        !text && this.correctionAttempts < 2 && (await this.canCorrectUnlinkedReply(view, worker));
      if (!this.status.monitoring) {
        return;
      }
      if (!text && !correction) {
        if (this.status.receiving) {
          delete this.status.receiving;
          this.publishWatchStatus();
        }
        this.lateReplyWatch.clearCandidate();
        return;
      }
      let candidateText = text;
      if (!candidateText) {
        const unlinkedReply = view.unlinkedReply;
        if (!unlinkedReply) {
          this.lateReplyWatch.clearCandidate();
          return;
        }
        candidateText = unlinkedReply.text;
      }
      let candidateKind = 'reply:';
      if (correction) {
        candidateKind = 'correction:';
      }
      const fingerprint = candidateKind + (await messageDigest(candidateText));
      if (!this.status.monitoring) {
        return;
      }
      if (!this.lateReplyWatch.isStable(fingerprint, this.now(), correction)) {
        return;
      }
      if (this.now() >= (this.status.watchUntil || 0)) {
        await this.stop(
          `The ${LATE_REPLY_WATCH_MS / 60000}-minute reply watch ended. Use Resume to check again.`,
          'stopped',
        );
        return;
      }
      // Resume the SAME coordinator; it runs its ordinary receipt/schema/hash/
      // duplicate checks on the next tick. The watch never imports directly.
      // An explicit recovery may be waiting for this read. Let it inspect the
      // result before deciding whether the reviewed prompt still needs sending.
      if (this.operationRunning) {
        return;
      }
      this.resumeWatchClock();
      const exactEcho = view.lastUserText && (await this.matchesSavedReceipt(view.lastUserText));
      this.assertCanContinue();
      if (exactEcho) {
        this.expectedUserText = view.lastUserText;
        this.expectedUserMessageId = view.lastUserId || '';
        this.userTurnAcknowledged = true;
      }
      this.sentAt = this.now();
      this.replyCandidate = undefined;
      this.update('waiting_reply', 'Reply received. Checking it before continuing…');
      let recoveryReason =
        'A stable task-linked reply appeared. Re-entering normal validation without resending the prompt.';
      if (correction) {
        recoveryReason =
          'A fresh unimported reply needs a task-link correction. Re-entering the same bounded correction path; the stale actions are not authorized.';
      }
      this.dependencies.log('bridge.attention.resolved', recoveryReason);
      await this.checkpoint();
    } catch (error) {
      if (this.status.active) {
        await this.stop(errorMessage(error), 'error', bridgeErrorCode(error));
        return;
      }
      if (!this.status.monitoring) {
        return;
      }
      if (
        error instanceof PageBridgeError &&
        ['STOPPED', 'NAVIGATED', 'RUN_SUPERSEDED', 'TIME_LIMIT', 'PROGRESS_SAVE_FAILED'].includes(error.code)
      ) {
        await this.stop(errorMessage(error), 'stopped', error.code);
        return;
      }
      // Missing observations break reply stability. Back off only reads, not
      // the saved absolute deadline, and surface the actual recovery state.
      delete this.status.receiving;
      const errorCode = bridgeErrorCode(error) || 'PAGE_READ_FAILED';
      if (this.lateReplyWatch.readFailed(errorCode, this.now())) {
        this.dependencies.log('bridge.watch.retry', errorCode + ': ' + errorMessage(error));
        this.update(
          'error',
          'The chat reader is not responding. Rechecking this same chat automatically; nothing is being resent. Open chat to check its connection, or Stop to end the watch.',
        );
      }
    } finally {
      this.lateReplyWatch.finishPoll();
      pollDone?.();
    }
  }

  async recoveryPrompt(): Promise<string> {
    if (!this.status.monitoring) {
      throw Error('This task is not waiting for a missing reply.');
    }
    const expectedText = this.expectedUserText;
    if (expectedText && (await this.matchesSavedReceipt(expectedText))) {
      return expectedText;
    }
    const view = await this.watchView();
    const observedText = view.lastUserText;
    if (observedText && !view.lastUserTruncated && (await this.matchesSavedReceipt(observedText))) {
      return observedText;
    }
    throw Error(
      'The exact sent text is not available locally. Open the chat and copy its last Miter message. Nothing was reconstructed.',
    );
  }

  async resendPrompt(confirm: boolean, expectedPrompt: string): Promise<BridgeResendResult> {
    if (confirm !== true || !this.status.monitoring || this.operationRunning) {
      throw Error('Resend is only available after your confirmation while waiting for a reply.');
    }
    if (typeof expectedPrompt !== 'string') {
      throw new PageBridgeError(
        'RESEND_MISMATCH',
        'Review the exact pending prompt before resending. Nothing was resent.',
      );
    }
    let pendingInspection: Promise<void> | undefined;
    if (this.lateReplyWatch.running) {
      pendingInspection = this.operationIdle;
    }
    // Reserve recovery before waiting so another poll or confirmation cannot
    // overtake it. The read keeps its own completion callback and cannot release
    // this operation's idle barrier.
    this.operationRunning = true;
    this.operationIdle = new Promise((resolve) => {
      this.operationDone = resolve;
    });
    try {
      await pendingInspection;
      this.boundWorker();
      if (!this.status.monitoring) {
        throw Error('Task stopped during resend.');
      }
      const view = await this.watchView();
      if (!this.status.monitoring) {
        throw Error('Task stopped during resend.');
      }
      if (view.busy || view.draft || isReplyFragment(view)) {
        throw Error('ChatGPT is answering, receiving JSON, or has a draft. Nothing was resent.');
      }
      if ((await this.watchCandidate(view)).text) {
        return { sent: false, replyFound: true };
      }
      if (
        view.lastUserText &&
        (view.lastUserTruncated || !(await this.matchesSavedReceipt(view.lastUserText)))
      ) {
        throw Error('The chat contains a different user message. Nothing was resent.');
      }
      const text = await this.recoveryPrompt();
      if (text !== expectedPrompt) {
        throw new PageBridgeError(
          'RESEND_MISMATCH',
          'The pending prompt changed since review. Review the exact prompt again. Nothing was resent.',
        );
      }
      this.resumeWatchClock();
      this.assertCanContinue();
      // Confirmation belongs to these reviewed bytes, not mutable recovery state.
      // Reserve another turn without repeating an imported action batch.
      await this.send(expectedPrompt, view, 'resend');
      const pending = !!this.pendingSend;
      if (pending) {
        this.dependencies.log(
          'bridge.resend',
          'User requested one resend; the background coordinator is waiting for the composer.',
        );
        return { sent: false, pending: true };
      }
      this.dependencies.log(
        'bridge.resend',
        'User resent the reviewed task with a fresh reply ID. No action history was replayed.',
      );
      return { sent: true };
    } catch (error) {
      if (this.status.active) {
        await this.stop(errorMessage(error), 'error', bridgeErrorCode(error));
      }
      throw error;
    } finally {
      this.operationRunning = false;
      this.operationDone?.();
    }
  }

  async stop(reason = 'Stopped by you', phase = 'stopped', errorCode?: string): Promise<void> {
    this.hostReconnect = undefined;
    if (!this.status.active && !this.status.monitoring) {
      await this.stopPending;
      return;
    }
    // A cold start only reads the checkpoint and prompts. A failed or cancelled
    // admission does not own the page session or a newer host checkpoint.
    if (this.options.reattachRevision !== undefined && this.starting) {
      this.status.active = false;
      this.status.errorCode = errorCode;
      this.update(phase, reason);
      return;
    }
    // A receive-side error is not a user Stop. Suspend sending/execution while
    // keeping a narrowly scoped read-only watcher on the pending exchange.
    if (
      phase === 'error' &&
      errorCode &&
      recoverableReceiveErrors.has(errorCode) &&
      this.options.lastReceipt?.expectsReplyTo &&
      this.progress &&
      ['waiting_reply', 'commit_intent'].includes(this.progress.stage) &&
      !this.status.monitoring
    ) {
      this.status.active = false;
      this.status.monitoring = true;
      this.status.watchUntil = this.now() + LATE_REPLY_WATCH_MS;
      this.activeTimeStoppedAt = this.now();
      this.status.errorCode = errorCode;
      this.lateReplyWatch.start(reason);
      this.publishWatchStatus();
      this.dependencies.log(
        'bridge.attention',
        `Sending paused. Read-only late-reply watch is active for ${LATE_REPLY_WATCH_MS / 60000} minutes; no prompt is automatically resent.`,
      );
      try {
        await this.checkpoint();
      } catch (error) {
        this.status.monitoring = false;
        this.status.errorCode = 'PROGRESS_SAVE_FAILED';
        this.update('error', errorMessage(error));
      }
      return;
    }
    this.pendingSend = undefined;
    this.pendingDelivery = undefined;
    const wasMonitoring = this.status.monitoring;
    delete this.status.receiving;
    this.status.monitoring = false;
    delete this.status.watchUntil;
    let priorPhase = this.status.phase;
    if (priorPhase === 'reconnecting') {
      priorPhase = this.recoveryPhase;
    }
    this.status.active = false;
    if (!wasMonitoring) {
      this.activeTimeStoppedAt = this.now();
    }
    this.status.errorCode = errorCode;
    this.update(phase, reason);
    this.dependencies.log('bridge.stop', reason);
    // Publish Stop before waiting for local work or a page reply.
    const worker = this.dependencies
      .snapshot()
      ?.workers.find((worker) => worker.id === this.options.workerId);
    const tasks: Promise<unknown>[] = [];
    if (
      worker &&
      this.ownsWorker(worker) &&
      !['complete', 'review'].includes(phase) &&
      (inFlight.has(worker.state) || ['running', 'waiting_approval'].includes(priorPhase))
    ) {
      tasks.push(
        this.queryRpc('worker.pause', {
          workerId: worker.id,
          epoch: this.executionEpoch,
        }).catch((error) => this.dependencies.log('bridge.local.pause.error', errorMessage(error))),
      );
    }
    tasks.push(this.requestPage('stop').catch(() => {}));
    let finalStage: TaskProgress['stage'] | undefined;
    if (phase === 'complete' || phase === 'review') {
      finalStage = phase;
    }
    tasks.push(
      this.checkpoint(finalStage).catch((error) =>
        this.dependencies.log('bridge.storage.error', errorMessage(error)),
      ),
    );
    const stopping = Promise.all(tasks).then(() => {});
    this.stopPending = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopPending === stopping) {
        this.stopPending = undefined;
      }
    }
  }
}
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
function bridgeErrorCode(error: unknown): string | undefined {
  if (error instanceof PageBridgeError || error instanceof RpcResultValidationError) {
    return error.code;
  }
  return undefined;
}
