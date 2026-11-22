import { hostMismatch } from '../transport/build-connection.js';
import {
  localRpcRegistry,
  type BridgeStartResult,
  type BridgeStopStartedResult,
  type ContinuePendingResult,
  type ResumeResult,
} from '../schemas/local-results.js';
import { coreRpcRegistry, parseRpcResult } from '../../../../packages/protocol/src/rpc.js';
import { progressRpcRegistry } from '../schemas/native-rpc.js';
import { previewFailures } from '../preview-failures.js';
import { CompletedPreviews } from './completed-previews.js';
import { ReplyTickets } from './reply-tickets.js';
import { errorMessage } from '../schemas/primitives.js';
import { waitFor, chatOrigins } from './storage-reset.js';
import { validateWorkspaceAction } from '../../../../packages/ui/src/workspace.js';
import { DraftRewrites } from './draft-rewrites.js';
import {
  assertFreshReplyExchange,
  boundReply,
  replyDigest,
  actionSummary,
  type ReplyPreview,
} from '../../../../packages/bridge/src/reply-recovery.js';
import {
  matchesBuild,
  type Snapshot,
  type TaskBoundary,
  type Worker,
} from '../../../../packages/protocol/src/index.js';
import { PageTransport, PageBridgeError } from '../../../../packages/bridge/src/page-transport.js';
import {
  bootstrapDraftSchema,
  matchesBootstrapDraft,
  type BootstrapDraft,
} from '../../../../packages/bridge/src/bootstrap-draft.js';
import { answeredDraftLimit, type ChatLink } from '../../../../packages/bridge/src/chat-links.js';
import { chatgptProvider } from '../../../../packages/bridge/src/connections/providers.js';
import { ChatConnections, chatChoice } from './chat-connections.js';
import {
  messageDigest,
  unwrapMessage,
  type OutboundReceipt,
} from '../../../../packages/bridge/src/message-wire.js';
import { WorkspaceStore } from '../../../../packages/ui/src/workspace-store.js';
import { displayTaskName } from '../../../../packages/protocol/src/task-brief.js';
import { Diagnostics } from '../../../../packages/bridge/src/diagnostics.js';

import {
  ChatTabLiveness,
  assertChatTabAvailable,
  chatStartURL,
  BridgeRunner,
  type BridgeStatus,
  type BridgeOptions,
} from '../../../../packages/bridge/src/index.js';
import type { NativeRPC } from '../transport/native-host.js';
import type { TaskNotifications } from './notifications.js';
import {
  snapshotSchema,
  bridgeLoadSchema,
  seenResultSchema,
  activationResultSchema,
  steeringValidationSchema,
  replyValidationSchema,
  followupRequestSchema,
  followupSchema,
} from '../schemas/host-results.js';
import {
  workerParametersSchema,
  followupParametersSchema,
  haltParametersSchema,
  restoreFileParametersSchema,
  rollbackParametersSchema,
  bridgeStartSchema,
  type BridgeStartOptions,
  type BridgeStartIdentity,
  bridgeStopStartedSchema,
  type BridgeStopStartedParameters,
  bridgeResumeSchema,
  bridgeContinuePendingSchema,
  bridgeResendSchema,
  forwardedTaskParametersSchema,
  handoffDeliveryParametersSchema,
  type ForwardedTaskParameters,
  steeringParametersSchema,
  replyPreviewParametersSchema,
  replyConfirmationSchema,
} from '../schemas/requests.js';
import { forwardedMethods, validateViewParams } from '../schemas/view-rpc.js';
import {
  pageRequestSchema,
  pageHelloRequestSchema,
} from '../../../../packages/bridge/src/transport/messages.js';
import {
  isActiveReplyWait,
  isUnsentBootstrap,
  matchesRecoverableWait,
  holdsSetupApproval,
  taskProgressSchema,
} from '../../../../packages/bridge/src/progress.js';

type TaskDependencies = {
  rpc: NativeRPC;
  broadcast(message: unknown): void;
  blocked(): boolean;
  requireHelper?(): void;
  ready(): Promise<void>;
  notifications: TaskNotifications;
  diagnostics: Diagnostics;
};

type TaskAdmission = {
  check(): void;
  verify(): Promise<Snapshot>;
};

type StartedChat = {
  identity: BridgeStartIdentity;
  cleanupRequested: boolean;
};

function matchesTaskBoundary(actual: TaskBoundary | undefined, expected: TaskBoundary): boolean {
  return actual !== undefined && actual.runId === expected.runId && actual.epoch === expected.epoch;
}

function taskBoundary(worker: Worker | undefined): TaskBoundary | undefined {
  if (worker) {
    return { runId: worker.runId, epoch: worker.control?.epoch ?? 0 };
  }

  return undefined;
}

function assertTaskBoundary(
  actual: TaskBoundary | undefined,
  expected: TaskBoundary,
  delivery = false,
): void {
  if (!actual || (!delivery && actual.runId !== expected.runId) || actual.epoch !== expected.epoch) {
    throw new Error(
      'This review belongs to an earlier task run. Nothing was sent; review the current task before continuing.',
    );
  }
}

function resumeParameters(
  params: Record<string, unknown>,
  expectedRun: TaskBoundary,
): Record<string, unknown> {
  if (params.epoch !== undefined && params.epoch !== expectedRun.epoch) {
    throw new Error('The supplied epoch does not match the reviewed task boundary. Review the task again.');
  }

  if (params.epoch === undefined) {
    return { ...params, epoch: expectedRun.epoch };
  }

  return params;
}

function startupBinding(worker: Worker): string {
  return JSON.stringify([
    worker.projectId,
    worker.goal,
    worker.mode,
    worker.runId,
    worker.control?.epoch ?? 0,
    worker.queue[0],
  ]);
}

function canUseChat(worker: Worker): boolean {
  return (
    worker.mode === 'handoff' &&
    ['idle', 'review', 'paused', 'blocked'].includes(worker.state) &&
    !worker.pending &&
    !worker.humanAcceptanceReady
  );
}

function canReattachReply(worker: Worker): boolean {
  return (
    canUseChat(worker) &&
    !worker.queue.length &&
    !worker.teamPaused &&
    worker.control?.mode !== 'stopped' &&
    ['idle', 'review'].includes(worker.state)
  );
}

function canRecoverWait(
  worker: Worker,
  status: { phase: string; errorCode?: string | undefined; monitoring?: boolean | undefined },
): boolean {
  if (isActiveReplyWait(status)) {
    return canReattachReply(worker);
  }
  if (status.errorCode || status.monitoring || !['running', 'waiting_approval'].includes(status.phase)) {
    return false;
  }
  // A finished setup may already have released the queue. Its native batch
  // receipt is required by matchesRecoverableWait before reconnecting.
  return holdsSetupApproval(worker) || (worker.state === 'review' && canReattachReply(worker));
}

function requireChatStartWorker(fresh: Snapshot, workerId: string): Worker {
  if (!matchesBuild(fresh.runtime.version, fresh.runtime.buildId)) {
    throw new Error(hostMismatch(fresh.runtime.version, fresh.runtime.buildId));
  }

  const worker = fresh.workers.find((worker) => worker.id === workerId);

  if (!worker) {
    throw new Error('Task not found.');
  }

  if (worker.control?.mode === 'stopped') {
    throw new Error('Task stopped. Use Continue fresh rather than starting another chat.');
  }

  if (!canUseChat(worker) || worker.queue.length) {
    throw new Error(
      'This task has pending local work or a result ready for review. Resolve that before starting another chat.',
    );
  }

  return worker;
}

