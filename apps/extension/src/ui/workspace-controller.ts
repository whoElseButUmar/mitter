import { createSignal, createMemo, createEffect, onMount, onCleanup, batch } from 'solid-js';

import {
  taskBoundarySchema,
  type Snapshot,
  type TaskBoundary,
  type Worker,
} from '../../../../packages/protocol/src/index';
import { reviewedTaskBoundary } from './task-boundary';
import { parseProposalEnvelope } from '../../../../packages/protocol/src/proposal';
import { exceedsHandoffBytes } from '../../../../packages/protocol/src/reply-json';
import { DEFAULT_SETTINGS } from '../../../../packages/protocol/src/model-settings';
import type { RewriteRequest } from '../../../../packages/protocol/src/rewrite';
import type { Followup } from '../../../../packages/protocol/src/requests';
import type { BridgeStatus } from '../../../../packages/bridge/src/index';
import { taskPresentation } from '../../../../packages/bridge/src/presentation';
import { preferReplyRecovery } from '../../../../packages/bridge/src/reply-recovery';
import type { DebugEntry } from '../../../../packages/bridge/src/diagnostics';
import { ToastCenter, mountToasts } from '../../../../packages/ui/src/toast';
import { emptyWorkspace, currentTask, type WorkspaceState } from '../../../../packages/ui/src/workspace';
import { closeActivePopover } from '../../../../packages/ui/src/popover';
import { HostClient } from '../client';
import type { ChangeRequest } from '../FileViewer';
import { followupSchema } from '../schemas/host-results';
import { workspaceStateSchema, notificationPreferencesSchema } from '../schemas/messages';
import type { AuxiliaryMessage, NotificationPreferences } from '../schemas/messages';
import { errorMessage } from '../schemas/primitives';
import { createTaskSound } from './task-sound';
import { createWorkspaceTabs } from './workspace-tabs';
import { TaskOutput } from './task-output';
import { performDraftRewrite } from './rewrite-draft';
import {
  textResultSchema,
  resumeResultSchema,
  continuePendingResultSchema,
  resendResultSchema,
  resendNotice,
} from './rpc-results';
import { callResult } from './rpc';

const initial: Snapshot = {
  protocol: 'mitter/1',
  projects: [],
  workers: [],
  events: [],
  settings: { ...DEFAULT_SETTINGS },
  runtime: { node: '', workflow: '', models: 'Not connected' },
};

const actionNotices: Record<string, string> = {
  'worker.openFile': 'Opened file.',
  'worker.reveal': 'Opened folder.',
  'project.reveal': 'Opened folder.',
  'worker.cancel': 'Task cancelled. Existing files are kept.',
  'worker.rollback': 'File edits restored.',
  'bridge.stop': 'Task paused. Progress is saved.',
  'bridge.pause': 'Task paused. Resume keeps the current plan.',
  'bridge.halt': 'Stopped. Completed work kept; pending plan retired.',
  'bridge.continueFresh': 'Continuing from current files with a fresh plan.',
  'worker.pause': 'Task paused.',
  'bridge.openChat': 'Opened linked chat.',
};