export function createTaskController(dependencies: TaskDependencies) {
  const { rpc, broadcast, notifications, diagnostics } = dependencies;
  let disposed = false;
  async function readTaskState(): Promise<Snapshot> {
    const fresh = await rpc('state', {}, snapshotSchema);
    const { version, buildId } = fresh.runtime;
    if (!matchesBuild(version, buildId)) {
      throw new PageBridgeError('HOST_VERSION_MISMATCH', hostMismatch(version, buildId));
    }
    return fresh;
  }
  const checkAvailable = (): void => {
    if (dependencies.blocked() || disposed) {
      throw new Error(
        'Miter data reset is incomplete or running. Retry Clear all Miter data before continuing.',
      );
    }
  };
  const completedPreviews = new CompletedPreviews(
    rpc,
    () => dependencies.blocked() || disposed,
    (url) => chrome.tabs.create({ url }),
    (workerId, expectedRun, message) => {
      const write = previewFailures.save(workerId, expectedRun, message).catch((error) => {
        diagnostics.add('preview.feedback.error', errorMessage(error));
      });
      diagnostics.add('preview.open.error', message);
      broadcast({ event: 'taskNotification', data: { workerId, kind: 'warning', message } });
      return write;
    },
  );
  const runners = new Map<string, BridgeRunner>();
  const runnerBoundaries = new WeakMap<BridgeRunner, TaskBoundary>();
  const startedChats = new WeakMap<BridgeRunner, StartedChat>();

  const starting = new Map<string, symbol>();
  const controlBusy = new Set<string>();
  const continuing = new Set<string>();
  const startRevisions = new Map<string, number>();
  const replyRecoveryChecks = new Map<string, { revision: number; retryAt: number }>();
  let browserStartedAt: number | undefined;
  const startupDestinationsHandled = new Set<string>();
  // Session restore can announce and close a tab before links or the native
  // snapshot arrive. Remember its visible conversation only through startup.
  const restoringTabUrls = new Map<number, string>();
  let admissionGeneration = 0;
  let notificationOpenRevision = 0;
  const startGuard = (workerId: string) => {
    const revision = startRevisions.get(workerId) ?? 0;

    return () => {
      if (dependencies.blocked() || disposed || (startRevisions.get(workerId) ?? 0) !== revision) {
        throw new Error('This start was superseded by Stop or Steer. No further message will be sent.');
      }
    };
  };
  const followupArmed = new Set<string>();
  const followupStarting = new Set<string>();

  const replyTickets = new ReplyTickets();
  let snapshot: Snapshot | undefined;
  let hostConnection = Symbol('host connection');
  const log = (kind: string, message: string) => diagnostics.add(kind, message);
  const tabLiveness = new ChatTabLiveness(chrome.tabs, chrome.storage.session, log);
  const syncTabLiveness = (): Promise<void> => {
    if (dependencies.blocked() || disposed) {
      return tabLiveness.sync([]);
    }

    return tabLiveness.sync([
      ...[...runners.values()]
        .filter((runner) => runner.status.active || runner.status.monitoring)
        .map((runner) => runner.status.tabId),
      ...rewrites.activeTabIds,
    ]);
  };
  const workspace = new WorkspaceStore(chrome.storage.local ?? chrome.storage.session, (workspaceState) =>
    broadcast({ event: 'workspace', data: workspaceState }),
  );
  const catalog = (currentSnapshot: Snapshot) => ({
    projects: currentSnapshot.projects,
    tasks: currentSnapshot.workers.map((worker) => ({
      ...worker,
      name: displayTaskName(worker),
    })),
  });
  const syncWorkspace = (currentSnapshot: Snapshot) =>
    void workspace.sync(catalog(currentSnapshot)).catch((error) => {
      const detail = errorMessage(error);
      log('workspace.error', detail);
      broadcast({ event: 'workspaceError', error: detail });
    });
  const bridgeStates = (): BridgeStatus[] => {
    const states = [...runners.values()].map((runner) => ({ ...runner.status }));

    // A link alone is history. Only an exact active host checkpoint restores its runner.
    for (const [workerId, link] of links.entries()) {
      const worker = snapshot?.workers.find((worker) => worker.id === workerId);

      if (
        !worker ||
        worker.state === 'complete' ||
        worker.state === 'cancelled' ||
        runners.has(workerId) ||
        (link.projectId && link.projectId !== worker.projectId)
      ) {
        continue;
      }

      const saved = snapshot?.bridgeProgress?.find((progress) => progress.workerId === workerId);
      const reattaching = starting.has(workerId) && replyRecoveryChecks.has(workerId);
      let phase = 'stopped';
      let reason = 'Progress saved. Resume continues in the same chat.';
      if (reattaching) {
        phase = 'reconnecting';
        reason = 'Checking the saved ChatGPT reply…';
      }
      states.push({
        workerId,
        tabId: link.id,
        url: link.url,
        active: reattaching,
        phase,
        reason,
        turns: saved?.turns ?? 0,
        maxTurns: saved?.maxTurns ?? link.maxTurns ?? 15,
        startedAt: saved?.startedAt ?? link.updatedAt ?? 0,
        lowerBound: saved?.lowerBound,
        activeMs: saved?.activeMs,
        maxMinutes: saved?.maxMinutes,
        errorCode: saved?.errorCode,
      });
    }

    return states;
  };
  const publish = () => {
    void syncTabLiveness().catch(() => {});

    if (dependencies.blocked() || disposed) {
      return;
    }

    broadcast({ event: 'bridges', data: bridgeStates() });

    for (const runner of runners.values()) {
      notifications.bridge(
        runner.status,
        snapshot?.workers.find((worker) => worker.id === runner.status.workerId),
      );
      const link = links.get(runner.status.workerId);

      if (
        link &&
        link.id === runner.status.tabId &&
        (link.url !== runner.status.url || !!link.bindingPending !== !!runner.status.bindingPending)
      ) {
        links.set(runner.status.workerId, {
          ...link,
          url: runner.status.url,
          newChat: !runner.status.url.includes('/c/'),
          bindingPending: runner.status.bindingPending,
          updatedAt: Date.now(),
        });
      }
    }
  };
  const saveReceipt = async (
    workerId: string,
    tabId: number,
    receipt: OutboundReceipt,
    expectedRun: TaskBoundary,
  ) => {
    const link = links.get(workerId);

    if (!link || link.id !== tabId) {
      throw new Error('The task conversation changed before sending.');
    }

    links.set(workerId, {
      ...link,
      lastReceipt: receipt,
      receiptRun: expectedRun,
      updatedAt: Date.now(),
    });
    await links.flush(true);
  };
  const pageTransport = new PageTransport(
    {
      checkAvailable: async (tabId) => {
        assertChatTabAvailable(await chrome.tabs.get(tabId));
      },
      send: (tabId, message) => {
        const operation = pageRequestSchema.safeParse(message);

        const handshake = pageHelloRequestSchema.safeParse(message);
        const stopping = operation.success && ['stop', 'interrupt'].includes(operation.data.action.op);

        if ((dependencies.blocked() || disposed) && !stopping && !handshake.success) {
          return Promise.reject(new Error('Data reset in progress. No page operation was sent.'));
        }

        if (!stopping && !handshake.success) {
          dependencies.requireHelper?.();
        }
        return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
      },
      inject: async (tabId) => {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'ISOLATED',
          files: ['mitter-page.js'],
        });
      },
    },
    log,
  );
  const rewrites = new DraftRewrites(pageTransport, syncTabLiveness);
  const chats = new ChatConnections({
    rpc,
    snapshot: () => snapshot,
    sessions: () => [...runners.values()].map((runner) => runner.status),
    log,
  });
  const links = chats.links;
  const loadedLinks = links.ready.then(() => {
    reattachWaitingReplies();
    publish();
  });

  async function disableReplyRecovery(workerId: string): Promise<void> {
    startRevisions.set(workerId, (startRevisions.get(workerId) ?? 0) + 1);
    await links.ready;
    const link = links.get(workerId);
    if (link?.lastReceipt) {
      links.set(workerId, { ...link, receiptRun: null });
      await links.flush(true);
    }
  }

  function reattachWaitingReplies(): void {
    if (
      !snapshot ||
      !matchesBuild(snapshot.runtime.version, snapshot.runtime.buildId) ||
      disposed ||
      dependencies.blocked()
    ) {
      return;
    }
    for (const summary of snapshot.bridgeProgress ?? []) {
      const { workerId, revision } = summary;
      if (revision === undefined || runners.has(workerId) || runBusy(workerId)) {
        continue;
      }
      const previous = replyRecoveryChecks.get(workerId);
      if (previous?.revision === revision && previous.retryAt > Date.now()) {
        continue;
      }
      const worker = snapshot.workers.find((item) => item.id === workerId);
      const link = links.get(workerId);
      let boundary = link?.receiptRun;
      if (boundary === undefined) {
        boundary = link?.automaticStart;
      }
      if (
        !worker ||
        !canRecoverWait(worker, summary) ||
        !link ||
        !boundary ||
        !matchesTaskBoundary(taskBoundary(worker), boundary) ||
        link.projectId !== worker.projectId ||
        link.newChat ||
        link.bindingPending ||
        !link.lastReceipt?.expectsReplyTo ||
        !link.lastReceipt.exchangeId ||
        worker.control?.retiredExchanges.includes(link.lastReceipt.exchangeId)
      ) {
        continue;
      }
      replyRecoveryChecks.set(workerId, { revision, retryAt: Date.now() + 15000 });
      void reattachReply(worker, link, boundary, revision).catch((error) =>
        log('bridge.reattach.pending', errorMessage(error)),
      );
    }
  }

  async function reattachReply(
    worker: Worker,
    link: ChatLink,
    expectedRun: TaskBoundary,
    revision: number,
  ): Promise<void> {
    const workerId = worker.id;
    const owner = Symbol('waiting reply');
    const admission = admitTask(workerId, expectedRun);
    starting.set(workerId, owner);
    let reserved: number | undefined;
    publish();
    try {
      await dependencies.ready();
      admission.check();
      if (!(await chrome.permissions.contains({ origins: chatOrigins }))) {
        return;
      }
      const loaded = await rpc('worker.bridgeLoad', { workerId, expectedRun }, bridgeLoadSchema);
      admission.check();
      if (
        !matchesRecoverableWait(
          loaded.progress,
          revision,
          link.url,
          link.lastReceipt,
          worker,
          loaded.setupResultBatchId,
        ) ||
        loaded.progress?.goalHash !== (await messageDigest(worker.goal))
      ) {
        return;
      }
      const fresh = await admission.verify();
      const current = fresh.workers.find((item) => item.id === workerId);
      const checkpoint = fresh.bridgeProgress?.find((item) => item.workerId === workerId);
      const savedLink = links.get(workerId);
      if (
        !matchesBuild(fresh.runtime.version, fresh.runtime.buildId) ||
        !current ||
        !checkpoint ||
        !canRecoverWait(current, checkpoint) ||
        !matchesRecoverableWait(
          loaded.progress,
          revision,
          link.url,
          link.lastReceipt,
          current,
          loaded.setupResultBatchId,
        ) ||
        current.projectId !== worker.projectId ||
        current.goal !== worker.goal ||
        checkpoint.revision !== revision ||
        savedLink?.id !== link.id ||
        savedLink.url !== link.url ||
        savedLink.receiptRun === null ||
        savedLink.lastReceipt?.exchangeId !== link.lastReceipt?.exchangeId
      ) {
        return;
      }
      const open = await chats.openReplyTabs(link);
      admission.check();
      let candidate = open[0];
      if (!candidate) {
        if (
          browserStartedAt === undefined ||
          !link.lastReceipt ||
          link.lastReceipt.at > browserStartedAt ||
          Date.now() - browserStartedAt > 120000 ||
          startupDestinationsHandled.has(workerId)
        ) {
          if (replyRecoveryChecks.has(workerId)) {
            replyRecoveryChecks.set(workerId, { revision, retryAt: Infinity });
          }
          return;
        }
        // Chrome may publish restored windows after onStartup. Only browser startup
        // may reopen an absent conversation, once, after that restoration grace.
        const restoreAfter = browserStartedAt + 10000;
        if (Date.now() < restoreAfter) {
          replyRecoveryChecks.set(workerId, { revision, retryAt: restoreAfter });
          return;
        }
        startupDestinationsHandled.add(workerId);
        candidate = await chrome.tabs.create({ url: link.url, active: false });
        admission.check();
      }
      if (open.length > 1 || candidate.id === undefined) {
        return;
      }
      const tab = chatChoice({ id: candidate.id, url: candidate.pendingUrl || candidate.url });
      if (!tab || tab.url !== link.url || tab.newChat) {
        return;
      }
      chats.reserve(workerId, tab);
      reserved = tab.id;
      if (browserStartedAt !== undefined) {
        startupDestinationsHandled.add(workerId);
      }
      if (tab.id !== link.id) {
        links.set(workerId, { ...savedLink, id: tab.id, updatedAt: Date.now() });
        await links.flush(true);
        admission.check();
      }
      const destination = await chrome.tabs.get(tab.id);
      admission.check();
      if (chatChoice({ id: tab.id, url: destination.pendingUrl || destination.url })?.url !== link.url) {
        return;
      }
      if (destination.discarded || destination.status === 'unloaded') {
        // Restored background tabs can remain unloaded until selected. Load only
        // this verified destination without activating the user's window.
        await chrome.tabs.reload(tab.id);
        admission.check();
      }
      let expectedBatchId: string | undefined;
      if (loaded.progress && ['local_batch', 'report_due'].includes(loaded.progress.stage)) {
        expectedBatchId = loaded.progress.lastImportedId;
      }
      const runner = createRunner(current, {
        workerId,
        projectId: current.projectId,
        tabId: tab.id,
        url: tab.url,
        expectedRun,
        token: crypto.randomUUID(),
        maxTurns: Math.min(20, checkpoint.maxTurns),
        maxMinutes: Math.min(60, checkpoint.maxMinutes),
        previousProgress: checkpoint,
        lastReceipt: link.lastReceipt,
        reattachRevision: revision,
        expectedBatchId,
      });
      runners.set(workerId, runner);
      completedPreviews.arm(current);
      publish();
      log('bridge.reattach', 'Reconnecting the task to its saved conversation.');
      try {
        await runner.start();
      } catch (error) {
        if (runners.get(workerId) === runner) {
          runners.delete(workerId);
        }
        throw error;
      }
    } finally {
      releaseStart(workerId, owner, reserved);
      publish();
    }
  }

  function admitTask(
    workerId: string,
    expectedRun: TaskBoundary | undefined,
    intent: 'continue' | 'start' | 'delivery' = 'continue',
  ): TaskAdmission {
    const delivery = intent === 'delivery';
    const originalRunner = runners.get(workerId);
    const originalSnapshot = snapshot;
    const generation = admissionGeneration;
    const connection = hostConnection;
    const checkStart = startGuard(workerId);
    const check = (): void => {
      checkStart();

      if (connection !== hostConnection) {
        throw new Error(
          'The local host connection changed. This task admission was superseded. Review its saved state before continuing.',
        );
      }

      if (runners.get(workerId) !== originalRunner) {
        throw new Error('The task’s conversation changed. Review the current task before continuing.');
      }

      if (admissionGeneration !== generation) {
        throw new Error('This task admission was superseded by data reset. No further operation was sent.');
      }

      if (expectedRun) {
        if (originalRunner && intent !== 'start') {
          assertTaskBoundary(runnerBoundaries.get(originalRunner), expectedRun, delivery);
        }

        if (snapshot !== originalSnapshot) {
          assertTaskBoundary(
            taskBoundary(snapshot?.workers.find((worker) => worker.id === workerId)),
            expectedRun,
            delivery,
          );
        }
      }
    };

    return {
      check,
      async verify() {
        check();
        const fresh = await readTaskState();
        check();

        if (expectedRun) {
          assertTaskBoundary(
            taskBoundary(fresh.workers.find((worker) => worker.id === workerId)),
            expectedRun,
            delivery,
          );
        }

        return fresh;
      },
    };
  }

  function admitStartup(workerId: string, admission?: TaskAdmission): TaskAdmission {
    let binding: string | undefined;
    const original = snapshot?.workers.find((worker) => worker.id === workerId);

    if (original) {
      binding = startupBinding(original);
    }

    const checkStart = startGuard(workerId);
    const checkWorker = (worker: Worker | undefined): void => {
      if (!worker || (binding !== undefined && startupBinding(worker) !== binding)) {
        throw new PageBridgeError(
          'RUN_SUPERSEDED',
          'The reviewed task, goal, or queued batch changed. Review it before continuing.',
        );
      }
    };
    const check = (): void => {
      checkStart();
      admission?.check();

      if (snapshot) {
        checkWorker(snapshot.workers.find((worker) => worker.id === workerId));
      }
    };

    return {
      check,
      async verify() {
        check();
        const fresh = await (admission?.verify() ?? readTaskState());
        check();
        const worker = fresh.workers.find((worker) => worker.id === workerId);
        checkWorker(worker);

        if (worker) {
          binding ??= startupBinding(worker);
        }

        return fresh;
      },
    };
  }

  function runBusy(workerId: string): boolean {
    const status = runners.get(workerId)?.status;

    return controlBusy.has(workerId) || starting.has(workerId) || !!status?.active || !!status?.monitoring;
  }

  function releaseStart(workerId: string, owner: symbol, tabId: number | undefined): void {
    if (starting.get(workerId) !== owner) {
      return;
    }

    starting.delete(workerId);

    if (tabId !== undefined) {
      chats.release(workerId, tabId);
    }
  }

  async function refreshSnapshot(check: () => void = () => {}, admission?: TaskAdmission): Promise<Snapshot> {
    // Reviewed intents must reject intervening updates before caching a late state response.
    const fresh = await (admission?.verify() ?? readTaskState());
    admission?.check();
    snapshot = fresh;
    check();
    checkAvailable();
    broadcast({ event: 'snapshot', data: fresh });

    return fresh;
  }
  async function kickFollowup(
    workerId: string,
    params: Record<string, unknown> = { workerId },
  ): Promise<unknown> {
    if (dependencies.blocked() || disposed || followupStarting.has(workerId) || runBusy(workerId)) {
      return { queued: true };
    }

    followupStarting.add(workerId);

    try {
      await runners.get(workerId)?.flushed();
      const before = await readTaskState();
      snapshot = before;
      const task = before.workers.find((worker) => worker.id === workerId);

      if (!task) {
        return { queued: true };
      }

      if (!task.followups?.some((followup) => followup.status === 'queued')) {
        followupArmed.delete(workerId);

        return { queued: true };
      }

      const result = await rpc('worker.followupActivate', params, activationResultSchema);

      if (!result.activated) {
        return { queued: true, reason: result.reason };
      }

      const fresh = await refreshSnapshot();

      if (task.mode === 'local') {
        return rpc('worker.run', {
          workerId,
          epoch: fresh.workers.find((worker) => worker.id === workerId)?.control?.epoch ?? 0,
        });
      }

      const expectedRun = taskBoundary(fresh.workers.find((worker) => worker.id === workerId));

      if (!expectedRun) {
        throw new Error('The activated task is no longer available. Review it before starting chat.');
      }

      const admission = admitTask(workerId, expectedRun, 'start');
      const resumed = await resumeChat(workerId);

      if (resumed.resumed) {
        return resumed;
      }

      if (!(await chrome.permissions.contains({ origins: chatOrigins }))) {
        return {
          queued: true,
          reason: 'Allow ChatGPT access to start the saved follow-up.',
        };
      }

      return startChat(
        {
          workerId,
          newChat: true,
          consent: true,
          maxTurns: 15,
          maxMinutes: 30,
        },
        admission,
      );
    } catch (error) {
      followupArmed.delete(workerId);
      log('followup.error', errorMessage(error));
      throw error;
    } finally {
      followupStarting.delete(workerId);
    }
  }

  function createRunner(
    worker: Worker,
    options: BridgeOptions,
    resumeParams?: Record<string, unknown>,
  ): BridgeRunner {
    const { workerId, tabId } = options;
    const expectedRun = {
      ...(options.expectedRun ?? { runId: worker.runId, epoch: worker.control?.epoch ?? 0 }),
    };
    const generation = admissionGeneration;
    const checkStart = startGuard(workerId);
    const projectId = worker.projectId;
    const goal = worker.goal;
    const mode = worker.mode;
    const batch = JSON.stringify(worker.queue[0]);
    const destination = chatStartURL(options.url, options.newChat === true);
    let reattachPhase = 'waiting_reply';
    if (options.expectedBatchId) {
      reattachPhase = 'waiting_approval';
    }
    let superseded = false;
    const checkWorker = (current: Worker | undefined): void => {
      if (
        !current ||
        !matchesTaskBoundary(taskBoundary(current), expectedRun) ||
        current.projectId !== projectId ||
        current.goal !== goal ||
        current.mode !== mode ||
        (options.reattachRevision !== undefined && !canRecoverWait(current, { phase: reattachPhase })) ||
        JSON.stringify(current.queue[0]) !== batch
      ) {
        superseded = true;
        throw new PageBridgeError(
          'RUN_SUPERSEDED',
          'The reviewed task or queued batch changed during startup. Review it before continuing.',
        );
      }
    };
    const checkRunner = (): void => {
      if (superseded || runners.get(workerId) !== runner) {
        throw new PageBridgeError('RUN_SUPERSEDED', 'This chat runner was replaced. Nothing else will run.');
      }
    };
    const checkStartup = (): void => {
      checkRunner();
      checkStart();
      checkAvailable();

      if (generation !== admissionGeneration) {
        throw new PageBridgeError('RUN_SUPERSEDED', 'Data reset retired this runner’s startup.');
      }

      checkWorker(snapshot?.workers.find((current) => current.id === workerId));
      const link = links.get(workerId);

      if (!link || link.id !== tabId || chatStartURL(link.url, true) !== destination) {
        throw new PageBridgeError('NAVIGATED', 'The saved chat destination changed during startup.');
      }
    };

    let staleDraftAuthorization: { proof: BootstrapDraft; previous: Worker } | undefined;
    const retainedDrafts = (link: ChatLink | undefined): BootstrapDraft[] => {
      const drafts = link?.answeredDrafts ?? [];
      const first = link?.confirmedBootstrapDraft;
      if (first && !drafts.some((draft) => draft.exchangeId === first.exchangeId)) {
        return [first, ...drafts];
      }
      return drafts;
    };
    const stillRetained = (proof: BootstrapDraft): boolean =>
      retainedDrafts(links.get(proof.workerId)).some(
        (draft) => JSON.stringify(draft) === JSON.stringify(proof),
      );
    const draftOwner = (proof: BootstrapDraft, expected?: Worker, source = snapshot): Worker | undefined => {
      const previous = source?.workers.find((current) => current.id === proof.workerId);
      if (
        !previous ||
        previous.projectId !== proof.projectId ||
        (expected &&
          (previous.goal !== expected.goal ||
            previous.runId !== expected.runId ||
            (previous.control?.epoch ?? 0) !== (expected.control?.epoch ?? 0)))
      ) {
        return;
      }

      const ownerLink = links.get(previous.id);
      // ChatGPT can restore an answered composer into a different new tab while
      // the original conversation is still running. Its native import is final.
      if (
        ownerLink &&
        ownerLink.id !== tabId &&
        !ownerLink.newChat &&
        new URL(ownerLink.url).pathname.startsWith('/c/') &&
        ownerLink.answeredDrafts?.some((draft) => JSON.stringify(draft) === JSON.stringify(proof))
      ) {
        return previous;
      }

      if (
        previous.queue.length !== 0 ||
        previous.pending ||
        previous.followups?.some(
          (followup) => !['completed', 'cancelled', 'superseded'].includes(followup.status),
        ) ||
        runners.get(previous.id)?.status.active ||
        runners.get(previous.id)?.status.monitoring ||
        starting.has(previous.id) ||
        continuing.has(previous.id) ||
        controlBusy.has(previous.id) ||
        followupArmed.has(previous.id) ||
        followupStarting.has(previous.id) ||
        (expected &&
          (previous.state !== expected.state ||
            previous.control?.mode !== expected.control?.mode ||
            previous.activeFollowupId !== expected.activeFollowupId))
      ) {
        return;
      }
      const completed =
        previous.state === 'complete' &&
        (!previous.activeFollowupId || previous.completion?.followupId === previous.activeFollowupId);
      const stopped =
        previous.state === 'paused' && previous.control?.mode === 'stopped' && !previous.activeFollowupId;
      if (!completed && !stopped) {
        return;
      }
      return previous;
    };

    // Startup transfers to this runner, not the released UI admission or a replacement task.
    const runner = new BridgeRunner(
      { ...options, expectedRun },
      {
        checkAvailable: () => {
          checkRunner();
          checkStart();
          checkAvailable();

          if (generation !== admissionGeneration) {
            throw new PageBridgeError('RUN_SUPERSEDED', 'Data reset retired this runner.');
          }
        },
        async verifyStartup() {
          checkStartup();
          const current = chatChoice(await chrome.tabs.get(tabId));
          checkStartup();

          if (!current || (!options.newChat && current.url !== destination)) {
            throw new PageBridgeError(
              'NAVIGATED',
              'The linked tab no longer matches the reviewed conversation. No local work was started.',
            );
          }

          const fresh = await readTaskState();
          checkStartup();
          checkWorker(fresh.workers.find((current) => current.id === workerId));
          snapshot = fresh;
        },
        async reconnectHost() {
          checkRunner();
          checkStart();
          checkAvailable();
          const before = snapshot;
          const connection = hostConnection;
          const fresh = await readTaskState();
          checkRunner();
          checkStart();
          checkAvailable();
          if (generation !== admissionGeneration) {
            throw new PageBridgeError('RUN_SUPERSEDED', 'Data reset retired this host reconnect.');
          }
          if (connection !== hostConnection) {
            throw new Error(
              'The local host disconnected again during the state read. Its result was discarded.',
            );
          }
          // A newer pushed state may contain Pause/Stop. Never replace it with a late read.
          if (snapshot === before || snapshot === undefined) {
            snapshot = fresh;
            broadcast({ event: 'snapshot', data: fresh });
          }
          return snapshot;
        },
        async confirmBootstrapDraft(proof) {
          checkRunner();
          const confirmed = bootstrapDraftSchema.parse(proof);
          const link = links.get(workerId);
          if (
            !link ||
            link.id !== tabId ||
            confirmed.workerId !== workerId ||
            confirmed.projectId !== projectId ||
            JSON.stringify(link.lastReceipt?.bootstrapDraft) !== JSON.stringify(confirmed)
          ) {
            throw new Error('The first-message receipt changed before confirmation.');
          }
          if (link.confirmedBootstrapDraft) {
            return;
          }
          links.set(workerId, { ...link, confirmedBootstrapDraft: confirmed });
          await links.flush(true);
          checkRunner();
        },
        async rememberAnsweredDraft(exchangeId) {
          checkRunner();
          const link = links.get(workerId);
          const receipt = link?.lastReceipt;
          if (
            !link ||
            link.id !== tabId ||
            !receipt?.composerHash ||
            receipt.exchangeId !== exchangeId ||
            receipt.workerId !== workerId ||
            receipt.projectId !== projectId
          ) {
            return;
          }
          const draft = bootstrapDraftSchema.parse({
            workerId,
            projectId,
            exchangeId,
            goalHash: receipt.goalHash,
            origin: new URL(link.url).origin,
            rawHash: receipt.composerHash,
          });
          const previous = link.answeredDrafts ?? [];
          if (previous.some((entry) => entry.exchangeId === exchangeId)) {
            return;
          }
          const answered = [...previous, draft];
          const recent = answered.slice(-answeredDraftLimit);
          // A provider can restore its first composer long after that reply was
          // imported. Pin it only if it is itself among the acknowledged imports.
          const bootstrap = answered.find(
            (entry) =>
              entry.exchangeId === link.confirmedBootstrapDraft?.exchangeId &&
              JSON.stringify(entry) === JSON.stringify(link.confirmedBootstrapDraft),
          );
          if (bootstrap && !recent.includes(bootstrap)) {
            recent[0] = bootstrap;
          }
          links.set(workerId, { ...link, answeredDrafts: recent });
          await links.flush(true);
          checkRunner();
        },
        canBootstrap: () => chats.canBootstrap(workerId, tabId, destination),
        async inspectBootstrapDraft(text) {
          staleDraftAuthorization = undefined;
          checkStartup();
          if (!chats.isCreatedTab(workerId, tabId) || !chatgptProvider.origins.includes(destination)) {
            return;
          }
          const frame = unwrapMessage(text);
          if (!frame) {
            return;
          }
          // A live sibling's exact wire can briefly appear in an empty new tab.
          // Its pending send permits waiting only. Clearing still requires the
          // retained fingerprint and the source task checks below.
          let pending = false;
          const candidates = [];
          for (const [oldWorkerId, link] of links.entries()) {
            if (oldWorkerId !== workerId) {
              const sibling = runners.get(oldWorkerId);
              if (
                sibling &&
                sibling.status.tabId === link.id &&
                link.id !== tabId &&
                new URL(link.url).origin === destination &&
                (await sibling.hasOutgoingDraft(text, frame.exchangeId))
              ) {
                pending = true;
              }
              for (const proof of retainedDrafts(link)) {
                if (
                  proof.exchangeId === frame.exchangeId &&
                  proof.origin === destination &&
                  (await matchesBootstrapDraft(text, proof))
                ) {
                  candidates.push(proof);
                }
              }
            }
            checkStartup();
          }
          const proof = candidates[0];
          if (candidates.length > 1) {
            return;
          }
          const owner = proof && draftOwner(proof);
          if (!proof || !owner) {
            if (pending) {
              return 'pending';
            }
            return;
          }
          // Pin nested control data too: a later resume must not rewrite the
          // expected epoch while this ownership check is awaiting host state.
          const previous = structuredClone(owner);
          if ((await messageDigest(previous.goal)) !== proof.goalHash) {
            return;
          }
          checkStartup();
          const tab = await chrome.tabs.get(tabId);
          checkStartup();
          if (tab.url !== destination + '/') {
            return;
          }
          const fresh = await readTaskState();
          checkStartup();
          checkWorker(fresh.workers.find((current) => current.id === workerId));
          if (
            !draftOwner(proof, previous, fresh) ||
            !draftOwner(proof, previous) ||
            !chats.isCreatedTab(workerId, tabId) ||
            !stillRetained(proof)
          ) {
            return;
          }
          staleDraftAuthorization = { proof, previous };
          return proof;
        },
        loadProgress: () => rpc('worker.bridgeLoad', { workerId, expectedRun }, bridgeLoadSchema),
        saveProgress: (progress, epoch) => {
          checkRunner();

          return rpc('worker.bridgeSave', { workerId, progress, epoch, expectedRun }, taskProgressSchema);
        },
        saveReceipt: (receipt) => {
          checkRunner();

          return saveReceipt(workerId, tabId, receipt, expectedRun);
        },
        rpc: (method, params) => {
          checkRunner();

          if (method === 'worker.resume' && resumeParams) {
            return rpc(method, resumeParams);
          }

          if (method.startsWith('worker.')) {
            return rpc(method, { ...params, expectedRun });
          }

          return rpc(method, params);
        },
        snapshot: () => {
          if (superseded) {
            return undefined;
          }

          return snapshot;
        },
        log,
        publish,
        page: (pageId, action) => {
          checkRunner();

          if (action.op === 'clear_draft') {
            const authorization = staleDraftAuthorization;
            staleDraftAuthorization = undefined;
            const checkDraftOwner = (): void => {
              checkStartup();
              if (
                !authorization ||
                pageId !== tabId ||
                !chats.isCreatedTab(workerId, tabId) ||
                !draftOwner(authorization.proof, authorization.previous) ||
                JSON.stringify(action.staleDraft) !== JSON.stringify(authorization.proof) ||
                !stillRetained(authorization.proof)
              ) {
                throw new PageBridgeError('DRAFT_CONFLICT', 'The previous task changed. The draft is safe.');
              }
            };
            checkDraftOwner();
            return pageTransport.request(pageId, action, checkDraftOwner);
          }

          return pageTransport.request(pageId, action);
        },
      },
    );
    runnerBoundaries.set(runner, expectedRun);

    return runner;
  }

  async function continuePending(
    params: Record<string, unknown>,
    admission: TaskAdmission,
  ): Promise<ContinuePendingResult> {
    const { workerId, expectedRun } = bridgeContinuePendingSchema.parse(params);
    const nativeParams = resumeParameters(params, expectedRun);
    checkAvailable();
    admission.check();

    if (starting.has(workerId) || continuing.has(workerId) || controlBusy.has(workerId)) {
      throw new Error('This task is already continuing or changing run state. Wait for it to finish.');
    }

    const owner = Symbol('pending continuation');
    starting.set(workerId, owner);
    const startup = admitStartup(workerId, admission);
    const check = (): void => {
      startup.check();
      checkAvailable();

      if (starting.get(workerId) !== owner) {
        throw new Error('This continuation was superseded. Review the current task before continuing.');
      }
    };
    const guarded: TaskAdmission = {
      check,
      async verify() {
        const fresh = await startup.verify();
        check();

        return fresh;
      },
    };

    try {
      await dependencies.ready();
      check();
      await runners.get(workerId)?.flushed();
      check();
      await refreshSnapshot(check, guarded);
      const saved = parseRpcResult(
        progressRpcRegistry,
        'worker.bridgeLoad',
        await rpc('worker.bridgeLoad', { workerId, expectedRun }),
      );
      check();
      const fresh = await refreshSnapshot(check, guarded);
      const worker = fresh.workers.find((worker) => worker.id === workerId);

      if (!worker) {
        throw new Error('Task not found. Review the current task before continuing.');
      }

      const progress = saved.progress;
      const goalHash = await messageDigest(worker.goal);
      check();
      await guarded.verify();

      if (
        progress &&
        (progress.workerId !== workerId ||
          progress.projectId !== worker.projectId ||
          progress.goalHash !== goalHash)
      ) {
        throw new Error('The saved chat belongs to a different task or goal. Review it before continuing.');
      }

      const batchId = worker.queue[0]?.id;

      // Only the exact durable automatic batch selects chat; lost-ack proof remains resume-only.
      if (
        worker.mode === 'handoff' &&
        batchId &&
        progress?.stage === 'local_batch' &&
        progress.lastImportedId === batchId
      ) {
        const result = await resumeChat(workerId, guarded, owner, nativeParams, progress.conversationUrl);

        return parseRpcResult(localRpcRegistry, 'bridge.continuePending', { kind: 'chat', result });
      }

      const status = runners.get(workerId)?.status;

      if (status?.active || status?.monitoring) {
        throw new Error('Stop the current chat run or reply watch before continuing local work.');
      }

      check();
      const result = parseRpcResult(
        coreRpcRegistry,
        'worker.resume',
        await rpc('worker.resume', nativeParams),
      );
      admission.check();
      checkAvailable();

      return parseRpcResult(localRpcRegistry, 'bridge.continuePending', { kind: 'local', result });
    } finally {
      releaseStart(workerId, owner, undefined);
    }
  }

  async function resumeChat(
    workerId: string,
    admission?: TaskAdmission,
    pendingOwner?: symbol,
    resumeParams?: Record<string, unknown>,
    expectedConversation?: string,
  ): Promise<ResumeResult> {
    const watching = runners.get(workerId);
    const checkAdmission = admission?.check ?? startGuard(workerId);
    checkAdmission();

    const otherStart = starting.has(workerId) && starting.get(workerId) !== pendingOwner;

    if (
      (pendingOwner !== undefined || !watching?.status.monitoring) &&
      (controlBusy.has(workerId) || otherStart)
    ) {
      throw new Error('This task is changing run state. Wait for it to finish.');
    }

    if (watching?.status.monitoring || watching?.status.active) {
      if (admission) {
        await refreshSnapshot(checkAdmission, admission);
      }

      checkAdmission();

      if (watching.status.monitoring) {
        await watching.tick();
        checkAdmission();
      }

      return { resumed: true, status: { ...watching.status } };
    }

    const startup = admitStartup(workerId, admission);
    const check = startup.check;
    const startOwner = pendingOwner ?? Symbol('chat resume');
    starting.set(workerId, startOwner);
    let reserved: number | undefined;

    try {
      await loadedLinks;
      check();
      await watching?.flushed();
      check();
      const fresh = await refreshSnapshot(check, startup);

      if (!matchesBuild(fresh.runtime.version, fresh.runtime.buildId)) {
        throw new Error(hostMismatch(fresh.runtime.version, fresh.runtime.buildId));
      }

      const worker = fresh.workers.find((item) => item.id === workerId);

      if (!worker) {
        throw new Error('Task not found.');
      }

      if (worker.control?.mode === 'stopped') {
        throw new Error('Task stopped. Use Continue fresh rather than resuming the retired plan.');
      }

      if (!canUseChat(worker)) {
        throw new Error('Review this task’s result or pending approval before resuming chat.');
      }

      let conversationUrl = expectedConversation;

      // A queued batch can continue in the same chat ONLY if the durable bridge
      // checkpoint names that exact imported batch. Manual/unrelated queues
      // retain the explicit local-only path and never acquire chat authority.
      if (worker.queue.length) {
        const saved = parseRpcResult(
          progressRpcRegistry,
          'worker.bridgeLoad',
          await rpc('worker.bridgeLoad', {
            workerId,
            expectedRun: resumeParams?.expectedRun ?? taskBoundary(worker),
          }),
        );
        check();

        if (admission) {
          await startup.verify();
        }

        const head = worker.queue[0];
        const progress = saved.progress;

        if (
          expectedConversation !== undefined &&
          (!progress?.conversationUrl ||
            chatStartURL(progress.conversationUrl) !== chatStartURL(expectedConversation))
        ) {
          throw new Error(
            'The recorded conversation changed. Review this task’s saved chat before continuing.',
          );
        }

        conversationUrl = progress?.conversationUrl ?? conversationUrl;
        const lostAck =
          pendingOwner === undefined &&
          !!progress &&
          ['waiting_reply', 'commit_intent'].includes(progress.stage) &&
          !!head &&
          ((!!head.replyTo && head.replyTo === progress.lastReceipt?.exchangeId) ||
            head.id === progress.approvedReply?.id);

        if (pendingOwner !== undefined && progress) {
          const goalHash = await messageDigest(worker.goal);
          check();

          if (
            progress.workerId !== workerId ||
            progress.projectId !== worker.projectId ||
            progress.goalHash !== goalHash
          ) {
            throw new Error(
              'The saved chat belongs to a different task or goal. Review it before continuing.',
            );
          }

          await startup.verify();
        }

        if (!lostAck && (progress?.stage !== 'local_batch' || progress.lastImportedId !== head?.id)) {
          throw new Error(
            'There is an unfinished local batch. Use Continue local work before resuming chat.',
          );
        }
      }

      check();

      const granted = await chrome.permissions.contains({ origins: chatOrigins });
      check();

      if (admission) {
        await startup.verify();
      }

      if (!granted) {
        return { resumed: false };
      }

      const previous = links.get(workerId);
      const boundary = taskBoundary(worker);
      let current: ChatLink | undefined;
      if (
        boundary &&
        previous?.newChat &&
        previous.projectId === worker.projectId &&
        matchesTaskBoundary(previous.automaticStart, boundary) &&
        !previous.lastReceipt &&
        !previous.confirmedBootstrapDraft &&
        pendingOwner === undefined &&
        !conversationUrl &&
        !worker.queue.length
      ) {
        const saved = await rpc('worker.bridgeLoad', { workerId, expectedRun: boundary }, bridgeLoadSchema);
        check();
        const progress = saved.progress;
        if (
          saved.importedCount === 0 &&
          progress &&
          isUnsentBootstrap(progress) &&
          (progress.errorCode === 'NAVIGATED' || progress.errorCode === 'DRAFT_CONFLICT') &&
          progress.workerId === workerId &&
          progress.projectId === worker.projectId &&
          progress.goalHash === (await messageDigest(worker.goal))
        ) {
          check();
          await startup.verify();
          current = { ...(await chats.fresh(workerId, check)), automaticStart: boundary };
          reserved = current.id;
        }
      }
      current ??= await chats.saved(workerId, true, check, conversationUrl);
      check();

      if (pendingOwner !== undefined && (!current || current.newChat || current.bindingPending)) {
        return { resumed: false };
      }

      if (!current && previous?.lastReceipt) {
        throw new Error(
          'The pending send belongs to this task’s original chat. Reopen that chat before resuming; a new blank chat will not be used. Your progress is saved.',
        );
      }

      if (!current && !previous) {
        // Legacy installs may have no saved link. Only inspect the active chat
        // after an explicit Resume click; ownership is checked by the runner.
        current = (
          await chrome.tabs.query({
            active: true,
            currentWindow: true,
            url: chatOrigins,
          })
        )
          .map(chatChoice)
          .find((item): item is ChatLink => !!item && !item.newChat);
        check();
      }

      if (!current && worker.control?.mode === 'fresh' && !links.get(workerId)) {
        // Stop before the first send has no conversation to reopen. An explicit
        // fresh continuation may create a separate task tab, never
        // replace an existing pending conversation.
        current = await chats.fresh(workerId, check);
        reserved = current.id;
      }

      check();

      if (admission) {
        await startup.verify();
      }

      if (!current) {
        return { resumed: false };
      }

      chats.reserve(workerId, current);
      reserved = current.id;
      // These are initial-session hints only. The native checkpoint restores any
      // explicitly extended task budget, which can exceed the new-task form cap.
      const maxTurns = Math.min(20, previous?.maxTurns ?? runners.get(workerId)?.status.maxTurns ?? 15);
      const maxMinutes = Math.min(60, previous?.maxMinutes ?? 30);
      links.set(workerId, {
        ...current,
        projectId: worker.projectId,
        receiptRun: boundary,
        maxTurns,
        maxMinutes,
        updatedAt: Date.now(),
      });
      const options: BridgeOptions = {
        workerId,
        projectId: worker.projectId,
        tabId: current.id,
        url: current.url,
        maxTurns,
        maxMinutes,
        token: crypto.randomUUID(),
        newChat: current.newChat || current.bindingPending,
        resumeExisting: true,
        lastReceipt: previous?.lastReceipt,
        previousProgress: fresh.bridgeProgress?.find((progress) => progress.workerId === workerId),
      };

      if (resumeParams) {
        options.expectedRun = bridgeResumeSchema.parse(resumeParams).expectedRun;
      }

      if (pendingOwner !== undefined) {
        options.expectedBatchId = worker.queue[0]?.id;
      }

      const runner = createRunner(worker, options, resumeParams);
      runners.set(workerId, runner);
      publish();
      log(
        'bridge.resume',
        `Reconnecting ${workerId.slice(0, 8)} to its existing conversation; nothing is replayed automatically.`,
      );
      void runner.start().catch(() => {});

      return { resumed: true, status: { ...runner.status } };
    } finally {
      releaseStart(workerId, startOwner, reserved);
    }
  }
  async function replyContext(
    workerId: string,
    check: () => void,
  ): Promise<{ worker: Worker; link: ChatLink }> {
    check();

    if (
      controlBusy.has(workerId) ||
      continuing.has(workerId) ||
      starting.has(workerId) ||
      runners.get(workerId)?.status.active
    ) {
      throw new Error('Stop automatic mode before selecting a reply.');
    }

    await loadedLinks;
    check();
    await runners.get(workerId)?.flushed();
    check();
    const fresh = await refreshSnapshot(check);

    if (!matchesBuild(fresh.runtime.version, fresh.runtime.buildId)) {
      throw new Error(hostMismatch(fresh.runtime.version, fresh.runtime.buildId));
    }

    const worker = fresh.workers.find((item) => item.id === workerId);

    if (!worker || worker.control?.mode === 'stopped' || !canUseChat(worker) || worker.queue.length) {
      throw new Error('Resolve pending local work or review this task before selecting another reply.');
    }

    const granted = await chrome.permissions.contains({ origins: chatOrigins });
    check();

    if (!granted) {
      throw new Error('ChatGPT access is needed for the linked conversation.');
    }

    const link = await chats.saved(workerId, false, check);
    check();

    if (!link || link.newChat || !link.url.includes('/c/')) {
      throw new Error('Open this task’s saved conversation first. No other tab will be used.');
    }

    return { worker, link };
  }
  async function previewReply(params: Record<string, unknown>): Promise<ReplyPreview> {
    const { workerId, source, text } = replyPreviewParametersSchema.parse(params);
    const check = startGuard(workerId);
    const { worker, link } = await replyContext(workerId, check);
    const saved = await rpc(
      'worker.bridgeLoad',
      { workerId, expectedRun: taskBoundary(worker) },
      bridgeLoadSchema,
    );
    check();
    const receipt = saved.progress?.lastReceipt;
    let replyTo: string | undefined;
    if (receipt?.expectsReplyTo) {
      replyTo = receipt.exchangeId;
    }
    const view = await pageTransport.request(link.id, {
      op: 'reply',
      token: crypto.randomUUID(),
      url: link.url,
      workerId: worker.id,
      projectId: worker.projectId,
      replyTo,
      expiresAt: Date.now() + 20000,
    });

    check();

    if (view.url !== link.url || view.busy || view.draft || view.ready === false) {
      throw new Error(
        'Wait for the linked chat to finish and keep its composer empty. Nothing was imported.',
      );
    }

    let raw = view.codeReply?.text;

    if (source === 'clipboard') {
      raw = text;
    }

    if (typeof raw !== 'string') {
      let detail =
        'The code widget could not be read directly. Click its Copy code button, then Use copied reply.';

      if (view.codeReplyIssue === 'AMBIGUOUS_REPLIES') {
        detail =
          'Several task replies are visible. Click Copy code on the reply you want, then Use copied reply.';
      }

      throw new Error(detail);
    }

    const envelope = boundReply(raw, worker.id, worker.projectId);
    assertFreshReplyExchange(worker, envelope.replyTo, saved.progress);

    if (
      envelope.replyTo &&
      saved.progress?.lastReceipt?.expectsReplyTo &&
      envelope.replyTo !== saved.progress.lastReceipt.exchangeId
    ) {
      throw new Error(
        'This is a reply to an older exchange. Select the latest reply; no actions were imported.',
      );
    }

    const seen = await rpc('worker.handoffSeen', { workerId, envelopeId: envelope.id }, seenResultSchema);
    check();

    if (seen.seen) {
      throw new Error(
        'This batch was already applied. Use Resume or Continue local work; it will not be applied twice.',
      );
    }

    if (envelope.actions.some((action) => 'base' in action)) {
      const admission = await rpc(
        'worker.validateReply',
        {
          workerId,
          text: JSON.stringify(envelope),
          epoch: worker.control?.epoch ?? 0,
        },
        replyValidationSchema,
      );

      check();

      if (admission.valid !== true) {
        throw new Error(
          admission.issue?.message || 'This reply could not be validated locally. Nothing was imported.',
        );
      }
    }

    const ticket = crypto.randomUUID();
    const expiresAt = Date.now() + 120000;
    const hash = await replyDigest(envelope);
    check();
    replyTickets.issue(
      ticket,
      {
        workerId,
        projectId: worker.projectId,
        goal: worker.goal,
        link,
        envelope,
        hash,
        source,
        expiresAt,
        createdAt: Date.now(),
      },
      worker.control,
    );
    log(
      'bridge.reply.preview',
      `Validated ${source} reply for ${workerId.slice(0, 8)}; ${envelope.actions.length} actions. Awaiting your confirmation.`,
    );

    return {
      ticket,
      workerId,
      taskName: displayTaskName(worker),
      summary: envelope.summary,
      source,
      actions: actionSummary(envelope),
      expiresAt,
    };
  }
  async function confirmReply(rawParams: Record<string, unknown>) {
    const params = replyConfirmationSchema.parse(rawParams);

    const key = params.ticket;
    const ticket = replyTickets.read(key, params.workerId);
    const check = startGuard(ticket.workerId);
    const checkTicket = (): void => {
      check();

      if (replyTickets.read(key, params.workerId) !== ticket) {
        throw new Error('This reply preview was replaced. Read it again before applying.');
      }

      if (snapshot) {
        const current = snapshot.workers.find((worker) => worker.id === ticket.workerId);

        if (!current) {
          throw new Error('The selected task changed. Select the reply again.');
        }

        replyTickets.assertBinding(ticket, current, ticket.link);
      }
    };
    const { worker, link } = await replyContext(ticket.workerId, checkTicket);
    replyTickets.assertBinding(ticket, worker, link);

    if (starting.has(worker.id) || runners.get(worker.id)?.status.active) {
      throw new Error('This task is already starting.');
    }

    chats.reserve(worker.id, link);
    const startOwner = Symbol('reply confirmation');
    starting.set(worker.id, startOwner);

    try {
      // Let the visible payload settle, then compare the exact candidate again.
      if (ticket.source === 'chat') {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, 1800 - (Date.now() - ticket.createdAt))),
        );
      }

      checkTicket();
      const view = await pageTransport.request(link.id, {
        op: 'reply',
        token: crypto.randomUUID(),
        url: link.url,
        workerId: worker.id,
        projectId: worker.projectId,
        replyId: ticket.envelope.id,
        replyTo: ticket.envelope.replyTo,
        expiresAt: Date.now() + 20000,
      });

      checkTicket();

      if (view.url !== link.url || view.busy || view.draft || view.ready === false) {
        throw new Error('The chat changed or is still busy. No actions were imported.');
      }

      if (
        ticket.source === 'chat' &&
        (!view.codeReply ||
          (await replyDigest(boundReply(view.codeReply.text, worker.id, worker.projectId))) !== ticket.hash)
      ) {
        throw new Error('The visible reply changed since the preview. Read it again before applying.');
      }

      checkTicket();
      if (worker.control?.mode === 'fresh') {
        const saved = await rpc(
          'worker.bridgeLoad',
          { workerId: worker.id, expectedRun: taskBoundary(worker) },
          bridgeLoadSchema,
        );
        checkTicket();
        assertFreshReplyExchange(worker, ticket.envelope.replyTo, saved.progress);
      }

      // A clipboard choice is explicitly selected by the user. It intentionally
      // does not require the broken role/ancestor reader to find the same text.
      const old = links.get(worker.id);
      const maxTurns = Math.min(20, old?.maxTurns ?? 15);
      const maxMinutes = Math.min(60, old?.maxMinutes ?? 30);
      links.set(worker.id, {
        ...link,
        projectId: worker.projectId,
        maxTurns,
        maxMinutes,
        updatedAt: Date.now(),
      });
      await links.flush(true);
      checkTicket();
      await runners.get(worker.id)?.stop('Using the reply selected by you.');
      checkTicket();
      replyTickets.consume(key);
      const runner = createRunner(worker, {
        workerId: worker.id,
        projectId: worker.projectId,
        tabId: link.id,
        url: link.url,
        maxTurns,
        maxMinutes,
        token: crypto.randomUUID(),
        resumeExisting: true,
        lastReceipt: old?.lastReceipt,
      });
      runners.set(worker.id, runner);
      publish();
      await runner.startWithReply(JSON.stringify(ticket.envelope), link.url);

      return { ...runner.status };
    } finally {
      releaseStart(worker.id, startOwner, link.id);
    }
  }
  async function changeRun(method: 'stop' | 'steer', params: Record<string, unknown>) {
    if (method === 'stop') {
      haltParametersSchema.parse(params);
    } else {
      steeringParametersSchema.parse(params);
    }

    const workerId = workerParametersSchema.parse(params).workerId;

    if (controlBusy.has(workerId)) {
      throw new Error('This task is already stopping or steering.');
    }

    controlBusy.add(workerId);

    // Stop is immediate; valid Steer supersedes Start only after local selection validation.
    if (method === 'stop') {
      startRevisions.set(workerId, (startRevisions.get(workerId) ?? 0) + 1);
      replyTickets.revoke(workerId);
    }

    let runner = runners.get(workerId);
    let stopping: Promise<unknown> | undefined;
    let generation: Promise<unknown> | undefined;

    try {
      if (method === 'steer') {
        const validation = await rpc(
          'worker.steerValidate',
          { ...params, workerId },
          steeringValidationSchema,
        );

        if (validation.alreadyApplied) {
          return { ready: true, alreadyApplied: true };
        }

        startRevisions.set(workerId, (startRevisions.get(workerId) ?? 0) + 1);
        replyTickets.revoke(workerId);
        runner = runners.get(workerId);
      }

      followupArmed.delete(workerId);
      let reason = 'Stopped by you. Completed work is kept.';
      let nativeMethod = 'worker.stop';
      let detail = 'Run stopped. No queued plan or stale reply will be resumed.';
      let nativeParams: Record<string, unknown> = {
        ...params,
        workerId,
        id: crypto.randomUUID(),
      };

      if (typeof params.id === 'string') {
        nativeParams.id = params.id;
      }

      if (method === 'steer') {
        reason = 'Steering to your new instruction…';
        nativeMethod = 'worker.steer';
        detail = 'Old pending plan retired. Continuing with the steering instruction.';
        nativeParams = { ...params, workerId };
      }

      // Invalidate the runner and stop the host concurrently; host epochs fence in-flight mutations.
      stopping = runner?.stop(reason);
      generation = runner?.interruptGeneration();
      const result = await rpc(nativeMethod, nativeParams);
      await Promise.allSettled([stopping, generation]);
      await runner?.settled();
      runners.delete(workerId);

      replyTickets.revoke(workerId);

      await refreshSnapshot();
      publish();
      log('control.' + method, detail);

      return result;
    } finally {
      await Promise.allSettled([stopping, generation]);
      controlBusy.delete(workerId);
    }
  }
  async function startChat(params: BridgeStartOptions, admission: TaskAdmission): Promise<BridgeStartResult> {
    const { workerId, maxTurns, maxMinutes } = params;
    const check = admission.check;
    check();

    if (runBusy(workerId)) {
      throw new Error('This task is already starting, running, or watching for a reply.');
    }

    const startOwner = Symbol('chat start');
    starting.set(workerId, startOwner);
    let reserved: number | undefined;

    try {
      await dependencies.ready();
      check();
      await loadedLinks;
      check();
      // Creation replies precede the host's debounced snapshot. The one-click
      // create/start path must read current state, not the stale UI cache.
      const initialState = await refreshSnapshot(check, admission);
      check();
      requireChatStartWorker(initialState, workerId);
      const granted = await chrome.permissions.contains({ origins: chatOrigins });
      check();
      await admission.verify();
      check();

      if (!granted) {
        throw new Error('ChatGPT access was not granted. No chat was changed.');
      }
      let selected: ChatLink | undefined;
      const checkpoint = await rpc('worker.bridgeLoad', { workerId }, bridgeLoadSchema);
      check();
      await admission.verify();
      check();
      const existing = checkpoint.progress;

      // Start on an existing exchange is continuation, even when the UI is
      // stale or the first conversation is still being assigned its URL.
      const previousLink = links.get(workerId);
      const requiresSavedChat =
        checkpoint.importedCount > 0 ||
        !!previousLink?.lastReceipt ||
        !!previousLink?.confirmedBootstrapDraft ||
        (!!existing && !isUnsentBootstrap(existing));
      if (requiresSavedChat) {
        selected = await chats.saved(workerId, true, check, existing?.conversationUrl);

        if (!selected) {
          throw new Error(
            'This task already has saved chat work. Reopen its original conversation and use Resume. Nothing was sent to a new chat.',
          );
        }
      } else if (params.newChat === true && params.tabId === undefined) {
        selected = await chats.fresh(workerId, check);
        reserved = selected.id;
      } else {
        const tabId = params.tabId;

        if (tabId === undefined || !Number.isSafeInteger(tabId)) {
          throw new Error('Choose a chat, or use a new one.');
        }

        selected = chatChoice(await chrome.tabs.get(tabId));
      }

      check();

      if (!selected) {
        throw new Error('The selected page is not a ChatGPT chat.');
      }

      chats.reserve(workerId, selected);
      reserved = selected.id;
      const fresh = await refreshSnapshot(check, admission);
      check();
      const worker = requireChatStartWorker(fresh, workerId);
      const started: StartedChat = {
        identity: {
          admissionId: crypto.randomUUID(),
          expectedRun: { runId: worker.runId, epoch: worker.control?.epoch ?? 0 },
        },
        cleanupRequested: false,
      };
      if (params.newChat === true && params.tabId === undefined && !requiresSavedChat) {
        selected.automaticStart = started.identity.expectedRun;
      }
      const runner = createRunner(worker, {
        workerId,
        projectId: worker.projectId,
        tabId: selected.id,
        url: selected.url,
        maxTurns,
        maxMinutes,
        token: crypto.randomUUID(),
        newChat: selected.newChat || selected.bindingPending,
        resumeExisting: !!existing,
        lastReceipt: links.get(workerId)?.lastReceipt,
        previousProgress: fresh.bridgeProgress?.find((progress) => progress.workerId === workerId),
      });
      runners.set(workerId, runner);
      startedChats.set(runner, started);
      links.set(workerId, {
        ...selected,
        projectId: worker.projectId,
        maxTurns,
        maxMinutes,
        updatedAt: Date.now(),
      });
      publish();
      // Do not hold the UI request hostage while the page loads. Progress and
      // any failure are published by the runner on the main task screen.
      void runner.start().catch(() => {});

      return {
        ...runner.status,
        admissionId: started.identity.admissionId,
        expectedRun: { ...started.identity.expectedRun },
      };
    } finally {
      releaseStart(workerId, startOwner, reserved);
    }
  }

  async function stopStarted(params: BridgeStopStartedParameters): Promise<BridgeStopStartedResult> {
    const { workerId, admissionId, expectedRun } = params;
    const runner = runners.get(workerId);
    const started = runner && startedChats.get(runner);

    if (!runner || !started || starting.has(workerId)) {
      return { stopped: false };
    }

    const generation = admissionGeneration;
    const revision = startRevisions.get(workerId) ?? 0;
    const ownsRunner = (): boolean => {
      if (
        dependencies.blocked() ||
        disposed ||
        admissionGeneration !== generation ||
        (startRevisions.get(workerId) ?? 0) !== revision ||
        controlBusy.has(workerId) ||
        runners.get(workerId) !== runner ||
        started.cleanupRequested ||
        (!runner.status.active && !runner.status.monitoring) ||
        started.identity.admissionId !== admissionId ||
        !matchesTaskBoundary(started.identity.expectedRun, expectedRun)
      ) {
        return false;
      }

      if (
        snapshot &&
        !matchesTaskBoundary(
          taskBoundary(snapshot.workers.find((worker) => worker.id === workerId)),
          expectedRun,
        )
      ) {
        return false;
      }

      return true;
    };

    if (!ownsRunner()) {
      return { stopped: false };
    }

    const cleanupOwner = Symbol('started chat cleanup');
    starting.set(workerId, cleanupOwner);

    try {
      await dependencies.ready();

      if (!ownsRunner()) {
        return { stopped: false };
      }

      const fresh = await readTaskState();
      const worker = fresh.workers.find((worker) => worker.id === workerId);

      if (
        !ownsRunner() ||
        !matchesTaskBoundary(taskBoundary(worker), expectedRun) ||
        worker?.control?.mode === 'stopped'
      ) {
        return { stopped: false };
      }

      snapshot = fresh;
      started.cleanupRequested = true;
      followupArmed.delete(workerId);
      await runner.stop('The task dialog closed before its chat start completed.');

      return { stopped: true };
    } finally {
      releaseStart(workerId, cleanupOwner, undefined);
    }
  }

  async function request(method: string, params: Record<string, unknown>) {
    validateViewParams(method, params);

    if (method === 'bridge.start') {
      const reviewed = bridgeStartSchema.parse(params);

      return startChat(reviewed, admitTask(reviewed.workerId, reviewed.expectedRun, 'start'));
    }

    if (method === 'bridge.stopStarted') {
      return stopStarted(bridgeStopStartedSchema.parse(params));
    }

    if (method === 'bridge.continuePending') {
      const reviewed = bridgeContinuePendingSchema.parse(params);

      return continuePending(params, admitTask(reviewed.workerId, reviewed.expectedRun));
    }

    let admission: TaskAdmission | undefined;
    let forwardedTask: ForwardedTaskParameters | undefined;

    if (method === 'bridge.resume' || method === 'bridge.resend') {
      let reviewed = bridgeResumeSchema.parse(params);

      if (method === 'bridge.resend') {
        reviewed = bridgeResendSchema.parse(params);
      }

      if (method === 'bridge.resume') {
        params = resumeParameters(params, reviewed.expectedRun);
      }

      admission = admitTask(reviewed.workerId, reviewed.expectedRun);
    } else if (
      ['worker.import', 'worker.run', 'worker.resume', 'worker.approve', 'worker.setupDecision'].includes(
        method,
      )
    ) {
      forwardedTask = forwardedTaskParametersSchema.parse(params);
      let intent: 'continue' | 'delivery' = 'continue';

      if (method === 'worker.run' && (params.envelopeId !== undefined || params.envelopeHash !== undefined)) {
        handoffDeliveryParametersSchema.parse(params);
        intent = 'delivery';
      }

      if (
        forwardedTask.expectedRun &&
        forwardedTask.epoch !== undefined &&
        forwardedTask.epoch !== forwardedTask.expectedRun.epoch
      ) {
        throw new Error(
          'The supplied epoch does not match the reviewed task boundary. Review the task again.',
        );
      }

      admission = admitTask(forwardedTask.workerId, forwardedTask.expectedRun, intent);
      params = { ...params, ...forwardedTask };
    }

    await dependencies.ready();
    checkAvailable();
    admission?.check();

    switch (method) {
      case 'rewrite.start':
        return rewrites.start(params.request, params.consent);
      case 'rewrite.read':
        return rewrites.read(params.id);
      case 'rewrite.cancel':
        return rewrites.cancel(params.id);

      case 'bridge.lastPrompt': {
        const runner = runners.get(workerParametersSchema.parse(params).workerId);

        if (!runner) {
          throw Error('Resume this task’s saved chat first.');
        }

        return runner.recoveryPrompt();
      }

      case 'bridge.resend': {
        const reviewed = bridgeResendSchema.parse(params);
        await refreshSnapshot(admission?.check, admission);
        admission?.check();
        const runner = runners.get(reviewed.workerId);

        if (!runner) {
          throw new Error('Resume this task’s saved chat first.');
        }

        return runner.resendPrompt(reviewed.confirm, reviewed.expectedPrompt);
      }

      case 'bridge.halt': {
        return changeRun('stop', params);
      }

      case 'bridge.steer': {
        await changeRun('steer', params);
        const workerId = workerParametersSchema.parse(params).workerId;
        const worker = snapshot?.workers.find((worker) => worker.id === workerId);

        if (followupRequestSchema.parse(params.request).autoStart !== false) {
          followupArmed.add(workerId);
        }

        if (worker?.mode === 'local') {
          return rpc('worker.run', { workerId, epoch: worker.control?.epoch });
        }

        const result = await resumeChat(workerId);

        if (!result.resumed) {
          throw new Error('Steering saved. Open the task’s saved chat and choose Continue fresh.');
        }

        return result;
      }

      case 'bridge.continueFresh': {
        const workerId = workerParametersSchema.parse(params).workerId;

        if (continuing.has(workerId) || runBusy(workerId)) {
          throw new Error('Stop the current task run or reply watch before changing run state.');
        }

        continuing.add(workerId);
        const check = startGuard(workerId);

        try {
          await runners.get(workerId)?.settled();
          check();
          await rpc('worker.continueFresh', { ...params, workerId });
          check();
          runners.delete(workerId);
          const fresh = await refreshSnapshot(check);
          const worker = fresh.workers.find((worker) => worker.id === workerId);

          if (worker?.mode === 'local') {
            return rpc('worker.run', { workerId, epoch: worker.control?.epoch });
          }

          const result = await resumeChat(workerId);

          if (!result.resumed) {
            throw new Error('Open the saved conversation to continue fresh. Your work is preserved.');
          }

          return result;
        } finally {
          continuing.delete(workerId);
        }
      }

      case 'bridge.pause': {
        const workerId = workerParametersSchema.parse(params).workerId;
        followupArmed.delete(workerId);
        const runner = runners.get(workerId);

        const disabled = disableReplyRecovery(workerId);
        if (runner?.status.active || runner?.status.monitoring) {
          await runner.stop('Paused by you. Resume keeps the current plan.');
        } else {
          await rpc('worker.pause', { ...params, workerId });
        }
        await disabled;
        return { paused: true };
      }

      case 'workspace.read':
      case 'workspace.action': {
        let currentSnapshot = snapshot;
        let action: ReturnType<typeof validateWorkspaceAction> | undefined;

        if (method === 'workspace.action') {
          action = validateWorkspaceAction(params.action);
        }

        // A creation response arrives before the throttled status broadcast.
        // Open the new record from fresh host state, not an outdated tab catalog.
        let missing = false;

        if (action?.type === 'open') {
          if (action.kind === 'project') {
            missing = !currentSnapshot?.projects.some((project) => project.id === action.id);
          } else {
            missing = !currentSnapshot?.workers.some((worker) => worker.id === action.id);
          }
        }

        if (!currentSnapshot || missing) {
          currentSnapshot = await refreshSnapshot();
        }

        if (method === 'workspace.read') {
          return workspace.sync(catalog(currentSnapshot));
        }

        const next = await workspace.dispatch(action, catalog(currentSnapshot));
        let kind = '';

        if (action && 'kind' in action) {
          kind = action.kind ?? '';
        }

        log(
          'workspace.action',
          `${action?.type || 'action'} ${kind}; saved revision ${next.revision}. Task execution unchanged.`,
        );

        return next;
      }

      case 'notifications.get':
        return notifications.read();
      case 'notifications.set':
        return notifications.set(params);

      case 'worker.followup': {
        const reviewed = followupParametersSchema.parse(params);
        const workerId = reviewed.workerId;
        const generation = admissionGeneration;
        const startRevision = startRevisions.get(workerId) ?? 0;
        const boundary = taskBoundary(snapshot?.workers.find((worker) => worker.id === workerId));
        const followup = await rpc('worker.followup', params, followupSchema);
        checkAvailable();

        if (
          generation !== admissionGeneration ||
          startRevision !== (startRevisions.get(workerId) ?? 0) ||
          (boundary &&
            !matchesTaskBoundary(
              taskBoundary(snapshot?.workers.find((worker) => worker.id === workerId)),
              boundary,
            ))
        ) {
          throw new Error(
            'The task changed while saving this follow-up. It may already be queued, but it was not started. Check saved follow-ups before repeating it.',
          );
        }

        if (followup.workerId !== workerId || followup.id !== reviewed.request.id) {
          throw new Error(
            'Miter could not confirm the saved follow-up for this task. Check saved follow-ups before repeating it.',
          );
        }

        if (reviewed.request.autoStart) {
          followupArmed.add(workerId);
          await kickFollowup(workerId, params);
        }

        return followup;
      }

      case 'worker.followupStart': {
        const { workerId } = workerParametersSchema.parse(params);
        followupArmed.add(workerId);

        return kickFollowup(workerId, params);
      }

      case 'debug.clear': {
        diagnostics.clear();

        return { cleared: true };
      }

      case 'debug.read':
        return diagnostics.read();
      case 'bridge.replyPreview':
        return previewReply(params);
      case 'bridge.replyApply':
        return confirmReply(params);
      case 'bridge.list':
        return bridgeStates();
      case 'bridge.lastChat':
        return (
          (await chats.saved(workerParametersSchema.parse(params).workerId, false, checkAvailable)) || null
        );
      case 'bridge.resume':
        return resumeChat(bridgeResumeSchema.parse(params).workerId, admission, undefined, params);

      case 'bridge.extend': {
        const workerId = workerParametersSchema.parse(params).workerId;

        if (params.confirm !== true || continuing.has(workerId) || runBusy(workerId)) {
          throw new Error('Pause and explicitly authorize more task time first.');
        }

        continuing.add(workerId);
        const check = startGuard(workerId);

        try {
          await runners.get(workerId)?.flushed();
          check();
          await rpc('worker.bridgeExtend', { ...params, workerId });
          check();
          await rpc('worker.continueFresh', { ...params, workerId });
          check();

          return await resumeChat(workerId);
        } finally {
          continuing.delete(workerId);
        }
      }

      case 'bridge.openChat': {
        const workerId = workerParametersSchema.parse(params).workerId;
        const current = snapshot?.workers.find((worker) => worker.id === workerId);
        const check = admitTask(workerId, taskBoundary(current)).check;
        let tabId = await chats.signInTab(workerId, check);

        if (tabId === undefined) {
          tabId = (await chats.saved(workerId, true, check))?.id;
        }
        check();

        if (tabId === undefined) {
          throw new Error('No saved conversation yet. Start the task first.');
        }

        await chrome.tabs.update(tabId, { active: true });
        check();
        const tab = await chrome.tabs.get(tabId);
        check();

        if (tab.windowId !== undefined) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }

        return { opened: true };
      }

      case 'bridge.tabs': {
        if (!(await chrome.permissions.contains({ origins: chatOrigins }))) {
          throw new Error('Allow ChatGPT access before choosing a chat.');
        }

        return (await chrome.tabs.query({ url: chatOrigins })).map(chatChoice).filter(Boolean);
      }

      case 'bridge.newChat': {
        const granted = await chrome.permissions.contains({ origins: chatOrigins });
        checkAvailable();

        if (!granted) {
          throw new Error('Allow ChatGPT access before creating a chat.');
        }

        const tab = await chrome.tabs.create({
          url: chatgptProvider.startUrl + '/',
          active: true,
        });

        if (tab.id === undefined) {
          throw new Error('Chrome did not return the new chat tab.');
        }

        return {
          id: tab.id,
          providerId: chatgptProvider.id,
          title: 'New ChatGPT chat',
          url: chatgptProvider.startUrl,
          newChat: true,
        };
      }

      case 'bridge.stop': {
        const { workerId } = workerParametersSchema.parse(params);
        followupArmed.delete(workerId);
        await Promise.all([disableReplyRecovery(workerId), runners.get(workerId)?.stop()]);

        return { stopped: true };
      }
      case 'worker.pause':
      case 'worker.cancel': {
        const { workerId } = workerParametersSchema.parse(params);
        followupArmed.delete(workerId);
        await Promise.all([disableReplyRecovery(workerId), runners.get(workerId)?.stop('Stopped by you')]);
        break;
      }
      case 'worker.rollback':
      case 'worker.restoreFile': {
        if (method === 'worker.restoreFile') {
          restoreFileParametersSchema.parse(params);
        } else {
          rollbackParametersSchema.parse(params);
        }

        const { workerId } = workerParametersSchema.parse(params);
        await Promise.all([disableReplyRecovery(workerId), runners.get(workerId)?.stop('Stopped by you')]);
        break;
      }
      case 'worker.import': {
        const { workerId } = workerParametersSchema.parse(params);
        const status = runners.get(workerId)?.status;

        if (status?.active || status?.monitoring) {
          throw new Error('Stop automatic mode before manually importing a handoff.');
        }

        break;
      }
    }

    if (!forwardedMethods.has(method)) {
      throw new Error('Unsupported UI request.');
    }

    if (forwardedTask && admission) {
      const fresh = await admission.verify();
      const worker = fresh.workers.find((worker) => worker.id === forwardedTask.workerId);

      if (!worker) {
        throw new Error('Task not found. Review the current task before continuing.');
      }

      const currentEpoch = worker.control?.epoch ?? 0;
      const epoch = forwardedTask.epoch ?? forwardedTask.expectedRun?.epoch ?? currentEpoch;

      if (epoch !== currentEpoch) {
        throw new Error(
          'This operation belongs to an earlier run epoch. Review the current task before continuing.',
        );
      }

      if (method === 'worker.run' || method === 'worker.resume') {
        completedPreviews.arm(worker);
      }
      if (method !== 'worker.setupDecision') {
        params = { ...params, epoch };
      }
    }

    return rpc(method, params);
  }

  async function openNotification(workerId: string): Promise<void> {
    const revision = ++notificationOpenRevision;
    const generation = admissionGeneration;
    const check = () => {
      checkAvailable();
      if (revision !== notificationOpenRevision || generation !== admissionGeneration) {
        throw new Error('This notification was superseded. Open the task from Miter.');
      }
    };
    check();
    const current = snapshot ?? (await readTaskState());
    check();

    if (!current.workers.some((worker) => worker.id === workerId)) {
      throw new Error('The notified task no longer exists.');
    }

    await workspace.dispatch({ type: 'open', kind: 'task', id: workerId }, catalog(current));
    check();
    const workspaceURL = chrome.runtime.getURL('workspace.html');
    const target = workspaceURL + '?task=' + encodeURIComponent(workerId);
    const opened = (await chrome.tabs.query({ url: workspaceURL + '*' })).find(
      (tab) => tab.id !== undefined && (tab.url || tab.pendingUrl || '').split(/[?#]/)[0] === workspaceURL,
    );
    check();
    let tab: chrome.tabs.Tab | undefined;

    if (opened?.id !== undefined) {
      tab = await chrome.tabs.update(opened.id, { url: target, active: true });
      check();

      if (!tab) {
        tab = await chrome.tabs.get(opened.id);
        check();
      }
    } else {
      tab = await chrome.tabs.create({ url: target, active: true });
      check();
    }

    if (tab?.id === undefined) {
      throw new Error('Chrome did not return the task workspace tab. Click the notification to retry.');
    }

    if (tab.windowId !== undefined && tab.windowId >= 0) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  }

  function capturePageIds(ids: Set<number>): void {
    for (const [, link] of links.entries()) {
      ids.add(link.id);
    }

    for (const runner of runners.values()) {
      ids.add(runner.status.tabId);
    }

    for (const tabId of rewrites.tabIds) {
      ids.add(tabId);
    }
  }

  function invalidateStarts(): void {
    admissionGeneration++;
    followupArmed.clear();
    replyTickets.clear();

    for (const workerId of new Set([...starting.keys(), ...continuing, ...runners.keys()])) {
      startRevisions.set(workerId, (startRevisions.get(workerId) ?? 0) + 1);
    }

    rewrites.cancelAll();
  }

  return {
    request,
    openNotification,
    capturePageIds,
    forgetPage: (tabId: number) => pageTransport.forget(tabId),
    initialMessages(): unknown[] {
      const messages: unknown[] = [
        { event: 'debug', data: diagnostics.read() },
        { event: 'bridges', data: bridgeStates() },
      ];
      const savedWorkspace = workspace.peek();

      if (savedWorkspace) {
        messages.push({ event: 'workspace', data: savedWorkspace });
      }

      if (snapshot) {
        messages.push({ event: 'snapshot', data: snapshot });
      }

      return messages;
    },
    update(next: Snapshot): void {
      if (disposed) {
        return;
      }
      if (!matchesBuild(next.runtime.version, next.runtime.buildId)) {
        snapshot = next;
        broadcast({ event: 'snapshot', data: next });
        invalidateStarts();
        return;
      }
      if (dependencies.blocked()) {
        return;
      }
      snapshot = next;
      completedPreviews.update(next);
      reattachWaitingReplies();
      notifications.snapshot(next);
      broadcast({ event: 'snapshot', data: next });
      publish();
      syncWorkspace(next);
    },
    disconnected(): void {
      hostConnection = Symbol('host connection');
      for (const runner of runners.values()) {
        if (runner.detachSetupApproval()) {
          runners.delete(runner.status.workerId);
          continue;
        }
        if (!runner.hostDisconnected()) {
          void runner.stop(
            'The local host disconnected during an operation. Its outcome needs checking. Open Setup to reconnect, then Resume the saved task; nothing was replayed.',
            'error',
            'HOST_DISCONNECTED',
          );
        }
      }
      snapshot = undefined;
    },
    async stop(): Promise<void> {
      invalidateStarts();
      await waitFor(
        Promise.all([...runners.values()].map((runner) => runner.stop('Clearing all Miter data.'))),
        'Chat workers',
        45000,
      );
    },
    async quiesce(): Promise<void> {
      invalidateStarts();
      await waitFor(
        Promise.all([...runners.values()].map((runner) => runner.settled())),
        'Chat worker checkpoints',
        45000,
      );
      await rewrites.quiesce();
      await Promise.all([
        workspace.quiesce(),
        links.quiesce(),
        notifications.quiesce(),
        completedPreviews.quiesce(),
      ]);
    },
    releaseResources(): Promise<void> {
      return waitFor(tabLiveness.releaseAll(), 'Chat tab resource policy', 15000);
    },
    clear(): void {
      admissionGeneration++;
      runners.clear();
      rewrites.clear();
      starting.clear();
      continuing.clear();
      controlBusy.clear();
      startRevisions.clear();
      replyRecoveryChecks.clear();
      startupDestinationsHandled.clear();
      restoringTabUrls.clear();
      browserStartedAt = undefined;
      chats.clearReservations();
      replyTickets.clear();
      followupStarting.clear();
      notifications.clear();
      completedPreviews.clear();
      snapshot = undefined;
      diagnostics.clear();
    },
    browserStartup(): void {
      browserStartedAt = Date.now();
      replyRecoveryChecks.clear();
      reattachWaitingReplies();
    },
    tabRemoved(tabId: number, info?: chrome.tabs.OnRemovedInfo): void {
      chats.forgetCreatedTab(tabId);
      pageTransport.forget(tabId);

      const closedUrl = restoringTabUrls.get(tabId);
      restoringTabUrls.delete(tabId);
      if (info && !info.isWindowClosing) {
        // Even before the first recovery tick, an explicitly closed task tab
        // must stay closed on this and subsequent browser starts.
        void links.ready
          .then(async () => {
            if (disposed || dependencies.blocked()) {
              return;
            }
            for (const [workerId, link] of links.entries()) {
              if (
                link.receiptRun !== null &&
                link.lastReceipt &&
                (link.id === tabId || link.url === closedUrl)
              ) {
                await disableReplyRecovery(workerId);
              }
            }
          })
          .catch((error) => log('bridge.storage.error', errorMessage(error)));
      }
      for (const runner of runners.values()) {
        if (runner.status.tabId === tabId) {
          if (info?.isWindowClosing && runner.detachSavedWait()) {
            runners.delete(runner.status.workerId);
            publish();
            continue;
          }
          void runner.stop('The task’s chat was closed. Reopen a chat before resuming.');
        }
      }
    },
    tabUpdated(tabId: number, change: chrome.tabs.OnUpdatedInfo, tab?: chrome.tabs.Tab): void {
      if (change.status === 'loading') {
        pageTransport.forget(tabId);
      }

      if (dependencies.blocked() || disposed) {
        return;
      }

      if (change.url !== undefined) {
        if (!chatgptProvider.origins.some((origin) => change.url === origin + '/')) {
          chats.forgetCreatedTab(tabId);
        }
        const current = chatChoice({ id: tabId, url: change.url });

        for (const runner of runners.values()) {
          if (
            runner.status.tabId === tabId &&
            !runner.status.bindingPending &&
            current?.url !== runner.status.url
          ) {
            void runner.stop(
              'The linked tab left the reviewed conversation. Resume its saved chat before continuing.',
              'error',
              'NAVIGATED',
            );
          }
        }
      }

      if (change.status === 'complete' || change.url !== undefined) {
        const restored = chatChoice({ id: tabId, url: change.url || tab?.pendingUrl || tab?.url });
        if (browserStartedAt !== undefined && Date.now() - browserStartedAt <= 120000) {
          if (restored && !restored.newChat) {
            restoringTabUrls.set(tabId, restored.url);
          } else if (change.url !== undefined) {
            restoringTabUrls.delete(tabId);
          }
        } else {
          restoringTabUrls.clear();
        }
        for (const [workerId] of replyRecoveryChecks) {
          const link = links.get(workerId);
          if (link && (link.id === tabId || restored?.url === link.url)) {
            replyRecoveryChecks.delete(workerId);
          }
        }
      }

      // No tab activation or focus is used to deliver a prepared prompt.
      if (change.status === 'complete' || 'frozen' in change || 'discarded' in change) {
        for (const runner of runners.values()) {
          if (runner.status.tabId === tabId) {
            void runner.tick().catch((error) => log('bridge.tick.error', errorMessage(error)));
          }
        }
      }
    },
    tick(): void {
      if (dependencies.blocked() || disposed) {
        return;
      }

      reattachWaitingReplies();
      for (const runner of runners.values()) {
        void runner.tick().catch((error) => log('bridge.tick.error', errorMessage(error)));
      }

      for (const workerId of followupArmed) {
        void kickFollowup(workerId).catch(() => {});
      }
    },
    dispose(): void {
      disposed = true;
      invalidateStarts();
      void tabLiveness.releaseAll().catch(() => {});

      for (const runner of runners.values()) {
        if (!runner.detachSavedWait()) {
          void runner.stop('Extension shutdown').catch(() => {});
        }
      }
    },
  };
}