export function createWorkspaceController() {
  const [snapshot, setSnapshot] = createSignal<Snapshot>(initial);
  const [navigation, setNavigation] = createSignal(emptyWorkspace());
  const [connected, setConnected] = createSignal(false);
  const [connectionError, setConnectionError] = createSignal('');
  const selected = createMemo(() => currentTask(navigation()));

  // New-task forms capture their project when opened, never when submitted.
  const [formProjectId, setFormProjectId] = createSignal('');
  const [modal, setModal] = createSignal('');
  const [textValue, setTextValue] = createSignal('');
  const [handoff, writeHandoff] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  const [terminalMounted, setTerminalMounted] = createSignal(false);
  const [debugOpen, setDebugOpen] = createSignal(false);
  const [logs, setLogs] = createSignal<DebugEntry[]>([]);
  const [bridges, setBridges] = createSignal<BridgeStatus[]>([]);
  const [followupHistory, setFollowupHistory] = createSignal<Followup[]>([]);
  const [notifications, setNotifications] = createSignal<NotificationPreferences>({
    enabled: false,
    sound: false,
  });
  const [automationTarget, setAutomationTarget] = createSignal<{
    workerId: string;
    expectedRun: TaskBoundary;
  }>();
  const [replyWorker, setReplyWorker] = createSignal('');
  const [resendWorker, setResendWorker] = createSignal('');
  let alive = true;
  let dialogGeneration = 0;
  let dialogRead = 0;
  let runGeneration = 0;
  let handoffRevision = 0;
  let clipboardRead = 0;
  let activeMutation:
    | { token: symbol; bindRun: boolean; workerId: string | undefined; expectedRun: TaskBoundary | undefined }
    | undefined;
  let resendTarget:
    | {
        workerId: string;
        text: string;
        expectedRun: TaskBoundary;
        dialogGeneration: number;
        runGeneration: number;
      }
    | undefined;
  const dialogScope = createMemo(() => navigation().revision + ':' + modal());

  // Returning to the same task or dialog does not revive a read begun before leaving it.
  createEffect(() => {
    dialogScope();
    dialogGeneration++;
    activeMutation = undefined;
    setBusy(false);
  });

  const beginDialogRead = () => {
    if (!alive) {
      return undefined;
    }
    const operation = ++dialogRead;
    const generation = dialogGeneration;
    return () => alive && operation === dialogRead && generation === dialogGeneration;
  };

  const setHandoff = (value: string) => {
    if (alive) {
      handoffRevision++;
      writeHandoff(value);
    }
  };

  const beginMutation = (bindRun = true, task?: Worker) => {
    if (!alive || busy()) {
      return undefined;
    }
    let expectedRun: TaskBoundary | undefined;
    if (task) {
      try {
        expectedRun = reviewedTaskBoundary(task);
      } catch (error) {
        setNotice(errorMessage(error));
        return undefined;
      }
    }
    const token = Symbol('workspace mutation');
    const dialog = dialogGeneration;
    const run = runGeneration;
    activeMutation = { token, bindRun, workerId: task?.id, expectedRun };
    setBusy(true);

    const targetIsCurrent = () => {
      if (!bindRun || !task || !expectedRun) {
        return true;
      }
      const current = snapshot().workers.find((entry) => entry.id === task.id);
      return current?.runId === expectedRun.runId && (current.control?.epoch ?? 0) === expectedRun.epoch;
    };

    return {
      expectedRun,
      isCurrent: () =>
        alive &&
        activeMutation?.token === token &&
        dialog === dialogGeneration &&
        (!bindRun || run === runGeneration) &&
        targetIsCurrent(),
      finish: () => {
        if (activeMutation?.token === token) {
          activeMutation = undefined;
          setBusy(false);
        }
      },
    };
  };

  const toasts = new ToastCenter();
  const success = (message: string) => toasts.push({ message, kind: 'success' });
  const info = (message: string) => toasts.push({ message, kind: 'info' });

  // Clear calls from existing forms do not erase another operation's feedback.
  const setNotice = (message: string) => {
    if (message) {
      toasts.push({ message, kind: 'error' });
    }
  };

  const playDing = createTaskSound();

  const toggleTerminal = () => {
    setTerminalMounted(true);
    setTerminalOpen((value) => !value);
    setDebugOpen(false);
  };

  const useReply = () => {
    setReplyWorker(selected());
    setModal('reply-recovery');
  };

  const applyNavigation = (next: WorkspaceState) => {
    if (next.revision < navigation().revision) {
      return;
    }

    const previous = selected();
    const priorProject = navigation().projectId;

    batch(() => {
      setNavigation(next);

      if (previous !== currentTask(next) || priorProject !== next.projectId) {
        closeActivePopover(document);
        output.reset();
      }
    });
  };

  const client = new HostClient(
    setSnapshot,
    (ok, error) => {
      setConnected(ok);
      setConnectionError(error ?? '');
    },
    (message: AuxiliaryMessage) => {
      if (message.event === 'debug') {
        setLogs(message.data);
      }
      if (message.event === 'bridges') {
        setBridges(message.data);
      }
      if (message.event === 'notificationSettings' && modal() !== 'notifications') {
        setNotifications(message.data);
      }
      if (message.event === 'ding') {
        void playDing();
      }
      if (message.event === 'workspace') {
        applyNavigation(message.data);
      }
      if (message.event === 'workspaceError') {
        setNotice(message.error);
      }
      if (message.event === 'taskNotification') {
        const notification = message.data;

        if (typeof notification?.workerId === 'string' && typeof notification.message === 'string') {
          toasts.push({
            message: notification.message,
            kind: notification.kind,
            key: 'task:' + notification.workerId,
            duration: 8000,
            action: {
              label: 'Open task',
              run: async () => {
                const state = await callResult(rpc, workspaceStateSchema, 'workspace.action', {
                  action: { type: 'open', kind: 'task', id: notification.workerId },
                });
                applyNavigation(state);
                setModal('');
              },
            },
          });
        }
      }
    },
  );
  const rpc = client.request.bind(client);

  const worker = createMemo(() =>
    snapshot().workers.find((task) => task.id === selected() && task.projectId === navigation().projectId),
  );
  const runScope = createMemo(() => {
    const task = worker();
    return JSON.stringify([task?.id, task?.runId, task?.control?.epoch, task?.queue[0]?.id]);
  });
  createEffect(() => {
    runScope();
    runGeneration++;
    if (activeMutation?.bindRun) {
      activeMutation = undefined;
      setBusy(false);
    }
  });

  createEffect(() => {
    const state = snapshot();
    const mutation = activeMutation;
    if (!mutation?.bindRun || !mutation.workerId || !mutation.expectedRun) {
      return;
    }
    const target = state.workers.find((task) => task.id === mutation.workerId);
    if (
      target?.runId !== mutation.expectedRun.runId ||
      (target.control?.epoch ?? 0) !== mutation.expectedRun.epoch
    ) {
      activeMutation = undefined;
      setBusy(false);
    }
  });

  const project = createMemo(() =>
    snapshot().projects.find((projectEntry) => projectEntry.id === navigation().projectId),
  );
  const projectWorkers = createMemo(() =>
    snapshot().workers.filter((task) => task.projectId === navigation().projectId),
  );
  const bridge = createMemo(() => bridges().find((bridgeStatus) => bridgeStatus.workerId === selected()));
  const preferReply = createMemo(() => !bridge()?.active && preferReplyRecovery(bridge()?.errorCode));

  const action = async (method: string, params: Record<string, unknown> = {}) => {
    if (!alive || busy()) {
      return;
    }
    let workerId = selected();
    if ('workerId' in params) {
      if (typeof params.workerId !== 'string' || !params.workerId) {
        setNotice('This action has no valid task target. Reopen its task menu and try again.');
        return;
      }
      workerId = params.workerId;
    }
    const target = snapshot().workers.find((task) => task.id === workerId);
    if ('workerId' in params && !target) {
      setNotice('This task is no longer available. Reopen its task menu before continuing.');
      return;
    }
    const operation = beginMutation(true, target);
    if (!operation) {
      return;
    }

    try {
      const request: Record<string, unknown> = { ...params, workerId };
      if (
        [
          'bridge.resume',
          'bridge.resend',
          'worker.resume',
          'worker.import',
          'worker.run',
          'worker.approve',
        ].includes(method)
      ) {
        if (!operation.expectedRun) {
          throw new Error('This task is no longer available. Reopen its task menu before continuing.');
        }
        if ('expectedRun' in params) {
          const reviewed = taskBoundarySchema.safeParse(params.expectedRun);
          if (!reviewed.success) {
            throw new Error('The reviewed run boundary is invalid. Review this task again.', {
              cause: reviewed.error,
            });
          }
          if (
            reviewed.data.runId !== operation.expectedRun.runId ||
            reviewed.data.epoch !== operation.expectedRun.epoch
          ) {
            throw new Error('This task changed after review. Review its current run before continuing.');
          }
        }
        request.expectedRun = operation.expectedRun;
        if (method === 'bridge.resend' && typeof request.expectedPrompt !== 'string') {
          throw new Error('Review the exact pending prompt before resending it.');
        }
      }
      await rpc(method, request);
      const notice = actionNotices[method];

      if (operation.isCurrent() && notice) {
        success(notice);
      }
    } catch (error) {
      if (operation.isCurrent()) {
        setNotice(errorMessage(error));
        setDebugOpen(true);
      }
    } finally {
      operation.finish();
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      success('Copied to clipboard.');
    } catch {
      setNotice('Clipboard unavailable. Select the text and copy it manually.');
    }
  };

  const output = new TaskOutput({
    snapshot,
    selected,
    worker,
    project,
    connected,
    rpc,
    notice: setNotice,
    success,
    copy,
    action,
    modal,
    setModal,
  });

  const newWorker = (projectId = navigation().projectId) => {
    const projectEntry = snapshot().projects.find((entry) => entry.id === projectId);

    if (!projectEntry) {
      setModal('project');
      return;
    }

    setFormProjectId(projectEntry.id);
    setModal('worker');
  };

  const tabs = createWorkspaceTabs({
    snapshot,
    navigation,
    connected,
    bridges,
    projectWorkers,
    toasts,
    rpc,
    action,
    applyNavigation,
    setNotice,
    success,
    setModal,
    newWorker,
    setView: output.setView,
    setTextValue,
  });

  const rewriteDraft = (request: RewriteRequest, signal: AbortSignal) =>
    performDraftRewrite(request, signal, {
      rpc,
      authorize: () =>
        chrome.permissions.request({ origins: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] }),
    });

  const showResend = async () => {
    const isCurrent = beginDialogRead();
    if (!isCurrent) {
      return;
    }
    const task = worker();
    if (!task) {
      setNotice('This task is no longer available. Open its current task tab before reviewing the prompt.');
      return;
    }
    const id = task.id;
    const run = runGeneration;

    try {
      const expectedRun = reviewedTaskBoundary(task);
      const text = await callResult(rpc, textResultSchema, 'bridge.lastPrompt', { workerId: id });

      if (!isCurrent() || selected() !== id || run !== runGeneration) {
        return;
      }

      activeMutation = undefined;
      setBusy(false);
      setResendWorker(id);
      setTextValue(text);
      setModal('resend');
      resendTarget = { workerId: id, text, expectedRun, dialogGeneration, runGeneration: run };
    } catch (error) {
      if (isCurrent() && run === runGeneration) {
        setNotice(errorMessage(error));
      }
    }
  };

  const resendPending = async () => {
    if (!alive || busy() || modal() !== 'resend') {
      return;
    }
    const target = resendTarget;
    if (
      !target ||
      target.dialogGeneration !== dialogGeneration ||
      target.runGeneration !== runGeneration ||
      target.workerId !== selected() ||
      target.text !== textValue()
    ) {
      setNotice('This prompt is no longer current. Close this dialog and review the pending prompt again.');
      return;
    }
    const operation = beginMutation(true, worker());
    if (!operation) {
      return;
    }
    const isCurrent = () => operation.isCurrent() && resendTarget === target && textValue() === target.text;

    try {
      const pendingText = await callResult(rpc, textResultSchema, 'bridge.lastPrompt', {
        workerId: target.workerId,
      });
      if (!isCurrent()) {
        return;
      }
      if (pendingText !== target.text) {
        throw new Error(
          'The pending prompt changed. Close this dialog and review it again before resending.',
        );
      }
      const result = await callResult(rpc, resendResultSchema, 'bridge.resend', {
        workerId: target.workerId,
        expectedRun: target.expectedRun,
        expectedPrompt: target.text,
        confirm: true,
      });
      if (isCurrent()) {
        setModal('');
        success(resendNotice(result));
      }
    } catch (event) {
      if (isCurrent()) {
        setNotice(
          'Miter could not confirm the resend. Check the saved chat before resending again. ' +
            errorMessage(event),
        );
      }
    } finally {
      operation.finish();
    }
  };

  const readHandoffClipboard = async () => {
    if (!alive || modal() !== 'import') {
      return;
    }
    const read = ++clipboardRead;
    const dialog = dialogGeneration;
    const run = runGeneration;
    const revision = handoffRevision;
    const isCurrent = () =>
      alive &&
      read === clipboardRead &&
      dialog === dialogGeneration &&
      run === runGeneration &&
      revision === handoffRevision;

    try {
      // Request directly in the click stack; cancel before starting the subsequent clipboard read.
      const granted = await chrome.permissions.request({ permissions: ['clipboardRead'] });
      if (!isCurrent()) {
        return;
      }
      if (!granted) {
        throw new Error('Clipboard permission was not granted. Paste into the text box instead.');
      }
      const text = await navigator.clipboard.readText();
      if (isCurrent()) {
        setHandoff(text);
      }
    } catch (event) {
      if (isCurrent()) {
        setNotice(errorMessage(event));
      }
    }
  };

  const sendFollowup = async (id: string, request: ChangeRequest) => {
    const task = snapshot().workers.find((entry) => entry.id === id);

    if (!task) {
      throw new Error('This task is no longer available.');
    }

    if (task.mode === 'handoff') {
      const granted = await chrome.permissions.request({
        origins: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
      });

      if (!granted) {
        throw new Error('ChatGPT permission was not granted. Your request was not sent.');
      }
    }

    const result = await rpc('worker.followup', { workerId: id, request });
    success('Follow-up saved in the same task.');
    return result;
  };

  const showFollowups = async () => {
    const isCurrent = beginDialogRead();
    if (!isCurrent) {
      return;
    }
    const id = selected();

    try {
      const result = await callResult(rpc, followupSchema.array(), 'worker.followups', { workerId: id });

      if (isCurrent() && selected() === id) {
        setFollowupHistory(result);
        setModal('followups');
      }
    } catch (error) {
      if (isCurrent()) {
        setNotice(errorMessage(error));
      }
    }
  };

  const showNotifications = async () => {
    const isCurrent = beginDialogRead();
    if (!isCurrent) {
      return;
    }
    try {
      const preferences = await callResult(rpc, notificationPreferencesSchema, 'notifications.get');
      if (isCurrent()) {
        setNotifications(preferences);
        setModal('notifications');
      }
    } catch (error) {
      if (isCurrent()) {
        setNotice(errorMessage(error));
      }
    }
  };

  const showText = async (kind: string) => {
    const isCurrent = beginDialogRead();
    if (!isCurrent) {
      return;
    }
    const id = selected();

    try {
      let method = 'worker.prompt';

      if (kind === 'report') {
        method = 'worker.report';
      }

      const text = await callResult(rpc, textResultSchema, method, { workerId: id, kind });

      if (!isCurrent() || id !== selected()) {
        return;
      }

      setTextValue(text);

      if (kind === 'report') {
        setModal('report');
      } else {
        setModal('prompt');
      }
    } catch (error) {
      if (isCurrent()) {
        setNotice(errorMessage(error));
      }
    }
  };

  const runWithChat = async () => {
    if (!alive || busy()) {
      return;
    }
    const task = worker();

    if (!task) {
      setNotice('This task is no longer available. Reopen its task before starting with ChatGPT.');
      return;
    }

    if (task.control?.mode === 'stopped' || task.control?.mode === 'fresh') {
      await action('bridge.continueFresh');
      return;
    }

    if (taskPresentation(task, bridge()).start !== 'Resume task') {
      try {
        const expectedRun = reviewedTaskBoundary(task);
        setAutomationTarget({ workerId: task.id, expectedRun });
        setNotice('');
        setModal('automation');
      } catch (error) {
        setNotice(errorMessage(error));
      }
      return;
    }

    const id = task.id;
    const operation = beginMutation(true, task);
    if (!operation) {
      return;
    }
    setNotice('');

    try {
      if (!operation.expectedRun) {
        throw new Error('This task is no longer available. Review it before resuming.');
      }
      const expectedRun = operation.expectedRun;
      const result = await callResult(rpc, resumeResultSchema, 'bridge.resume', {
        workerId: id,
        expectedRun,
      });

      if (operation.isCurrent() && !result.resumed) {
        setAutomationTarget({ workerId: id, expectedRun });
        setModal('automation');
      }
    } catch (error) {
      if (operation.isCurrent()) {
        setNotice(
          'Miter could not confirm the resume. Check task activity and its saved chat before trying again. ' +
            errorMessage(error),
        );
        setDebugOpen(true);
      }
    } finally {
      operation.finish();
    }
  };

  // An old chat link cannot authorize resuming a newly imported local queue.
  // Only an automatic checkpoint naming this exact batch can resume through chat.
  const continuePending = async () => {
    const task = worker();

    if (!task) {
      return;
    }

    const id = task.id;
    const operation = beginMutation(true, task);
    if (!operation) {
      return;
    }
    setNotice('');

    try {
      if (!operation.expectedRun) {
        throw new Error('This task is no longer available. Review it before continuing.');
      }
      const result = await callResult(rpc, continuePendingResultSchema, 'bridge.continuePending', {
        workerId: id,
        expectedRun: operation.expectedRun,
      });

      if (operation.isCurrent() && result.kind === 'chat' && !result.result.resumed) {
        setNotice('Open this task’s saved chat, then continue. The local batch is preserved.');
      }
    } catch (error) {
      if (operation.isCurrent()) {
        setNotice(
          'Miter could not confirm the continuation. Check task activity before continuing again. ' +
            errorMessage(error),
        );
        setDebugOpen(true);
      }
    } finally {
      operation.finish();
    }
  };

  const importBatch = async () => {
    const task = worker();
    if (!task || modal() !== 'import') {
      return;
    }
    // Import may create a run. The host's delivery identity binds the following start to that exact run.
    const operation = beginMutation(false, task);
    if (!operation) {
      return;
    }
    const text = handoff();
    const revision = handoffRevision;
    const run = runGeneration;
    setNotice('');
    let imported = false;

    try {
      const expectedRun = operation.expectedRun;
      if (!expectedRun) {
        throw new Error('This task is no longer available. Review it before importing a handoff.');
      }
      if (exceedsHandoffBytes(text)) {
        throw new Error('Handoff is too large. Split it into smaller batches.');
      }
      const envelope = parseProposalEnvelope(text);
      if (envelope.workerId !== task.id || envelope.projectId !== task.projectId) {
        throw new Error('This handoff belongs to a different task or project. Switch to its tab.');
      }
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(envelope)),
      );
      const envelopeHash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      if (!operation.isCurrent() || run !== runGeneration) {
        return;
      }
      await rpc('worker.import', { workerId: task.id, text, expectedRun });
      if (!operation.isCurrent()) {
        return;
      }
      imported = true;
      await rpc('worker.run', {
        workerId: task.id,
        epoch: expectedRun.epoch,
        envelopeId: envelope.id,
        envelopeHash,
      });
      if (!operation.isCurrent()) {
        return;
      }
      if (revision === handoffRevision) {
        setHandoff('');
        setModal('');
      }
      success('Handoff queued. Continuing the task.');
    } catch (error) {
      if (operation.isCurrent()) {
        let recovery = 'Check task activity before importing this handoff again. ';
        if (imported) {
          recovery =
            'The handoff was accepted. Check task activity and continue its saved batch; do not import it again. ';
        }
        setNotice('Miter could not confirm Import & run. ' + recovery + errorMessage(error));
      }
    } finally {
      operation.finish();
    }
  };

  const confirmAction = (method: string, message: string) => {
    if (confirm(message)) {
      void action(method, { confirm: true });
    }
  };

  onMount(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.altKey &&
        event.shiftKey &&
        event.code === 'KeyT' &&
        !document.querySelector('dialog[open]')
      ) {
        event.preventDefault();
        tabs.restore({ type: 'restoreLast' });
        return;
      }

      if (
        event.altKey &&
        !event.shiftKey &&
        event.code === 'KeyW' &&
        !document.querySelector('dialog[open]') &&
        selected()
      ) {
        event.preventDefault();
        void tabs.closeTabs({ type: 'close', kind: 'task', id: selected() });
        return;
      }

      if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'Backquote') {
        event.preventDefault();
        toggleTerminal();
        return;
      }

      if (event.ctrlKey && !event.altKey && (event.code === 'Backquote' || event.key === '`')) {
        event.preventDefault();
        setDebugOpen((value) => !value);
      }
    };

    document.addEventListener('keydown', key);
    onCleanup(() => document.removeEventListener('keydown', key));
    onCleanup(mountToasts(document, toasts));
    client.connect();

    void callResult(rpc, workspaceStateSchema, 'workspace.read')
      .then(async (state) => {
        applyNavigation(state);
        const query = new URLSearchParams(location.search);
        const id = query.get('task');

        if (id) {
          await tabs.navigate({ type: 'open', kind: 'task', id });
          const filePath = query.get('file');

          if (filePath) {
            output.preview(filePath);
          }
        }
      })
      .catch((error) => setNotice(errorMessage(error)));
  });

  onCleanup(() => {
    alive = false;
    activeMutation = undefined;
    resendTarget = undefined;
    setAutomationTarget(undefined);
    setBusy(false);
    client.close();
  });

  return {
    snapshot,
    setSnapshot,
    navigation,
    connected,
    connectionError,
    selected,
    formProjectId,
    success,
    info,
    setNotice,
    modal,
    setModal,
    textValue,
    setTextValue,
    handoff,
    setHandoff,
    busy,
    terminalOpen,
    setTerminalOpen,
    terminalMounted,
    toggleTerminal,
    debugOpen,
    setDebugOpen,
    logs,
    bridges,
    followupHistory,
    notifications,
    automationTarget,
    replyWorker,
    useReply,
    applyNavigation,
    client,
    worker,
    project,
    projectWorkers,
    tabs,
    output,
    bridge,
    preferReply,
    rpc,
    action,
    copy,
    playDing,
    rewriteDraft,
    resendWorker,
    showResend,
    resendPending,
    readHandoffClipboard,
    sendFollowup,
    showFollowups,
    showNotifications,
    showText,
    newWorker,
    runWithChat,
    continuePending,
    importBatch,
    confirmAction,
  };
}

export type WorkspaceController = ReturnType<typeof createWorkspaceController>;
