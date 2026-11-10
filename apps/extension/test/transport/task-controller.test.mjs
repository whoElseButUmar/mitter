import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createTaskController } from '../../src/background/task-controller.ts';
import { parseLocalResult } from '../../src/schemas/local-results.ts';
import { messageDigest } from '../../../../packages/bridge/src/message-wire.ts';
import { APP_VERSION } from '../../../../packages/protocol/src/index.ts';
import {
  PAGE_CHANNEL,
  PAGE_READER,
  pageHelloSchema,
} from '../../../../packages/bridge/src/transport/messages.ts';
import { LINK_STORAGE_KEY } from '../../../../packages/bridge/src/chat-links.ts';
import { BridgeRunner } from '../../../../packages/bridge/src/index.ts';
import { NativeRequestTimeout } from '../../../../packages/bridge/src/native-request.ts';
import { deferred, settle, snapshot } from './chrome-mock.mjs';

function worker(overrides = {}) {
  return {
    id: 'worker',
    projectId: 'project',
    name: 'Task',
    goal: 'Exact goal',
    checks: [],
    mode: 'handoff',
    state: 'idle',
    queue: [],
    cursor: 0,
    runId: 'run',
    iteration: 0,
    maxIterations: 15,
    maxMinutes: 30,
    startedAt: 0,
    autoCommands: false,
    observations: [],
    repeatCount: 0,
    createdAt: 0,
    control: {
      version: 1,
      epoch: 7,
      mode: 'active',
      at: 0,
      operationId: 'operation',
      reason: 'Started by user',
      retiredExchanges: [],
    },
    ...overrides,
  };
}

function progress(overrides = {}) {
  return {
    version: 1,
    revision: 0,
    workerId: 'worker',
    projectId: 'project',
    goalHash: 'a'.repeat(64),
    turns: 0,
    maxTurns: 15,
    lowerBound: false,
    activeMs: 0,
    maxMinutes: 30,
    startedAt: 0,
    updatedAt: 0,
    stage: 'local_batch',
    repeats: 0,
    formatRepairs: 0,
    phase: 'stopped',
    reason: 'Paused',
    ...overrides,
  };
}

function setup(context, timerAPIs = ['setTimeout']) {
  context.mock.timers.enable({ apis: timerAPIs });
  const calls = [];
  const broadcasts = [];
  const pages = [];
  const creations = [];
  const updates = [];
  const stored = {};
  const tabs = new Map();
  let blocked = false;
  let permission = true;
  let permissionChecks = 0;
  let ready = async () => {};
  let onBroadcast = () => {};
  let current = { ...snapshot, runtime: { ...snapshot.runtime, version: APP_VERSION }, workers: [worker()] };
  let checkpoint = { progress: null, importedCount: 0 };
  let native = async (method, params) => {
    if (method === 'state') {
      return current;
    }

    if (method === 'worker.bridgeLoad') {
      return checkpoint;
    }

    if (method === 'worker.bridgeSave') {
      return params.progress;
    }

    if (method === 'worker.bridgeExtend') {
      return progress({ maxTurns: 30, maxMinutes: 60 });
    }

    if (method === 'worker.continueFresh') {
      return { ready: true };
    }

    if (method === 'worker.steerValidate') {
      return { valid: true, alreadyApplied: false };
    }

    if (method === 'worker.stop') {
      return { stopped: true, ready: false, epoch: 8, operationId: params.id };
    }

    if (method === 'worker.steer') {
      return { stopped: false, ready: true, epoch: 8, operationId: params.request.id };
    }

    if (method === 'worker.run' || method === 'worker.resume') {
      return { started: true };
    }

    if (method === 'worker.import') {
      return { queued: true };
    }

    if (method === 'worker.approve') {
      if (params.approve === true) {
        return { approved: true };
      }

      return { denied: true };
    }

    if (method === 'worker.pause' || method === 'worker.cancel') {
      return { stopping: false };
    }

    if (method === 'worker.validateReply') {
      return { valid: true };
    }

    if (method === 'worker.handoffSeen') {
      return { seen: false };
    }

    if (method === 'worker.prompt' || method === 'worker.report') {
      return 'Exact task prompt.';
    }

    assert.fail('Unexpected native request in task fixture: ' + method);
  };
  const defaultNative = native;
  let create = async (changes) => ({ id: 100 + creations.length, autoDiscardable: true, ...changes });
  let page = async () => ({ url: 'https://chatgpt.com', ready: false, count: 0, draft: false, busy: false });
  const storage = {
    get: async () => stored,
    set: async (values) => Object.assign(stored, values),
  };
  globalThis.chrome = {
    storage: { local: storage, session: storage },
    permissions: {
      contains: async () => {
        permissionChecks++;
        return permission;
      },
      request: async () => assert.fail('Background work must not acquire user-gesture permissions.'),
    },
    tabs: {
      query: async () => [],
      create: async (changes) => {
        creations.push(changes);
        const tab = await create(changes);

        if (tab.id !== undefined) {
          tabs.set(tab.id, tab);
        }

        return tab;
      },
      get: async (id) => {
        const tab = tabs.get(id);

        if (!tab) {
          throw new Error('No tab with id ' + id);
        }

        return tab;
      },
      update: async (id, changes) => {
        updates.push({ id, changes });
        Object.assign(tabs.get(id), changes);
        return tabs.get(id);
      },
      sendMessage: async (tabId, message) => {
        pages.push({ tabId, message });
        let value;

        if (message.kind === 'hello') {
          value = pageHelloSchema.parse({
            version: PAGE_CHANNEL,
            reader: PAGE_READER,
            instanceId: 'document',
            url: tabs.get(tabId)?.url ?? 'https://chatgpt.com',
            readyState: 'complete',
          });
        } else {
          value = await page(tabId, message.action);
        }

        return { channel: PAGE_CHANNEL, id: message.id, instanceId: 'document', ok: true, value };
      },
    },
    scripting: { executeScript: async () => {} },
  };
  const tasks = createTaskController({
    rpc: async (method, params, schema) => {
      calls.push({ method, params });
      const result = await native(method, params);

      if (schema) {
        return schema.parse(result);
      }

      return result;
    },
    broadcast: (message) => {
      broadcasts.push(message);
      onBroadcast(message);
    },
    blocked: () => blocked,
    ready: () => ready(),
    notifications: { bridge() {}, snapshot() {}, clear() {}, quiesce: async () => {} },
    diagnostics: { add() {}, clear() {}, read: () => [] },
  });
  context.after(async () => {
    tasks.dispose();
    await settle();
  });

  return {
    tasks,
    calls,
    defaultNative,
    broadcasts,
    pages,
    creations,
    updates,
    stored,
    tabs,
    get current() {
      return current;
    },
    get permissionChecks() {
      return permissionChecks;
    },
    blocked(value) {
      blocked = value;
    },
    ready(value) {
      ready = value;
    },
    broadcast(value) {
      onBroadcast = value;
    },
    permission(value) {
      permission = value;
    },
    worker(value) {
      current = { ...current, workers: [value] };
    },
    checkpoint(value) {
      checkpoint = value;
    },
    native(value) {
      native = value;
    },
    create(value) {
      create = value;
    },
    page(value) {
      page = value;
    },
  };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) {
      return;
    }

    await settle();
    await setImmediate();
  }

  assert.fail('Expected asynchronous checkpoint was not reached.');
}

function mockChatLifecycle(context) {
  const runners = [];
  const stopped = [];
  context.mock.method(BridgeRunner.prototype, 'start', async function () {
    runners.push(this);
  });
  context.mock.method(BridgeRunner.prototype, 'stop', async function () {
    stopped.push(this);
    this.status.active = false;
    this.status.monitoring = false;
  });

  return { runners, stopped };
}

const reviewed = { workerId: 'worker', expectedRun: { runId: 'run', epoch: 7 } };
const start = { ...reviewed, consent: true, newChat: true };
const rewrite = { instruction: 'Keep the exact draft.', mode: 'clarity', provider: 'chatgpt' };

function mutationParams(method) {
  if (method === 'worker.import') {
    return { text: 'literal handoff' };
  }

  if (method === 'worker.approve') {
    return { token: 'approval', approve: true };
  }

  return {};
}

function linkedReply(state) {
  const link = { id: 7, url: 'https://chatgpt.com/c/conversation', title: 'Task chat', newChat: false };
  state.stored[LINK_STORAGE_KEY] = { version: 2, links: { worker: link } };
  state.tabs.set(link.id, { ...link, autoDiscardable: true });
  const envelope = {
    protocol: 'mitter/1',
    id: 'selected-reply',
    workerId: 'worker',
    projectId: 'project',
    summary: 'Exact selected reply',
    actions: [{ type: 'write', path: 'file.txt', content: 'Exact content\r\n', expectedHash: 'missing' }],
  };
  const text = JSON.stringify(envelope);
  const view = {
    url: link.url,
    ready: true,
    count: 1,
    userCount: 0,
    lastRole: 'assistant',
    assistantId: envelope.id,
    assistantText: text,
    lastUserText: '',
    complete: true,
    stopped: false,
    draftText: '',
    draft: false,
    busy: false,
    codeReply: { id: envelope.id, workerId: 'worker', projectId: 'project', text, hasCopyControl: true },
  };
  state.native(async (method, params) => {
    if (method === 'state') {
      return state.current;
    }

    if (method === 'worker.bridgeLoad') {
      return { progress: null, importedCount: 0 };
    }

    if (method === 'worker.bridgeSave') {
      return params.progress;
    }

    if (method === 'worker.handoffSeen') {
      return { seen: false };
    }

    if (method === 'worker.prompt') {
      return 'Exact task prompt.';
    }

    if (method === 'worker.import') {
      return { queued: true };
    }

    if (method === 'worker.run') {
      return { started: true };
    }

    if (method === 'worker.validateReply') {
      return { valid: true };
    }

    if (method === 'worker.pause') {
      return { stopping: false };
    }

    return { ready: true };
  });
  state.page(async () => view);

  return { view, params: { workerId: 'worker', source: 'clipboard', text } };
}

for (const lifecycle of ['reset', 'dispose']) {
  test(`late chat permission results cannot create a tab after ${lifecycle}`, async (context) => {
    const state = setup(context);
    const permission = deferred();
    state.permission(permission.promise);
    const request = state.tasks.request('bridge.newChat', {});
    await until(() => state.permissionChecks === 1);

    if (lifecycle === 'reset') {
      state.blocked(true);
    } else {
      state.tasks.dispose();
    }

    const rejected = assert.rejects(request, /reset|cancelled|shutdown/i);
    permission.resolve(true);
    await rejected;
    assert.deepEqual(state.creations, []);
    assert.deepEqual(state.pages, []);
  });
}

test('a reply preview waiting for permission cannot mint a ticket after Stop', async (context) => {
  const state = setup(context);
  const { params } = linkedReply(state);
  const permission = deferred();
  state.permission(permission.promise);
  const preview = state.tasks.request('bridge.replyPreview', params);
  await until(() => state.permissionChecks === 1);
  await state.tasks.request('bridge.halt', { workerId: 'worker' });
  const rejected = assert.rejects(preview, /superseded|cancelled/);
  permission.resolve(true);
  await rejected;
  assert.deepEqual(state.pages, []);
  assert.equal(
    state.calls.some((call) => call.method === 'worker.handoffSeen'),
    false,
  );
});

for (const lifecycle of ['Stop', 'expiry']) {
  test(`reply confirmation rechecks its one-use ticket after ${lifecycle} during a permission wait`, async (context) => {
    const state = setup(context, ['Date', 'setTimeout']);
    const { params } = linkedReply(state);
    const preview = await state.tasks.request('bridge.replyPreview', params);
    const permission = deferred();
    state.permission(permission.promise);
    const before = state.permissionChecks;
    const applying = state.tasks.request('bridge.replyApply', {
      workerId: 'worker',
      ticket: preview.ticket,
      confirm: true,
    });
    await until(() => state.permissionChecks === before + 1);

    if (lifecycle === 'Stop') {
      await state.tasks.request('bridge.halt', { workerId: 'worker' });
    } else {
      context.mock.timers.tick(120001);
    }

    const pageCount = state.pages.length;
    const rejected = assert.rejects(applying, /superseded|expired|cancelled/);
    permission.resolve(true);
    await rejected;
    assert.equal(state.pages.length, pageCount);
    assert.equal(
      state.calls.some((call) => call.method === 'worker.bridgeSave'),
      false,
    );
    assert.equal(
      state.calls.some((call) => call.method === 'worker.import'),
      false,
    );
  });
}

test('a reply ticket cannot authorize an unchanged payload in a replacement task epoch', async (context) => {
  const state = setup(context);
  const { params } = linkedReply(state);
  const preview = await state.tasks.request('bridge.replyPreview', params);
  state.worker(worker({ control: { ...worker().control, epoch: 8 } }));
  const before = state.pages.length;
  await assert.rejects(
    state.tasks.request('bridge.replyApply', { workerId: 'worker', ticket: preview.ticket, confirm: true }),
    /changed/,
  );
  assert.equal(state.pages.length, before);
  assert.equal(
    state.calls.some((call) => call.method === 'worker.import'),
    false,
  );
  assert.equal(
    state.calls.some((call) => call.method === 'worker.bridgeSave'),
    false,
  );
});

test('an exact live reply ticket imports once with its approved epoch and source bytes', async (context) => {
  const state = setup(context);
  const { params } = linkedReply(state);
  const preview = await state.tasks.request('bridge.replyPreview', params);
  const confirmation = { workerId: 'worker', ticket: preview.ticket, confirm: true };
  await state.tasks.request('bridge.replyApply', confirmation);
  const imports = state.calls.filter((call) => call.method === 'worker.import');
  assert.equal(imports.length, 1);
  assert.equal(imports[0].params.epoch, 7);
  assert.equal(JSON.parse(imports[0].params.text).actions[0].content, 'Exact content\r\n');
  assert.equal(state.calls.filter((call) => call.method === 'worker.run').length, 1);
  await assert.rejects(state.tasks.request('bridge.replyApply', confirmation), /expired/);
  assert.equal(state.calls.filter((call) => call.method === 'worker.import').length, 1);
});

test('reply confirmation fences an epoch replacement while the exact page recheck is pending', async (context) => {
  const state = setup(context);
  const { params, view } = linkedReply(state);
  const preview = await state.tasks.request('bridge.replyPreview', params);
  const page = deferred();
  state.page(() => page.promise);
  const before = state.pages.length;
  const applying = state.tasks.request('bridge.replyApply', {
    workerId: 'worker',
    ticket: preview.ticket,
    confirm: true,
  });
  await until(() => state.pages.length > before);
  state.worker(worker({ control: { ...worker().control, epoch: 8 } }));
  state.tasks.update(state.current);
  const rejected = assert.rejects(applying, /changed/);
  page.resolve(view);
  await rejected;
  assert.equal(
    state.calls.some((call) => call.method === 'worker.import'),
    false,
  );
  assert.equal(
    state.calls.some((call) => call.method === 'worker.bridgeSave'),
    false,
  );
});

test('Stop cancels a saved-conversation search before it can reopen a browser tab', async (context) => {
  context.mock.method(console, 'warn', () => {});
  const state = setup(context);
  linkedReply(state);
  state.tabs.clear();
  const query = deferred();
  let queried = false;
  chrome.tabs.query = () => {
    queried = true;
    return query.promise;
  };
  const resuming = state.tasks.request('bridge.resume', reviewed);
  await until(() => queried);
  await state.tasks.request('bridge.halt', { workerId: 'worker' });
  const rejected = assert.rejects(resuming, /superseded/);
  query.resolve([]);
  await rejected;
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
});

test('legacy mutations without an epoch use fresh host epochs without publishing or caching', async (context) => {
  const state = setup(context);

  for (const method of ['worker.import', 'worker.run', 'worker.resume', 'worker.approve']) {
    const params = { workerId: 'worker', ...mutationParams(method) };
    await state.tasks.request(method, params);
    assert.deepEqual(state.calls.slice(-2), [
      { method: 'state', params: {} },
      { method, params: { ...params, epoch: 7 } },
    ]);
  }

  assert.equal(
    state.broadcasts.some((message) => message.event === 'snapshot'),
    false,
  );
  assert.equal(
    state.tasks.initialMessages().some((message) => message.event === 'snapshot'),
    false,
  );
});

function pendingBatch(overrides = {}) {
  return {
    protocol: 'mitter/1',
    id: 'batch',
    workerId: 'worker',
    projectId: 'project',
    summary: 'Exact pending batch',
    actions: [{ type: 'write', path: 'file.txt', content: 'Exact bytes\r\n', expectedHash: 'missing' }],
    ...overrides,
  };
}

async function pendingCheckpoint(overrides = {}) {
  return {
    progress: progress({
      goalHash: await messageDigest(worker().goal),
      lastImportedId: 'batch',
      conversationUrl: 'https://chatgpt.com/c/original',
      ...overrides,
    }),
    importedCount: 1,
  };
}

async function queuedChat(state, missing) {
  state.worker(worker({ queue: [pendingBatch()] }));
  let link = { id: 7, url: 'https://chatgpt.com/c/original', title: 'Original task chat', newChat: false };
  let checkpointOverrides = {};

  if (missing === 'permission') {
    state.permission(false);
  } else if (missing === 'mismatched saved link') {
    link = { ...link, url: 'https://chatgpt.com/c/unrelated' };
  } else if (missing === 'blank saved link') {
    link = { ...link, url: 'https://chatgpt.com', newChat: true };
    checkpointOverrides = { conversationUrl: undefined };
  } else if (missing === 'fresh saved link') {
    state.worker(worker({ queue: [pendingBatch()], control: { ...worker().control, mode: 'fresh' } }));
  }

  if (missing !== 'saved link' && missing !== 'fresh saved link') {
    state.stored[LINK_STORAGE_KEY] = { version: 2, links: { worker: link } };
    state.tabs.set(link.id, { ...link, autoDiscardable: true });
  }

  const checkpoint = await pendingCheckpoint(checkpointOverrides);
  state.checkpoint(checkpoint);

  return checkpoint;
}

function assertNoContinuationEffect(state, allowLiveness = false) {
  const mutations = [
    'worker.resume',
    'worker.run',
    'worker.import',
    'worker.approve',
    'worker.bridgeSave',
    'worker.bridgeExtend',
  ];
  assert.deepEqual(
    state.calls.filter((call) => mutations.includes(call.method)),
    [],
  );
  assert.deepEqual(state.pages, []);
  assert.deepEqual(state.creations, []);

  if (allowLiveness) {
    for (const update of state.updates) {
      assert.deepEqual(update, { id: 7, changes: { autoDiscardable: false } });
    }
  } else {
    assert.deepEqual(state.updates, []);
  }
}

test('pending continuation requires valid reviewed parameters before readiness or capacity effects', async (context) => {
  const state = setup(context);
  let readinessCalls = 0;
  state.ready(async () => {
    readinessCalls++;
  });

  for (const params of [
    {},
    { workerId: null, expectedRun: reviewed.expectedRun },
    { workerId: 'worker', expectedRun: null },
    { workerId: 'worker', expectedRun: { runId: 'run', epoch: '7' } },
    { workerId: 'worker', expectedRun: { runId: 'run', epoch: -1 } },
    { ...reviewed, epoch: null },
    { ...reviewed, epoch: 8 },
  ]) {
    await assert.rejects(state.tasks.request('bridge.continuePending', params));
  }

  assert.equal(readinessCalls, 0);
  assert.deepEqual(state.calls, []);
  assertNoContinuationEffect(state);
  assert.equal(state.permissionChecks, 0);
});

for (const proof of ['none', 'other batch', 'other stage', 'local task']) {
  test(
    'pending ' + proof + ' retains the local-only choice and original native authority',
    async (context) => {
      const state = setup(context);
      const lifecycle = mockChatLifecycle(context);
      state.worker(worker({ queue: [pendingBatch()] }));

      if (proof === 'other batch') {
        state.checkpoint(await pendingCheckpoint({ lastImportedId: 'unrelated-batch' }));
      } else if (proof === 'other stage') {
        state.checkpoint(await pendingCheckpoint({ stage: 'waiting_reply' }));
      } else if (proof === 'local task') {
        state.worker(worker({ mode: 'local', queue: [pendingBatch()] }));
        state.checkpoint(await pendingCheckpoint());
      }

      const params = { ...reviewed, epoch: 7, callerField: 'Preserve supplied authority' };
      const result = await state.tasks.request('bridge.continuePending', params);
      assert.deepEqual(parseLocalResult('bridge.continuePending', result), {
        kind: 'local',
        result: { started: true },
      });
      const resumes = state.calls.filter((call) => call.method === 'worker.resume');
      assert.equal(resumes.length, 1);
      assert.equal(resumes[0].params, params);
      assert.deepEqual(resumes[0].params, params);
      assert.deepEqual(lifecycle.runners, []);
      assert.equal(state.permissionChecks, 0);
      assert.deepEqual(state.pages, []);
      assert.deepEqual(state.creations, []);
      assert.equal(
        state.calls.some((call) => call.method === 'worker.run' || call.method === 'worker.import'),
        false,
      );
    },
  );
}

for (const stage of ['waiting_reply', 'commit_intent']) {
  test(
    'pending continuation does not widen ' + stage + ' lost-ack proof into chat authority',
    async (context) => {
      const state = setup(context);
      const lifecycle = mockChatLifecycle(context);
      await queuedChat(state);
      state.checkpoint(
        await pendingCheckpoint({
          stage,
          approvedReply: { id: 'batch', hash: 'a'.repeat(64), url: 'https://chatgpt.com/c/original', at: 0 },
        }),
      );
      const result = await state.tasks.request('bridge.continuePending', reviewed);
      assert.deepEqual(result, { kind: 'local', result: { started: true } });
      assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
      assert.deepEqual(lifecycle.runners, []);
      assert.equal(state.permissionChecks, 0);
      assert.deepEqual(state.pages, []);
      assert.deepEqual(state.creations, []);
    },
  );
}

test('an exact automatic batch resumes only the same saved chat and repeated clicks do not replay effects', async (context) => {
  const state = setup(context);
  const lifecycle = mockChatLifecycle(context);
  await queuedChat(state);
  const first = await state.tasks.request('bridge.continuePending', reviewed);
  assert.equal(first.kind, 'chat');
  assert.equal(first.result.resumed, true);
  assert.equal(first.result.status.url, 'https://chatgpt.com/c/original');
  assert.equal(first.result.status.tabId, 7);
  assert.equal(lifecycle.runners.length, 1);
  assert.equal(state.permissionChecks, 1);
  assertNoContinuationEffect(state, true);
  const second = await state.tasks.request('bridge.continuePending', reviewed);
  assert.equal(second.kind, 'chat');
  assert.equal(second.result.resumed, true);
  assert.equal(lifecycle.runners.length, 1);
  assertNoContinuationEffect(state, true);
});

for (const missing of ['permission', 'saved link', 'fresh saved link', 'blank saved link']) {
  test(
    'pending chat with missing ' + missing + ' preserves the batch without a new chat or local fallback',
    async (context) => {
      const state = setup(context);
      const lifecycle = mockChatLifecycle(context);
      await queuedChat(state, missing);
      let queries = 0;
      chrome.tabs.query = async () => {
        queries++;

        return [{ id: 99, url: 'https://chatgpt.com/c/unrelated', title: 'Unrelated active chat' }];
      };
      const result = await state.tasks.request('bridge.continuePending', reviewed);
      assert.deepEqual(result, { kind: 'chat', result: { resumed: false } });
      assert.deepEqual(lifecycle.runners, []);
      assert.equal(state.permissionChecks, 1);
      assert.equal(queries, 0);
      assertNoContinuationEffect(state);
    },
  );
}

for (const expectedRun of [
  { runId: 'other-run', epoch: 7 },
  { runId: 'run', epoch: 8 },
]) {
  test(
    'pending continuation rejects the wrong reviewed boundary ' + JSON.stringify(expectedRun),
    async (context) => {
      const state = setup(context);
      await queuedChat(state);
      await assert.rejects(
        state.tasks.request('bridge.continuePending', { workerId: 'worker', expectedRun }),
        /earlier task run/,
      );
      assert.equal(
        state.calls.some((call) => call.method === 'worker.bridgeLoad'),
        false,
      );
      assert.equal(state.permissionChecks, 0);
      assertNoContinuationEffect(state);
    },
  );
}

for (const binding of [{ workerId: 'other' }, { projectId: 'other' }, { goalHash: 'f'.repeat(64) }]) {
  test(
    'pending continuation rejects a checkpoint with wrong binding ' + JSON.stringify(binding),
    async (context) => {
      const state = setup(context);
      state.worker(worker({ queue: [pendingBatch()] }));
      state.checkpoint(await pendingCheckpoint(binding));
      await assert.rejects(state.tasks.request('bridge.continuePending', reviewed), /different task or goal/);
      assert.equal(state.permissionChecks, 0);
      assertNoContinuationEffect(state);
    },
  );
}

function changedPendingWorker(task, change) {
  if (change === 'task') {
    return { ...task, id: 'replacement-worker' };
  }

  if (change === 'run') {
    return { ...task, runId: 'replacement' };
  }

  if (change === 'epoch') {
    return { ...task, control: { ...task.control, epoch: 8 } };
  }

  if (change === 'goal') {
    return { ...task, goal: 'Changed exact goal' };
  }

  if (change === 'project') {
    return { ...task, projectId: 'replacement-project' };
  }

  if (change === 'mode') {
    return { ...task, mode: 'local' };
  }

  if (change === 'batch contents') {
    const head = structuredClone(task.queue[0]);
    head.actions[0].content = 'Replacement bytes\r\n';
    return { ...task, queue: [head] };
  }

  return { ...task, queue: [pendingBatch({ id: 'replacement-batch' })] };
}

for (const change of ['run', 'epoch', 'goal', 'project', 'mode', 'batch', 'batch contents']) {
  for (const published of [false, true]) {
    test(
      'checkpoint wait rejects changed ' + change + ' with snapshot published=' + published,
      async (context) => {
        const state = setup(context);
        const checkpoint = await queuedChat(state);
        const waiting = deferred();
        state.native((method, params) => {
          if (method === 'worker.bridgeLoad') {
            return waiting.promise;
          }

          return state.defaultNative(method, params);
        });
        const continuing = state.tasks.request('bridge.continuePending', reviewed);
        await until(() => state.calls.some((call) => call.method === 'worker.bridgeLoad'));
        state.worker(changedPendingWorker(state.current.workers[0], change));

        if (published) {
          state.tasks.update(state.current);
        }

        const rejected = assert.rejects(continuing, /earlier task run|changed/);
        waiting.resolve(checkpoint);
        await rejected;
        assert.equal(state.permissionChecks, 0);
        assertNoContinuationEffect(state);
      },
    );
  }
}

for (const lifecycle of ['Stop', 'reset', 'completed reset', 'dispose']) {
  test(lifecycle + ' during checkpoint wait retires the original pending continuation', async (context) => {
    const state = setup(context);
    const checkpoint = await queuedChat(state);
    const waiting = deferred();
    state.native((method, params) => {
      if (method === 'worker.bridgeLoad') {
        return waiting.promise;
      }

      return state.defaultNative(method, params);
    });
    const continuing = state.tasks.request('bridge.continuePending', reviewed);
    await until(() => state.calls.some((call) => call.method === 'worker.bridgeLoad'));

    if (lifecycle === 'Stop') {
      await state.tasks.request('bridge.halt', { workerId: 'worker' });
    } else if (lifecycle === 'reset') {
      state.blocked(true);
    } else if (lifecycle === 'completed reset') {
      await state.tasks.quiesce();
      state.tasks.clear();
    } else {
      state.tasks.dispose();
    }

    const rejected = assert.rejects(continuing, /superseded|reset|shutdown/i);
    waiting.resolve(checkpoint);
    await rejected;
    assert.equal(state.permissionChecks, 0);
    assertNoContinuationEffect(state);
  });
}

for (const result of [
  null,
  undefined,
  {},
  { progress: null },
  { progress: {}, importedCount: 0 },
  { progress: null, importedCount: '0' },
]) {
  test(
    'malformed checkpoint ' + JSON.stringify(result) + ' cannot authorize a fallback or replay',
    async (context) => {
      const state = setup(context);
      state.checkpoint(result);
      await assert.rejects(state.tasks.request('bridge.continuePending', reviewed), (error) => {
        assert.equal(error.code, 'RPC_RESULT_INVALID');
        assert.equal(error.method, 'worker.bridgeLoad');
        assert.equal(error.retryable, false);
        return true;
      });
      const before = state.calls.length;
      context.mock.timers.tick(180000);
      await settle();
      assert.equal(state.calls.length, before);
      assertNoContinuationEffect(state);
    },
  );
}

for (const receipt of [
  null,
  undefined,
  {},
  { started: false },
  { started: 'true' },
  { started: true, queued: true },
]) {
  test(
    'malformed local resume receipt ' + JSON.stringify(receipt) + ' is not success and never replays',
    async (context) => {
      const state = setup(context);
      state.native((method, params) => {
        if (method === 'worker.resume') {
          return receipt;
        }

        return state.defaultNative(method, params);
      });
      await assert.rejects(state.tasks.request('bridge.continuePending', reviewed), (error) => {
        assert.equal(error.code, 'RPC_RESULT_INVALID');
        assert.equal(error.method, 'worker.resume');
        assert.equal(error.retryable, false);
        assert.match(error.message, /already have completed/);
        return true;
      });
      context.mock.timers.tick(180000);
      await settle();
      assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
      assert.equal(
        state.calls.some((call) => call.method === 'worker.run' || call.method === 'worker.import'),
        false,
      );
      assert.equal(state.permissionChecks, 0);
      assert.deepEqual(state.pages, []);
      assert.deepEqual(state.creations, []);
    },
  );
}

test('a lost checkpoint acknowledgement cannot choose chat, start local work, or replay the read', async (context) => {
  const state = setup(context);
  const timeout = new NativeRequestTimeout('worker.bridgeLoad');
  state.native((method, params) => {
    if (method === 'worker.bridgeLoad') {
      throw timeout;
    }

    return state.defaultNative(method, params);
  });
  await assert.rejects(state.tasks.request('bridge.continuePending', reviewed), (error) => error === timeout);
  context.mock.timers.tick(180000);
  await settle();
  assert.equal(state.calls.filter((call) => call.method === 'worker.bridgeLoad').length, 1);
  assert.equal(state.permissionChecks, 0);
  assertNoContinuationEffect(state);
});

for (const retirement of ['Stop', 'reset']) {
  test(
    retirement + ' during a sent local resume cannot publish success or replay a replacement',
    async (context) => {
      const state = setup(context);
      const receipt = deferred();
      state.native((method, params) => {
        if (method === 'worker.resume') {
          return receipt.promise;
        }

        return state.defaultNative(method, params);
      });
      const continuing = state.tasks.request('bridge.continuePending', reviewed);
      await until(() => state.calls.some((call) => call.method === 'worker.resume'));

      if (retirement === 'Stop') {
        await state.tasks.request('bridge.halt', { workerId: 'worker' });
      } else {
        await state.tasks.quiesce();
        state.tasks.clear();
      }

      const rejected = assert.rejects(continuing, /superseded|reset/);
      receipt.resolve({ started: true });
      await rejected;
      context.mock.timers.tick(180000);
      await settle();
      assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
      assert.equal(
        state.calls.some((call) => call.method === 'worker.run' || call.method === 'worker.import'),
        false,
      );
      assert.equal(state.permissionChecks, 0);
      assert.deepEqual(state.pages, []);
      assert.deepEqual(state.creations, []);
    },
  );
}

test('a lost local resume acknowledgement is propagated once without a chat or mutation fallback', async (context) => {
  const state = setup(context);
  const timeout = new NativeRequestTimeout('worker.resume');
  state.native((method, params) => {
    if (method === 'worker.resume') {
      throw timeout;
    }

    return state.defaultNative(method, params);
  });
  await assert.rejects(state.tasks.request('bridge.continuePending', reviewed), (error) => error === timeout);
  context.mock.timers.tick(180000);
  await settle();
  assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
  assert.equal(state.permissionChecks, 0);
  assert.deepEqual(state.pages, []);
  assert.deepEqual(state.creations, []);
});

for (const checkpointChange of ['malformed', 'lost acknowledgement stage', 'wrong goal']) {
  test(
    'a chat-selected continuation cannot fall back when its second checkpoint has ' + checkpointChange,
    async (context) => {
      const state = setup(context);
      const lifecycle = mockChatLifecycle(context);
      await queuedChat(state);
      let changed = null;

      if (checkpointChange === 'lost acknowledgement stage') {
        changed = await pendingCheckpoint({
          stage: 'commit_intent',
          approvedReply: { id: 'batch', hash: 'a'.repeat(64), url: 'https://chatgpt.com/c/original', at: 0 },
        });
      } else if (checkpointChange === 'wrong goal') {
        changed = await pendingCheckpoint({ goalHash: 'f'.repeat(64) });
      }

      let loads = 0;
      state.native((method, params) => {
        if (method === 'worker.bridgeLoad') {
          loads++;

          if (loads > 1) {
            return changed;
          }
        }

        return state.defaultNative(method, params);
      });
      await assert.rejects(state.tasks.request('bridge.continuePending', reviewed));
      assert.equal(loads, 2);
      assert.equal(state.permissionChecks, 0);
      assert.deepEqual(lifecycle.runners, []);
      assertNoContinuationEffect(state);
    },
  );
}

for (const change of ['run', 'epoch', 'goal']) {
  test(
    'pending saved-chat permission wait retains its original ' + change + ' admission',
    async (context) => {
      const state = setup(context);
      const lifecycle = mockChatLifecycle(context);
      await queuedChat(state);
      const permission = deferred();
      state.permission(permission.promise);
      const continuing = state.tasks.request('bridge.continuePending', reviewed);
      await until(() => state.permissionChecks === 1);
      state.worker(changedPendingWorker(state.current.workers[0], change));
      const rejected = assert.rejects(continuing, /earlier task run|changed/);
      permission.resolve(true);
      await rejected;
      assert.deepEqual(lifecycle.runners, []);
      assertNoContinuationEffect(state);
    },
  );
}

test('pending continuation reserves capacity before readiness and cannot be submitted twice', async (context) => {
  const state = setup(context);
  const ready = deferred();
  state.ready(() => ready.promise);
  const continuing = state.tasks.request('bridge.continuePending', reviewed);
  await assert.rejects(state.tasks.request('bridge.continuePending', reviewed), /already continuing/);
  await assert.rejects(state.tasks.request('bridge.start', start), /already starting/);
  assert.deepEqual(state.calls, []);
  ready.resolve();
  assert.deepEqual(await continuing, { kind: 'local', result: { started: true } });
  assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
});

test('pending continuation holds capacity through the exact native acknowledgement without duplicate execution', async (context) => {
  const state = setup(context);
  const receipt = deferred();
  state.native((method, params) => {
    if (method === 'worker.resume') {
      return receipt.promise;
    }

    return state.defaultNative(method, params);
  });
  const continuing = state.tasks.request('bridge.continuePending', reviewed);
  await until(() => state.calls.some((call) => call.method === 'worker.resume'));
  const before = state.calls.length;
  await assert.rejects(state.tasks.request('bridge.continuePending', reviewed), /already continuing/);
  assert.equal(state.calls.length, before);
  receipt.resolve({ started: true });
  assert.deepEqual(await continuing, { kind: 'local', result: { started: true } });
  assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
});

test('retired pending cleanup cannot release a replacement continuation after reset', async (context) => {
  const state = setup(context);
  const oldCheckpoint = deferred();
  const newCheckpoint = deferred();
  let loads = 0;
  state.native((method, params) => {
    if (method === 'worker.bridgeLoad') {
      loads++;

      if (loads === 1) {
        return oldCheckpoint.promise;
      }

      return newCheckpoint.promise;
    }

    return state.defaultNative(method, params);
  });
  const retired = state.tasks.request('bridge.continuePending', reviewed);
  await until(() => loads === 1);
  await state.tasks.quiesce();
  state.tasks.clear();
  const replacement = state.tasks.request('bridge.continuePending', reviewed);
  await until(() => loads === 2);
  const rejected = assert.rejects(retired, /superseded|reset/);
  oldCheckpoint.resolve({ progress: null, importedCount: 0 });
  await rejected;
  await assert.rejects(state.tasks.request('bridge.continuePending', reviewed), /already continuing/);
  newCheckpoint.resolve({ progress: null, importedCount: 0 });
  assert.deepEqual(await replacement, { kind: 'local', result: { started: true } });
  assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
});

test('Stop while readiness is pending cannot be borrowed by a rearmed pending run', async (context) => {
  const state = setup(context);
  const readiness = deferred();
  state.ready(() => readiness.promise);
  const continuing = state.tasks.request('bridge.continuePending', reviewed);
  state.ready(async () => {});
  await state.tasks.request('bridge.halt', { workerId: 'worker' });
  state.worker(worker({ control: { ...worker().control, epoch: 8, mode: 'fresh' } }));
  state.tasks.update(state.current);
  const before = state.calls.length;
  const rejected = assert.rejects(continuing, /superseded/);
  readiness.resolve();
  await rejected;
  assert.equal(state.calls.length, before);
  assertNoContinuationEffect(state);
});

function observeRealStartup(context) {
  const startRunner = BridgeRunner.prototype.start;
  const starts = [];
  context.mock.method(BridgeRunner.prototype, 'start', function () {
    const completion = startRunner.call(this);
    starts.push({ runner: this, completion });
    return completion;
  });
  return starts;
}

function holdStartup(state, starts, stage) {
  const entered = deferred();
  const release = deferred();
  let held = false;
  let loads = 0;
  state.native(async (method, params) => {
    if (method === 'worker.bridgeLoad') {
      loads++;
    }

    const prompts = state.calls.filter((call) => call.method === 'worker.prompt').length;
    const waiting =
      (stage === 'progress load' && method === 'worker.bridgeLoad' && loads === 3) ||
      (stage === 'checkpoint save' && method === 'worker.bridgeSave') ||
      (stage === 'bootstrap prompt' && method === 'worker.prompt' && params.kind === 'bootstrap') ||
      (stage === 'next prompt' && method === 'worker.prompt' && params.kind === 'next') ||
      (stage === 'final state' && method === 'state' && starts.length > 0 && prompts === 2);

    if (waiting && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }

    return state.defaultNative(method, params);
  });

  if (stage === 'final tab') {
    const get = chrome.tabs.get;
    chrome.tabs.get = async (id) => {
      if (
        !held &&
        starts.length > 0 &&
        state.calls.filter((call) => call.method === 'worker.prompt').length === 2
      ) {
        held = true;
        entered.resolve();
        await release.promise;
      }

      return get(id);
    };
  }

  return { entered: entered.promise, release };
}

function assertNoStartupExecution(state) {
  assert.deepEqual(
    state.calls.filter((call) => ['worker.resume', 'worker.run', 'worker.import'].includes(call.method)),
    [],
  );
  assert.deepEqual(
    state.pages.filter(
      (page) => page.message.kind !== 'hello' && !['stop', 'interrupt'].includes(page.message.action.op),
    ),
    [],
  );
  assert.deepEqual(state.creations, []);
}

for (const suppliedEpoch of [false, true]) {
  test(
    'local pending resume derives only a missing epoch and preserves literal authority, supplied=' +
      suppliedEpoch,
    async (context) => {
      const state = setup(context);
      const expectedRun = Object.freeze({ runId: '  exact run\\id\r\n😀  ', epoch: 7 });
      state.worker(worker({ runId: expectedRun.runId, mode: 'local', queue: [pendingBatch()] }));
      const params = { workerId: 'worker', expectedRun, callerField: '  Exact metadata\r\n😀  ' };

      if (suppliedEpoch) {
        params.epoch = 7;
      }

      Object.freeze(params);
      state.native((method, sent) => {
        if (method === 'worker.resume') {
          assert.equal(sent.epoch, 7, 'Exercise the nonzero native epoch gate.');
          assert.equal(sent.expectedRun, expectedRun);
          assert.equal(sent.callerField, params.callerField);

          if (suppliedEpoch) {
            assert.equal(sent, params);
          } else {
            assert.equal(Object.hasOwn(params, 'epoch'), false);
            assert.deepEqual(sent, { ...params, epoch: 7 });
          }
        }

        return state.defaultNative(method, sent);
      });
      assert.deepEqual(await state.tasks.request('bridge.continuePending', params), {
        kind: 'local',
        result: { started: true },
      });
      assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
      assert.equal(state.permissionChecks, 0);
      assert.deepEqual(state.pages, []);
    },
  );
}

for (const method of ['bridge.continuePending', 'bridge.resume']) {
  for (const suppliedEpoch of [false, true]) {
    test(
      method + ' real startup preserves the original resume request, supplied epoch=' + suppliedEpoch,
      async (context) => {
        const state = setup(context);
        const starts = observeRealStartup(context);
        await queuedChat(state);
        const expectedRun = Object.freeze({ runId: '\t exact run\\id 😀 \r\n', epoch: 7 });
        state.worker({ ...state.current.workers[0], runId: expectedRun.runId });
        const params = { workerId: 'worker', expectedRun, callerField: '  exact source\r\n😀  ' };

        if (suppliedEpoch) {
          params.epoch = 7;
        }

        Object.freeze(params);
        state.native((requestedMethod, sent) => {
          if (requestedMethod === 'worker.resume') {
            assert.equal(sent.expectedRun, expectedRun);
            assert.equal(sent.epoch, expectedRun.epoch);
            assert.equal(sent.callerField, params.callerField);

            if (suppliedEpoch) {
              assert.equal(sent, params);
            } else {
              assert.deepEqual(sent, { ...params, epoch: expectedRun.epoch });
              assert.equal(Object.hasOwn(params, 'epoch'), false);
            }
          }

          if (requestedMethod === 'worker.bridgeSave') {
            const saved = structuredClone({ ...sent.progress, revision: sent.progress.revision + 1 });
            state.checkpoint({ progress: saved, importedCount: 1 });
            return saved;
          }

          return state.defaultNative(requestedMethod, sent);
        });
        const result = await state.tasks.request(method, params);
        assert.equal(starts.length, 1);
        await starts[0].completion;
        assert.equal(starts[0].runner.status.phase, 'running');
        assert.equal(starts[0].runner.status.url, 'https://chatgpt.com/c/original');
        assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
        assert.equal(
          state.calls.filter((call) => ['worker.run', 'worker.import'].includes(call.method)).length,
          0,
        );
        assert.deepEqual(state.pages, []);
        assert.deepEqual(state.creations, []);

        if (method === 'bridge.continuePending') {
          assert.equal(result.kind, 'chat');
          assert.equal(result.result.resumed, true);
        } else {
          assert.equal(result.resumed, true);
        }

        for (const call of state.calls.filter((call) => call.method.startsWith('worker.'))) {
          assert.deepEqual(call.params.expectedRun, expectedRun);
        }
      },
    );
  }

  test(
    method + ' conflicting native epochs fail before readiness, admission reads or browser effects',
    async (context) => {
      const state = setup(context);
      let readinessCalls = 0;
      state.ready(async () => {
        readinessCalls++;
      });
      await assert.rejects(state.tasks.request(method, { ...reviewed, epoch: 8 }), /epoch|match/);
      assert.equal(readinessCalls, 0);
      assert.deepEqual(state.calls, []);
      assertNoContinuationEffect(state);
    },
  );
}

for (const stage of [
  'progress load',
  'checkpoint save',
  'bootstrap prompt',
  'next prompt',
  'final tab',
  'final state',
]) {
  for (const change of ['task', 'run', 'epoch', 'project', 'goal', 'mode', 'batch', 'batch contents']) {
    for (const published of [false, true]) {
      test(
        'real startup pins ' + change + ' across ' + stage + ', published=' + published,
        async (context) => {
          const state = setup(context);
          const starts = observeRealStartup(context);
          await queuedChat(state);
          const gate = holdStartup(state, starts, stage);
          const result = await state.tasks.request('bridge.continuePending', reviewed);
          assert.equal(result.kind, 'chat');
          assert.equal(result.result.resumed, true);
          await gate.entered;
          const before = state.calls.length;
          state.worker(changedPendingWorker(state.current.workers[0], change));

          if (published) {
            state.tasks.update(state.current);
          }

          const rejected = assert.rejects(starts[0].completion, /changed|earlier task run/);
          gate.release.resolve();
          await rejected;
          assert.equal(starts[0].runner.status.active, false);
          assertNoStartupExecution(state);
          assert.deepEqual(
            state.calls
              .slice(before)
              .filter((call) => ['worker.pause', 'worker.bridgeSave'].includes(call.method)),
            [],
            'Retired startup must not pause or checkpoint the replacement task.',
          );
          context.mock.timers.tick(180000);
          await starts[0].runner.tick();
          assertNoStartupExecution(state);
        },
      );
    }
  }
}

for (const stage of [
  'progress load',
  'checkpoint save',
  'bootstrap prompt',
  'next prompt',
  'final tab',
  'final state',
]) {
  test('real startup pins its destination across ' + stage, async (context) => {
    const state = setup(context);
    const starts = observeRealStartup(context);
    await queuedChat(state);
    const gate = holdStartup(state, starts, stage);
    await state.tasks.request('bridge.continuePending', reviewed);
    await gate.entered;
    state.tabs.set(7, { ...state.tabs.get(7), url: 'https://chatgpt.com/c/unrelated' });
    if (stage !== 'final tab') {
      state.tasks.tabUpdated(7, { url: 'https://chatgpt.com/c/unrelated' });
    }

    const rejected = assert.rejects(starts[0].completion);
    gate.release.resolve();
    await rejected;
    assert.equal(starts[0].runner.status.active, false);
    assert.equal(starts[0].runner.status.errorCode, 'NAVIGATED');
    assertNoStartupExecution(state);
  });
}

for (const retirement of ['Stop', 'reset', 'dispose']) {
  test(retirement + ' retires real startup before a held third progress load returns', async (context) => {
    const state = setup(context);
    const starts = observeRealStartup(context);
    await queuedChat(state);
    const gate = holdStartup(state, starts, 'progress load');
    await state.tasks.request('bridge.continuePending', reviewed);
    await gate.entered;

    let retiring = Promise.resolve();

    if (retirement === 'Stop') {
      retiring = state.tasks.request('bridge.halt', { workerId: 'worker' });
      await until(() => state.calls.some((call) => call.method === 'worker.stop'));
    } else if (retirement === 'reset') {
      state.blocked(true);
      await state.tasks.stop();
      state.tasks.clear();
      state.blocked(false);
    } else {
      state.tasks.dispose();
    }

    const rejected = assert.rejects(starts[0].completion, /superseded|reset|replaced|stopped|shutdown/i);
    gate.release.resolve();
    await Promise.all([retiring, rejected]);
    assertNoStartupExecution(state);
  });
}

for (const change of ['run', 'goal', 'batch contents']) {
  test(
    'an in-place ' + change + ' replacement cannot borrow pending admission before runner construction',
    async (context) => {
      const state = setup(context);
      const starts = observeRealStartup(context);
      const checkpoint = await queuedChat(state);
      state.tasks.update(state.current);
      const reading = deferred();
      state.native((method, params) => {
        if (method === 'worker.bridgeLoad') {
          return reading.promise;
        }

        return state.defaultNative(method, params);
      });
      const continuing = state.tasks.request('bridge.continuePending', reviewed);
      await until(() => state.calls.some((call) => call.method === 'worker.bridgeLoad'));
      Object.assign(state.current.workers[0], changedPendingWorker(state.current.workers[0], change));
      const rejected = assert.rejects(continuing, /changed|earlier task run/);
      reading.resolve(checkpoint);
      await rejected;
      assert.deepEqual(starts, []);
      assertNoContinuationEffect(state);
    },
  );
}

for (const method of ['bridge.continuePending', 'bridge.resume']) {
  test(
    method + ' rejects a bound link disagreeing with its durable conversation before browser selection',
    async (context) => {
      const state = setup(context);
      const starts = observeRealStartup(context);
      await queuedChat(state, 'mismatched saved link');
      const get = context.mock.method(chrome.tabs, 'get');
      const query = context.mock.method(chrome.tabs, 'query');
      await assert.rejects(state.tasks.request(method, reviewed), /saved chat link does not match/);
      assert.deepEqual(starts, []);
      assert.equal(get.mock.callCount(), 0);
      assert.equal(query.mock.callCount(), 0);
      assertNoContinuationEffect(state);
    },
  );
}

for (const read of [2, 3]) {
  test(
    'checkpoint read ' + read + ' cannot replace the reviewed conversation during real startup',
    async (context) => {
      const state = setup(context);
      const starts = observeRealStartup(context);
      await queuedChat(state);
      const changed = await pendingCheckpoint({ conversationUrl: 'https://chatgpt.com/c/unrelated' });
      let loads = 0;
      state.native((method, params) => {
        if (method === 'worker.bridgeLoad' && ++loads === read) {
          return changed;
        }

        return state.defaultNative(method, params);
      });
      const continuing = state.tasks.request('bridge.continuePending', reviewed);

      if (read === 2) {
        await assert.rejects(continuing, /conversation changed/);
        assert.deepEqual(starts, []);
      } else {
        await continuing;
        await assert.rejects(starts[0].completion, { code: 'NAVIGATED' });
        assert.equal(starts[0].runner.status.url, 'https://chatgpt.com/c/original');
      }

      assert.equal(loads, read);
      assertNoStartupExecution(state);
      assert.equal(state.calls.filter((call) => call.method === 'worker.bridgeSave').length, 0);
    },
  );
}

for (const checkpointChange of [
  'malformed',
  'lost acknowledgement',
  'null progress',
  'missing conversation',
  'waiting_reply',
  'commit_intent',
]) {
  test(
    'real startup rejects third-load ' + checkpointChange + ' without widening authority or replaying',
    async (context) => {
      const state = setup(context);
      const starts = observeRealStartup(context);
      await queuedChat(state);
      const timeout = new NativeRequestTimeout('worker.bridgeLoad');
      let changed = null;

      if (checkpointChange === 'null progress') {
        changed = { progress: null, importedCount: 1 };
      } else if (checkpointChange === 'missing conversation') {
        changed = await pendingCheckpoint({ conversationUrl: undefined });
      } else if (['waiting_reply', 'commit_intent'].includes(checkpointChange)) {
        changed = await pendingCheckpoint({
          stage: checkpointChange,
          approvedReply: { id: 'batch', hash: 'a'.repeat(64), url: 'https://chatgpt.com/c/original', at: 0 },
        });
      }

      let loads = 0;
      state.native((method, params) => {
        if (method === 'worker.bridgeLoad' && ++loads === 3) {
          if (checkpointChange === 'lost acknowledgement') {
            throw timeout;
          }

          return changed;
        }

        if (method === 'worker.handoffSeen') {
          return { seen: true };
        }

        return state.defaultNative(method, params);
      });
      await state.tasks.request('bridge.continuePending', reviewed);
      await assert.rejects(starts[0].completion, (error) => {
        if (checkpointChange === 'lost acknowledgement') {
          assert.equal(error, timeout);
        }

        return true;
      });
      const before = state.calls.length;
      context.mock.timers.tick(180000);
      state.tasks.tick();
      await settle();
      assert.equal(state.calls.length, before);
      assert.equal(loads, 3);
      assert.equal(state.calls.filter((call) => call.method === 'worker.handoffSeen').length, 0);
      assert.equal(state.calls.filter((call) => call.method === 'worker.bridgeSave').length, 0);
      assertNoStartupExecution(state);
    },
  );
}

for (const failure of ['malformed', 'lost acknowledgement']) {
  test('real startup cannot execute after an uncertain checkpoint save: ' + failure, async (context) => {
    const state = setup(context);
    const starts = observeRealStartup(context);
    await queuedChat(state);
    let revision = 0;
    let durableWrites = 0;
    state.native((method, params) => {
      if (method === 'worker.bridgeSave') {
        assert.equal(params.expectedRun.runId, 'run');

        if (params.progress.revision !== revision) {
          throw new Error('The native checkpoint CAS rejected the unacknowledged revision.');
        }

        revision++;
        durableWrites++;
        state.checkpoint({ progress: { ...params.progress, revision }, importedCount: 1 });

        if (failure === 'lost acknowledgement') {
          throw new NativeRequestTimeout(method);
        }

        return null;
      }

      return state.defaultNative(method, params);
    });
    await state.tasks.request('bridge.continuePending', reviewed);
    await assert.rejects(starts[0].completion, { code: 'PROGRESS_SAVE_FAILED' });
    assert.equal(durableWrites, 1);
    assertNoStartupExecution(state);
    const before = state.calls.length;
    context.mock.timers.tick(180000);
    await starts[0].runner.tick();
    assert.equal(state.calls.length, before);
  });
}

for (const receipt of [
  null,
  {},
  { started: false },
  { started: 'true' },
  { started: true, queued: true },
  'lost acknowledgement',
]) {
  test(
    'real native resume ' + JSON.stringify(receipt) + ' never falls back or replays execution',
    async (context) => {
      const state = setup(context);
      const starts = observeRealStartup(context);
      await queuedChat(state);
      const timeout = new NativeRequestTimeout('worker.resume');
      state.native((method, params) => {
        if (method === 'worker.resume') {
          if (receipt === 'lost acknowledgement') {
            throw timeout;
          }

          return receipt;
        }

        return state.defaultNative(method, params);
      });
      await state.tasks.request('bridge.continuePending', reviewed);
      await assert.rejects(starts[0].completion, (error) => {
        if (receipt === 'lost acknowledgement') {
          assert.equal(error, timeout);
        } else {
          assert.equal(error.code, 'RPC_RESULT_INVALID');
          assert.equal(error.method, 'worker.resume');
          assert.equal(error.retryable, false);
        }

        return true;
      });
      const before = state.calls.length;
      context.mock.timers.tick(180000);
      await starts[0].runner.tick();
      assert.equal(state.calls.length, before);
      assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
      assert.equal(
        state.calls.filter((call) => ['worker.import', 'worker.run'].includes(call.method)).length,
        0,
      );
      assert.deepEqual(
        state.pages.filter((page) => ['prepare', 'commit'].includes(page.message.action?.op)),
        [],
      );
      assert.deepEqual(state.creations, []);
    },
  );
}

test('ordinary real Resume retains exact lost-import acknowledgement recovery without importing or sending again', async (context) => {
  const state = setup(context);
  const starts = observeRealStartup(context);
  await queuedChat(state);
  state.checkpoint(
    await pendingCheckpoint({
      stage: 'commit_intent',
      approvedReply: { id: 'batch', hash: 'a'.repeat(64), url: 'https://chatgpt.com/c/original', at: 0 },
    }),
  );
  state.native((method, params) => {
    if (method === 'worker.handoffSeen') {
      assert.equal(params.envelopeId, 'batch');
      return { seen: true };
    }

    return state.defaultNative(method, params);
  });
  assert.equal((await state.tasks.request('bridge.resume', reviewed)).resumed, true);
  await starts[0].completion;
  assert.equal(state.calls.filter((call) => call.method === 'worker.handoffSeen').length, 1);
  assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
  assert.equal(state.calls.filter((call) => ['worker.import', 'worker.run'].includes(call.method)).length, 0);
  assert.deepEqual(state.calls.find((call) => call.method === 'worker.resume').params, {
    ...reviewed,
    epoch: 7,
  });
  assert.deepEqual(state.pages, []);
});

test('real startup allows the exact queued head to be consumed after native resume dispatch, before acknowledgement', async (context) => {
  const state = setup(context);
  const starts = observeRealStartup(context);
  await queuedChat(state);
  const acknowledgement = deferred();
  state.native((method, params) => {
    if (method === 'worker.resume') {
      assert.deepEqual(params, { ...reviewed, epoch: 7 });
      state.worker({ ...state.current.workers[0], queue: [], state: 'executing' });
      state.tasks.update(state.current);
      return acknowledgement.promise;
    }

    return state.defaultNative(method, params);
  });
  await state.tasks.request('bridge.continuePending', reviewed);
  await until(() => state.calls.some((call) => call.method === 'worker.resume'));
  await assert.rejects(state.tasks.request('bridge.continuePending', reviewed), /Stop the current chat/);
  acknowledgement.resolve({ started: true });
  await starts[0].completion;
  assert.equal(starts[0].runner.status.active, true);
  assert.equal(starts[0].runner.status.phase, 'running');
  assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
  assert.deepEqual(
    state.calls.filter((call) => call.method === 'worker.pause'),
    [],
  );
});

test('a late real resume acknowledgement cannot pause, checkpoint or publish a replacement run', async (context) => {
  const state = setup(context);
  const starts = observeRealStartup(context);
  await queuedChat(state);
  const acknowledgement = deferred();
  state.native((method, params) => {
    if (method === 'worker.resume') {
      return acknowledgement.promise;
    }

    return state.defaultNative(method, params);
  });
  await state.tasks.request('bridge.continuePending', reviewed);
  await until(() => state.calls.some((call) => call.method === 'worker.resume'));
  const before = state.calls.length;
  state.worker(changedPendingWorker(state.current.workers[0], 'run'));
  state.tasks.update(state.current);
  const rejected = assert.rejects(starts[0].completion, { code: 'RUN_SUPERSEDED' });
  acknowledgement.resolve({ started: true });
  await rejected;
  assert.equal(starts[0].runner.status.active, false);
  assert.deepEqual(
    state.calls.slice(before).filter((call) => ['worker.pause', 'worker.bridgeSave'].includes(call.method)),
    [],
  );
  assert.equal(
    state.tasks.initialMessages().find((message) => message.event === 'snapshot').data.workers[0].runId,
    'replacement',
  );
  assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
});

test('a late startup state response cannot overwrite a published same-epoch replacement', async (context) => {
  const state = setup(context);
  const starts = observeRealStartup(context);
  await queuedChat(state);
  const reading = deferred();
  let entered = false;
  state.native((method, params) => {
    if (method === 'state' && state.calls.filter((call) => call.method === 'worker.prompt').length === 2) {
      entered = true;
      return reading.promise;
    }

    return state.defaultNative(method, params);
  });
  await state.tasks.request('bridge.continuePending', reviewed);
  await until(() => entered);
  const original = structuredClone(state.current);
  state.worker(changedPendingWorker(state.current.workers[0], 'run'));
  state.tasks.update(state.current);
  const rejected = assert.rejects(starts[0].completion, { code: 'RUN_SUPERSEDED' });
  reading.resolve(original);
  await rejected;
  assert.equal(
    state.tasks.initialMessages().find((message) => message.event === 'snapshot').data.workers[0].runId,
    'replacement',
  );
  assertNoStartupExecution(state);
});

test('pending capacity transfers to the real starting runner without permitting a second execution', async (context) => {
  const state = setup(context);
  const starts = observeRealStartup(context);
  await queuedChat(state);
  const gate = holdStartup(state, starts, 'progress load');
  await state.tasks.request('bridge.continuePending', reviewed);
  await gate.entered;
  assert.equal((await state.tasks.request('bridge.continuePending', reviewed)).result.resumed, true);
  await assert.rejects(state.tasks.request('bridge.start', start), /already starting|running/);
  assert.equal(starts.length, 1);
  assertNoStartupExecution(state);
  gate.release.resolve();
  await starts[0].completion;
  assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
});

test('retired real runner cleanup cannot affect a reset replacement runner or release its ownership', async (context) => {
  const state = setup(context);
  const starts = observeRealStartup(context);
  await queuedChat(state);
  const gate = holdStartup(state, starts, 'progress load');
  await state.tasks.request('bridge.continuePending', reviewed);
  await gate.entered;
  state.tasks.clear();
  state.worker(changedPendingWorker(state.current.workers[0], 'run'));
  const replacement = { workerId: 'worker', expectedRun: { runId: 'replacement', epoch: 7 } };
  await state.tasks.request('bridge.continuePending', replacement);
  await starts[1].completion;
  const before = state.calls.length;
  const rejected = assert.rejects(starts[0].completion, /replaced|reset|superseded/i);
  gate.release.resolve();
  await rejected;
  assert.equal(starts[1].runner.status.active, true);
  assert.equal(starts[1].runner.status.phase, 'running');
  assert.deepEqual(state.calls.slice(before), []);
  assert.equal(state.calls.filter((call) => call.method === 'worker.resume').length, 1);
  assert.deepEqual(state.calls.find((call) => call.method === 'worker.resume').params, {
    ...replacement,
    epoch: 7,
  });
});

test('reviewed chat mutations require valid boundaries and exact resend bytes before admission', async (context) => {
  const state = setup(context);

  for (const method of ['bridge.resume', 'bridge.resend']) {
    for (const expectedRun of [undefined, null, { runId: 'run', epoch: -1 }, { runId: 'run', epoch: 7.5 }]) {
      await assert.rejects(
        state.tasks.request(method, {
          workerId: 'worker',
          expectedRun,
          expectedPrompt: 'Exact',
          confirm: true,
        }),
      );
    }
  }

  await assert.rejects(state.tasks.request('bridge.resend', { ...reviewed, confirm: true }));
  await assert.rejects(
    state.tasks.request('bridge.resend', { ...reviewed, expectedPrompt: 3, confirm: true }),
  );
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.pages, []);
  assert.deepEqual(state.creations, []);
});

for (const method of ['worker.import', 'worker.run', 'worker.resume', 'worker.approve']) {
  test(`${method} validates reviewed run identity and preserves its epoch`, async (context) => {
    const state = setup(context);
    const params = { ...reviewed, ...mutationParams(method) };
    await state.tasks.request(method, params);
    assert.deepEqual(state.calls.at(-1), { method, params: { ...params, epoch: 7 } });
    const before = state.calls.length;
    await assert.rejects(state.tasks.request(method, { ...params, epoch: 8 }), /epoch|boundary/);
    await assert.rejects(
      state.tasks.request(method, { ...params, expectedRun: { runId: 'run', epoch: -1 } }),
    );
    assert.equal(state.calls.length, before);
    state.worker(worker({ runId: 'replacement', control: { ...worker().control, epoch: 7 } }));
    await assert.rejects(state.tasks.request(method, params), /earlier task run|changed/);
    state.worker(worker({ control: { ...worker().control, epoch: 8 } }));
    await assert.rejects(state.tasks.request(method, params), /earlier task run|changed/);
    await assert.rejects(
      state.tasks.request(method, { workerId: 'worker', epoch: 7, ...mutationParams(method) }),
      /epoch|earlier run/,
    );
    assert.equal(state.calls.filter((call) => call.method === method).length, 1);
  });

  test(`Stop during ${method} state admission cannot refresh an old intent into a new epoch`, async (context) => {
    const state = setup(context);
    const preflight = deferred();
    const original = state.current;
    let first = true;
    state.native(async (nativeMethod) => {
      if (nativeMethod === 'state') {
        if (first) {
          first = false;
          return preflight.promise;
        }

        return state.current;
      }

      return { ready: true };
    });
    const applying = state.tasks.request(method, { ...reviewed, ...mutationParams(method) });
    await until(() => state.calls.some((call) => call.method === 'state'));
    await state.tasks.request('bridge.halt', { workerId: 'worker' });
    const rejected = assert.rejects(applying, /superseded/);
    preflight.resolve(original);
    await rejected;
    assert.equal(
      state.calls.some((call) => call.method === method),
      false,
    );
  });
}

test('exact post-import delivery starts preserve proof fields and the pre-import reviewed epoch', async (context) => {
  const state = setup(context);
  state.worker(worker({ runId: 'post-import-run' }));
  const delivery = { ...reviewed, epoch: 7, envelopeId: 'accepted-batch', envelopeHash: 'a'.repeat(64) };
  await state.tasks.request('worker.run', delivery);
  assert.deepEqual(state.calls.at(-1), { method: 'worker.run', params: delivery });
  await state.tasks.request('worker.run', {
    workerId: 'worker',
    epoch: 7,
    envelopeId: 'accepted-batch',
    envelopeHash: 'a'.repeat(64),
  });
  assert.equal(state.calls.at(-1).params.epoch, 7);
  state.worker(worker({ runId: 'post-import-run', control: { ...worker().control, epoch: 8 } }));
  await assert.rejects(state.tasks.request('worker.run', delivery), /earlier task run|epoch/);
  const before = state.calls.length;
  await assert.rejects(state.tasks.request('worker.run', { ...reviewed, envelopeId: 'accepted-batch' }));
  assert.equal(state.calls.length, before);
});

test('legacy supplied epochs are preserved, not silently replaced by a fresh host epoch', async (context) => {
  const state = setup(context);
  await state.tasks.request('worker.run', { workerId: 'worker', epoch: 7 });
  assert.deepEqual(state.calls.at(-1), { method: 'worker.run', params: { workerId: 'worker', epoch: 7 } });
  await assert.rejects(
    state.tasks.request('worker.run', { workerId: 'worker', epoch: 999 }),
    /earlier run epoch/,
  );
  assert.equal(state.calls.filter((call) => call.method === 'worker.run').length, 1);
});

test('internal fresh continuation remains compatible without a UI reviewed boundary', async (context) => {
  const state = setup(context);
  state.permission(false);
  await assert.rejects(
    state.tasks.request('bridge.continueFresh', { workerId: 'worker' }),
    /Open the saved conversation/,
  );
  assert.equal(state.calls[0].method, 'worker.continueFresh');
  assert.equal(state.permissionChecks, 1);
  assert.deepEqual(await state.tasks.request('bridge.extend', { workerId: 'worker', confirm: true }), {
    resumed: false,
  });
});

test('admission timeouts retain native timeout identity and never retry a mutation', async (context) => {
  const state = setup(context);
  const timeout = new NativeRequestTimeout('state');
  state.native(async () => {
    throw timeout;
  });

  for (const method of ['bridge.resume', 'worker.import', 'worker.run', 'worker.resume', 'worker.approve']) {
    await assert.rejects(
      state.tasks.request(method, { ...reviewed, ...mutationParams(method) }),
      (error) => error === timeout,
    );
  }

  assert.deepEqual(
    state.calls.map((call) => call.method),
    ['state', 'state', 'state', 'state', 'state'],
  );
  assert.deepEqual(state.pages, []);
});

test('Stop while receiver readiness is pending fences reviewed resume before host or tab work', async (context) => {
  const state = setup(context);
  const readiness = deferred();
  state.ready(() => readiness.promise);
  const resuming = state.tasks.request('bridge.resume', reviewed);
  state.ready(async () => {});
  await state.tasks.request('bridge.halt', { workerId: 'worker' });
  const before = state.calls.length;
  const rejected = assert.rejects(resuming, /superseded/);
  readiness.resolve();
  await rejected;
  assert.equal(state.calls.length, before);
  assert.deepEqual(state.creations, []);
});

test('reset retirement fences a forwarded admission even after readiness and task maps are cleared', async (context) => {
  const state = setup(context);
  const preflight = deferred();
  state.native(() => preflight.promise);
  const applying = state.tasks.request('worker.run', reviewed);
  await until(() => state.calls.some((call) => call.method === 'state'));
  await state.tasks.quiesce();
  state.tasks.clear();
  const rejected = assert.rejects(applying, /superseded|reset/);
  preflight.resolve(state.current);
  await rejected;
  assert.equal(
    state.calls.some((call) => call.method === 'worker.run'),
    false,
  );
});

test('Stop during Resume state admission prevents permission and saved-chat work', async (context) => {
  const state = setup(context);
  const preflight = deferred();
  const original = state.current;
  let first = true;
  state.native(async (method) => {
    if (method === 'state') {
      if (first) {
        first = false;
        return preflight.promise;
      }

      return state.current;
    }

    return { ready: true };
  });
  const resuming = state.tasks.request('bridge.resume', reviewed);
  await until(() => state.calls.some((call) => call.method === 'state'));
  await state.tasks.request('bridge.halt', { workerId: 'worker' });
  const rejected = assert.rejects(resuming, /superseded/);
  preflight.resolve(original);
  await rejected;
  assert.equal(state.permissionChecks, 0);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
});

test('a monitoring Resume checks fresh run identity before polling the original runner', async (context) => {
  const state = setup(context);
  context.mock.method(BridgeRunner.prototype, 'start', async function () {
    this.status.monitoring = true;
    this.status.active = false;
  });
  const tick = context.mock.method(BridgeRunner.prototype, 'tick', async () => {});
  await state.tasks.request('bridge.start', start);
  const result = await state.tasks.request('bridge.resume', reviewed);
  assert.equal(result.resumed, true);
  assert.equal(tick.mock.callCount(), 1);
  state.worker(worker({ runId: 'replacement' }));
  await assert.rejects(state.tasks.request('bridge.resume', reviewed), /earlier task run/);
  assert.equal(tick.mock.callCount(), 1);
});

for (const method of ['bridge.resume', 'bridge.resend']) {
  test(`${method} cannot overwrite a published replacement with a late preflight snapshot`, async (context) => {
    const state = setup(context);
    context.mock.method(BridgeRunner.prototype, 'start', async function () {
      this.status.monitoring = true;
      this.status.active = false;
    });
    const tick = context.mock.method(BridgeRunner.prototype, 'tick', async () => {});
    const resend = context.mock.method(BridgeRunner.prototype, 'resendPrompt', async () => ({ sent: true }));
    await state.tasks.request('bridge.start', start);
    const original = state.current;
    const preflight = deferred();
    state.native(() => preflight.promise);
    const before = state.calls.length;
    const applying = state.tasks.request(method, { ...reviewed, confirm: true, expectedPrompt: 'Exact' });
    await until(() => state.calls.length > before);
    state.worker(worker({ runId: 'replacement' }));
    state.tasks.update(state.current);
    const rejected = assert.rejects(applying, /earlier task run/);
    preflight.resolve(original);
    await rejected;
    assert.equal(tick.mock.callCount(), 0);
    assert.equal(resend.mock.callCount(), 0);
    assert.equal(
      state.tasks.initialMessages().find((message) => message.event === 'snapshot').data.workers[0].runId,
      'replacement',
    );
  });
}

test('a published replacement fences Resume immediately after permission returns', async (context) => {
  const state = setup(context);
  linkedReply(state);
  const permission = deferred();
  state.permission(permission.promise);
  const resuming = state.tasks.request('bridge.resume', reviewed);
  await until(() => state.permissionChecks === 1);
  state.worker(worker({ runId: 'replacement' }));
  state.tasks.update(state.current);
  const before = state.calls.length;
  const rejected = assert.rejects(resuming, /earlier task run/);
  permission.resolve(false);
  await rejected;
  assert.equal(state.calls.length, before);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
});

test('Resume rejects a same-epoch replacement after permission preflight without a snapshot event', async (context) => {
  const state = setup(context);
  linkedReply(state);
  const permission = deferred();
  state.permission(permission.promise);
  const resuming = state.tasks.request('bridge.resume', reviewed);
  await until(() => state.permissionChecks === 1);
  state.worker(worker({ runId: 'replacement' }));
  const rejected = assert.rejects(resuming, /earlier task run|changed/);
  permission.resolve(true);
  await rejected;
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
  const statuses = await state.tasks.request('bridge.list', {});
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].active, false);
  assert.equal(statuses[0].reason, 'Progress saved. Resume continues in the same chat.');
});

test('Resume fences a replacement while durable queue proof is being read', async (context) => {
  const state = setup(context);
  const checkpoint = deferred();
  const task = worker({
    queue: [
      {
        protocol: 'mitter/1',
        id: 'batch',
        workerId: 'worker',
        projectId: 'project',
        summary: 'Batch',
        actions: [{ type: 'finish', summary: 'Done' }],
      },
    ],
  });
  state.worker(task);
  state.native(async (method) => {
    if (method === 'state') {
      return state.current;
    }

    return checkpoint.promise;
  });
  const resuming = state.tasks.request('bridge.resume', reviewed);
  await until(() => state.calls.some((call) => call.method === 'worker.bridgeLoad'));
  state.worker({ ...task, runId: 'replacement' });
  const rejected = assert.rejects(resuming, /earlier task run|changed/);
  checkpoint.resolve({ progress: progress({ lastImportedId: 'batch' }), importedCount: 1 });
  await rejected;
  assert.equal(state.permissionChecks, 0);
  assert.deepEqual(state.creations, []);
});

test('Resume cannot register a runner after the run changes during tab creation', async (context) => {
  context.mock.method(console, 'warn', () => {});
  const state = setup(context);
  linkedReply(state);
  state.tabs.clear();
  const creation = deferred();
  state.create(() => creation.promise);
  const starting = context.mock.method(BridgeRunner.prototype, 'start', async () => {});
  const resuming = state.tasks.request('bridge.resume', reviewed);
  await until(() => state.creations.length === 1);
  state.worker(worker({ runId: 'replacement' }));
  const rejected = assert.rejects(resuming, /earlier task run|changed/);
  creation.resolve({ id: 9, url: 'https://chatgpt.com/c/conversation' });
  await rejected;
  assert.equal(starting.mock.callCount(), 0);
  assert.deepEqual(state.pages, []);
});

test('Resend passes byte-exact reviewed text only to the original run-bound runner', async (context) => {
  const state = setup(context);
  let original;
  context.mock.method(BridgeRunner.prototype, 'start', async function () {
    original = this;
    this.status.monitoring = true;
    this.status.active = false;
  });
  const resend = context.mock.method(BridgeRunner.prototype, 'resendPrompt', async () => ({ sent: true }));
  await state.tasks.request('bridge.start', start);
  const expectedPrompt = ' Exact reviewed prompt\r\n\n';
  assert.deepEqual(
    await state.tasks.request('bridge.resend', { ...reviewed, confirm: true, expectedPrompt }),
    { sent: true },
  );
  assert.deepEqual(resend.mock.calls[0].arguments, [true, expectedPrompt]);
  assert.equal(resend.mock.calls[0].this, original);
  state.worker(worker({ runId: 'replacement' }));
  await assert.rejects(
    state.tasks.request('bridge.resend', { ...reviewed, confirm: true, expectedPrompt }),
    /earlier task run|changed/,
  );
  await assert.rejects(
    state.tasks.request('bridge.resend', {
      ...reviewed,
      expectedRun: { runId: 'replacement', epoch: 7 },
      confirm: true,
      expectedPrompt,
    }),
    /earlier task run|changed/,
  );
  const tick = context.mock.method(BridgeRunner.prototype, 'tick', async () => {});
  await assert.rejects(
    state.tasks.request('bridge.resume', { ...reviewed, expectedRun: { runId: 'replacement', epoch: 7 } }),
    /earlier task run|changed/,
  );
  assert.equal(resend.mock.callCount(), 1);
  assert.equal(tick.mock.callCount(), 0);
});

test('a replacement runner cannot inherit Resend admitted against the original runner', async (context) => {
  const state = setup(context);
  context.mock.method(BridgeRunner.prototype, 'start', async function () {
    this.status.monitoring = true;
    this.status.active = false;
  });
  const resend = context.mock.method(BridgeRunner.prototype, 'resendPrompt', async () => ({ sent: true }));
  await state.tasks.request('bridge.start', start);
  const preflight = deferred();
  let first = true;
  state.native(async (method) => {
    if (method === 'state') {
      if (first) {
        first = false;
        return preflight.promise;
      }

      return state.current;
    }

    return { progress: null, importedCount: 0 };
  });
  const before = state.calls.length;
  const resending = state.tasks.request('bridge.resend', {
    ...reviewed,
    confirm: true,
    expectedPrompt: 'Exact',
  });
  await until(() => state.calls.length > before);
  state.tasks.clear();
  await state.tasks.request('bridge.start', start);
  const rejected = assert.rejects(resending, /conversation changed|runner changed/);
  preflight.resolve(state.current);
  await rejected;
  assert.equal(resend.mock.callCount(), 0);
});

test('unsupported, reset-blocked, and disposed requests never reach native or page transport', async (context) => {
  const state = setup(context);
  await assert.rejects(state.tasks.request('worker.bridgeSave', {}), /Unknown request method/);
  state.blocked(true);
  await assert.rejects(state.tasks.request('worker.run', { workerId: 'worker' }), /reset/);
  state.blocked(false);
  state.tasks.dispose();
  await assert.rejects(state.tasks.request('rewrite.start', { request: rewrite, consent: true }), /reset/);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.pages, []);
  assert.deepEqual(state.creations, []);
});

test('Start returns a wire-preserved admitted identity distinct from a same-run replacement', async (context) => {
  const state = setup(context);
  const lifecycle = mockChatLifecycle(context);
  const first = parseLocalResult('bridge.start', await state.tasks.request('bridge.start', start));
  assert.equal(typeof first.admissionId, 'string');
  assert.notEqual(first.admissionId, '');
  assert.deepEqual(first.expectedRun, reviewed.expectedRun);
  lifecycle.runners[0].status.active = false;
  const replacement = parseLocalResult('bridge.start', await state.tasks.request('bridge.start', start));
  assert.notEqual(replacement.admissionId, first.admissionId);
  assert.deepEqual(replacement.expectedRun, first.expectedRun);
});

test('owned cleanup requires both admitted identity and the original boundary before readiness', async (context) => {
  const state = setup(context);
  let readinessCalls = 0;
  state.ready(async () => {
    readinessCalls++;
  });

  for (const params of [
    { workerId: 'worker' },
    { ...reviewed },
    { workerId: 'worker', admissionId: 'admission' },
    { ...reviewed, admissionId: '' },
    { ...reviewed, admissionId: 'admission', expectedRun: { runId: 'run', epoch: -1 } },
  ]) {
    await assert.rejects(state.tasks.request('bridge.stopStarted', params));
  }

  assert.equal(readinessCalls, 0);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.pages, []);
});

test('a disposed form cannot stop a replacement runner even with the same native run and epoch', async (context) => {
  const state = setup(context);
  const lifecycle = mockChatLifecycle(context);
  const admitted = await state.tasks.request('bridge.start', start);
  lifecycle.runners[0].status.active = false;
  await state.tasks.request('bridge.start', start);
  const before = state.calls.length;
  const result = await state.tasks.request('bridge.stopStarted', {
    workerId: 'worker',
    admissionId: admitted.admissionId,
    expectedRun: admitted.expectedRun,
  });
  assert.deepEqual(parseLocalResult('bridge.stopStarted', result), { stopped: false });
  assert.deepEqual(lifecycle.stopped, []);
  assert.equal(lifecycle.runners[1].status.active, true);
  assert.equal(state.calls.length, before);
});

test('owned cleanup stops its exact current runner once, without import or send replay', async (context) => {
  const state = setup(context);
  const lifecycle = mockChatLifecycle(context);
  const admitted = await state.tasks.request('bridge.start', start);
  const params = { workerId: 'worker', admissionId: admitted.admissionId, expectedRun: admitted.expectedRun };
  const before = state.calls.length;
  assert.deepEqual(await state.tasks.request('bridge.stopStarted', params), { stopped: true });
  assert.deepEqual(lifecycle.stopped, [lifecycle.runners[0]]);
  assert.deepEqual(
    state.calls.slice(before).map((call) => call.method),
    ['state'],
  );
  const after = state.calls.length;
  assert.deepEqual(await state.tasks.request('bridge.stopStarted', params), { stopped: false });
  assert.equal(state.calls.length, after);
  assert.deepEqual(state.pages, []);
});

for (const expectedRun of [
  { runId: 'other-run', epoch: 7 },
  { runId: 'run', epoch: 8 },
]) {
  test(`owned cleanup cannot borrow an admission with ${JSON.stringify(expectedRun)}`, async (context) => {
    const state = setup(context);
    const lifecycle = mockChatLifecycle(context);
    const admitted = await state.tasks.request('bridge.start', start);
    const before = state.calls.length;
    assert.deepEqual(
      await state.tasks.request('bridge.stopStarted', {
        workerId: 'worker',
        admissionId: admitted.admissionId,
        expectedRun,
      }),
      { stopped: false },
    );
    assert.deepEqual(lifecycle.stopped, []);
    assert.equal(state.calls.length, before);
  });
}

test('owned cleanup reads fresh native run identity rather than stopping a stale original runner', async (context) => {
  const state = setup(context);
  const lifecycle = mockChatLifecycle(context);
  const admitted = await state.tasks.request('bridge.start', start);
  state.worker(worker({ runId: 'replacement' }));
  assert.deepEqual(
    await state.tasks.request('bridge.stopStarted', {
      workerId: 'worker',
      admissionId: admitted.admissionId,
      expectedRun: admitted.expectedRun,
    }),
    { stopped: false },
  );
  assert.deepEqual(lifecycle.stopped, []);
  assert.equal(lifecycle.runners[0].status.active, true);
});

for (const stage of ['readiness', 'state']) {
  test(`owned cleanup cannot retarget a runner replaced during ${stage}`, async (context) => {
    const state = setup(context);
    const lifecycle = mockChatLifecycle(context);
    const admitted = await state.tasks.request('bridge.start', start);
    const pending = deferred();
    const original = state.current;
    const before = state.calls.length;

    if (stage === 'readiness') {
      state.ready(() => pending.promise);
    } else {
      let first = true;
      state.native(async (method) => {
        if (method === 'state') {
          if (first) {
            first = false;
            return pending.promise;
          }

          return state.current;
        }

        return { progress: null, importedCount: 0 };
      });
    }

    const cleanup = state.tasks.request('bridge.stopStarted', {
      workerId: 'worker',
      admissionId: admitted.admissionId,
      expectedRun: admitted.expectedRun,
    });

    if (stage === 'state') {
      await until(() => state.calls.length > before);
    }

    state.tasks.clear();
    state.ready(async () => {});
    await state.tasks.request('bridge.start', start);
    pending.resolve(original);
    assert.deepEqual(await cleanup, { stopped: false });
    assert.deepEqual(lifecycle.stopped, []);
    assert.equal(lifecycle.runners[1].status.active, true);
  });
}

test('a cleanup preflight timeout preserves identity and releases its own capacity without retry', async (context) => {
  const state = setup(context);
  const lifecycle = mockChatLifecycle(context);
  const admitted = await state.tasks.request('bridge.start', start);
  const timeout = new NativeRequestTimeout('state');
  state.native(async () => {
    throw timeout;
  });
  const before = state.calls.length;
  await assert.rejects(
    state.tasks.request('bridge.stopStarted', {
      workerId: 'worker',
      admissionId: admitted.admissionId,
      expectedRun: admitted.expectedRun,
    }),
    (error) => error === timeout,
  );
  assert.deepEqual(
    state.calls.slice(before).map((call) => call.method),
    ['state'],
  );
  assert.deepEqual(lifecycle.stopped, []);
  lifecycle.runners[0].status.active = false;
  state.native(async (method) => {
    if (method === 'state') {
      return state.current;
    }

    return { progress: null, importedCount: 0 };
  });
  await state.tasks.request('bridge.start', start);
  assert.equal(lifecycle.runners.length, 2);
});

test('a late cleanup preflight cannot overwrite a published replacement task boundary', async (context) => {
  const state = setup(context);
  const lifecycle = mockChatLifecycle(context);
  const admitted = await state.tasks.request('bridge.start', start);
  const original = state.current;
  const pending = deferred();
  state.native(() => pending.promise);
  const before = state.calls.length;
  const cleanup = state.tasks.request('bridge.stopStarted', {
    workerId: 'worker',
    admissionId: admitted.admissionId,
    expectedRun: admitted.expectedRun,
  });
  await until(() => state.calls.length > before);
  state.worker(worker({ runId: 'replacement' }));
  state.tasks.update(state.current);
  pending.resolve(original);
  assert.deepEqual(await cleanup, { stopped: false });
  assert.deepEqual(lifecycle.stopped, []);
  assert.equal(
    state.tasks.initialMessages().find((message) => message.event === 'snapshot').data.workers[0].runId,
    'replacement',
  );
});

test('owned cleanup holds start capacity until its original runner finishes stopping', async (context) => {
  const state = setup(context);
  mockChatLifecycle(context);
  const admitted = await state.tasks.request('bridge.start', start);
  const stopping = deferred();
  let stopped = false;
  context.mock.method(BridgeRunner.prototype, 'stop', async function () {
    this.status.active = false;
    stopped = true;
    await stopping.promise;
  });
  const cleanup = state.tasks.request('bridge.stopStarted', {
    workerId: 'worker',
    admissionId: admitted.admissionId,
    expectedRun: admitted.expectedRun,
  });
  await until(() => stopped);
  await assert.rejects(state.tasks.request('bridge.start', start), /already starting/);
  stopping.resolve();
  assert.deepEqual(await cleanup, { stopped: true });
  await state.tasks.request('bridge.start', start);
  assert.equal(state.creations.length, 2);
});

test('cleanup-side native pause and checkpoint retain the original run after dispatch', async (context) => {
  const state = setup(context);
  context.mock.method(BridgeRunner.prototype, 'start', async () => {});
  const admitted = await state.tasks.request('bridge.start', start);
  const mutations = [];
  state.native(async (method, params) => {
    if (method === 'state') {
      return state.current;
    }

    if (method === 'worker.pause' || method === 'worker.bridgeSave') {
      assert.deepEqual(params.expectedRun, reviewed.expectedRun);

      if (params.expectedRun.runId !== state.current.workers[0].runId) {
        throw new Error('The native receiver rejected cleanup from the earlier run.');
      }

      mutations.push(method);
    }

    return params.progress;
  });
  context.mock.method(BridgeRunner.prototype, 'stop', async function () {
    this.status.active = false;
    state.worker(worker({ runId: 'replacement' }));
    state.tasks.update(state.current);
    await this.dependencies.rpc('worker.pause', { workerId: 'worker', epoch: 7 }).catch(() => {});
    await this.dependencies.saveProgress(progress(), 7).catch(() => {});
  });
  const before = state.calls.length;
  assert.deepEqual(
    await state.tasks.request('bridge.stopStarted', {
      workerId: 'worker',
      admissionId: admitted.admissionId,
      expectedRun: admitted.expectedRun,
    }),
    { stopped: true },
  );
  assert.deepEqual(
    state.calls.slice(before).map((call) => call.method),
    ['state', 'worker.pause', 'worker.bridgeSave'],
  );
  assert.deepEqual(mutations, []);
  assert.deepEqual(state.pages, []);
});

test('ordinary user Stop still targets the current runner without requiring an admitted identity', async (context) => {
  const state = setup(context);
  const lifecycle = mockChatLifecycle(context);
  await state.tasks.request('bridge.start', start);
  lifecycle.runners[0].status.active = false;
  await state.tasks.request('bridge.start', start);
  assert.deepEqual(await state.tasks.request('bridge.stop', { workerId: 'worker' }), { stopped: true });
  assert.deepEqual(lifecycle.stopped, [lifecycle.runners[1]]);
  assert.equal(lifecycle.runners[1].status.active, false);
});

test('Start requires a valid reviewed boundary before readiness or any host work', async (context) => {
  const state = setup(context);
  let readinessCalls = 0;
  state.ready(async () => {
    readinessCalls++;
  });

  for (const expectedRun of [
    undefined,
    null,
    { runId: 'run' },
    { runId: 1, epoch: 7 },
    { runId: 'run', epoch: '7' },
    { runId: 'run', epoch: -1 },
    { runId: 'run', epoch: 7.5 },
    { runId: 'run', epoch: 7, ignored: true },
  ]) {
    await assert.rejects(state.tasks.request('bridge.start', { ...start, expectedRun }));
  }

  assert.equal(readinessCalls, 0);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
});

for (const expectedRun of [
  { runId: 'earlier-run', epoch: 7 },
  { runId: 'run', epoch: 6 },
]) {
  test(`Start rejects a valid but contradictory ${JSON.stringify(expectedRun)} boundary`, async (context) => {
    const state = setup(context);
    const starting = context.mock.method(BridgeRunner.prototype, 'start', async () => {});
    await assert.rejects(state.tasks.request('bridge.start', { ...start, expectedRun }), /earlier task run/);
    assert.equal(starting.mock.callCount(), 0);
    assert.equal(state.permissionChecks, 0);
    assert.deepEqual(state.creations, []);
    assert.deepEqual(state.pages, []);
  });
}

test('Start captures Stop ownership before readiness even if a newer epoch is rearmed', async (context) => {
  const state = setup(context);
  const readiness = deferred();
  state.ready(() => readiness.promise);
  const starting = state.tasks.request('bridge.start', start);
  state.ready(async () => {});
  await state.tasks.request('bridge.halt', { workerId: 'worker' });
  state.worker(worker({ control: { ...worker().control, epoch: 8, mode: 'fresh' } }));
  state.tasks.update(state.current);
  const before = state.calls.length;
  const rejected = assert.rejects(starting, /superseded/);
  readiness.resolve();
  await rejected;
  assert.equal(state.calls.length, before);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
});

test('reset completion cannot restore Start authority while readiness is pending', async (context) => {
  const state = setup(context);
  const readiness = deferred();
  state.ready(() => readiness.promise);
  const starting = state.tasks.request('bridge.start', start);
  await state.tasks.quiesce();
  state.tasks.clear();
  const rejected = assert.rejects(starting, /superseded|reset/);
  readiness.resolve();
  await rejected;
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
});

test('retired Start cleanup cannot release a replacement admission’s capacity after reset', async (context) => {
  const state = setup(context);
  const oldReadiness = deferred();
  state.ready(() => oldReadiness.promise);
  const retired = state.tasks.request('bridge.start', start);
  await state.tasks.quiesce();
  state.tasks.clear();
  state.ready(async () => {});
  const permission = deferred();
  state.permission(permission.promise);
  const starting = context.mock.method(BridgeRunner.prototype, 'start', async () => {});
  const replacement = state.tasks.request('bridge.start', start);
  await until(() => state.permissionChecks === 1);
  const retiredRejected = assert.rejects(retired, /superseded|reset/);
  oldReadiness.resolve();
  await retiredRejected;
  const concurrentRejected = assert.rejects(state.tasks.request('bridge.start', start), /already starting/);
  await settle();
  permission.resolve(true);
  await Promise.all([replacement, concurrentRejected]);
  assert.equal(starting.mock.callCount(), 1);
  assert.equal(state.creations.length, 1);
});

for (const stage of ['readiness', 'state', 'permission', 'checkpoint', 'tab']) {
  test(`Start fences a same-epoch run replacement during ${stage} admission`, async (context) => {
    const state = setup(context);
    const pending = deferred();
    const original = state.current;
    const starting = context.mock.method(BridgeRunner.prototype, 'start', async () => {});

    if (stage === 'readiness') {
      state.ready(() => pending.promise);
    } else if (stage === 'permission') {
      state.permission(pending.promise);
    } else if (stage === 'tab') {
      state.create(() => pending.promise);
    }

    state.native(async (method) => {
      if (method === 'state') {
        if (stage === 'state') {
          return pending.promise;
        }

        return state.current;
      }

      if (method === 'worker.bridgeLoad') {
        if (stage === 'checkpoint') {
          return pending.promise;
        }

        return { progress: null, importedCount: 0 };
      }

      return { ready: true };
    });
    const request = state.tasks.request('bridge.start', start);

    if (stage === 'state') {
      await until(() => state.calls.some((call) => call.method === 'state'));
    } else if (stage === 'permission') {
      await until(() => state.permissionChecks === 1);
    } else if (stage === 'checkpoint') {
      await until(() => state.calls.some((call) => call.method === 'worker.bridgeLoad'));
    } else if (stage === 'tab') {
      await until(() => state.creations.length === 1);
    }

    state.worker(worker({ runId: 'replacement' }));

    if (stage === 'state') {
      state.tasks.update(state.current);
    }

    const rejected = assert.rejects(request, /earlier task run|changed/);

    if (stage === 'state') {
      pending.resolve(original);
    } else if (stage === 'checkpoint') {
      pending.resolve({ progress: null, importedCount: 0 });
    } else if (stage === 'tab') {
      pending.resolve({ id: 7, url: 'https://chatgpt.com/', autoDiscardable: true });
    } else {
      pending.resolve(true);
    }

    await rejected;
    assert.equal(starting.mock.callCount(), 0);
    assert.deepEqual(state.pages, []);

    if (stage === 'state') {
      assert.equal(
        state.tasks.initialMessages().find((message) => message.event === 'snapshot').data.workers[0].runId,
        'replacement',
      );
    }
  });
}

test('Start reserves capacity before readiness and permits only one first-create dispatch', async (context) => {
  const state = setup(context);
  const readiness = deferred();
  state.ready(() => readiness.promise);
  const starting = context.mock.method(BridgeRunner.prototype, 'start', async () => {});
  const request = state.tasks.request('bridge.start', start);
  state.ready(async () => {});
  await assert.rejects(state.tasks.request('bridge.start', start), /already starting/);
  assert.deepEqual(state.calls, []);
  readiness.resolve();
  const result = await request;
  assert.equal(result.workerId, 'worker');
  assert.equal(result.tabId, 101);
  assert.equal(starting.mock.callCount(), 1);
  assert.equal(state.creations.length, 1);
  assert.equal(state.calls.filter((call) => call.method === 'state').length, 4);
  assert.deepEqual(state.pages, []);
});

test('Start cannot dispatch after replacement during its final fresh read and releases the tab reservation', async (context) => {
  const state = setup(context);
  const predispatch = deferred();
  let stateReads = 0;
  state.native(async (method) => {
    if (method === 'state') {
      stateReads++;

      if (stateReads === 4) {
        return predispatch.promise;
      }

      return state.current;
    }

    return { progress: null, importedCount: 0 };
  });
  const starting = context.mock.method(BridgeRunner.prototype, 'start', async () => {});
  const request = state.tasks.request('bridge.start', start);
  await until(() => stateReads === 4);
  state.worker(worker({ runId: 'replacement' }));
  const rejected = assert.rejects(request, /earlier task run/);
  predispatch.resolve(state.current);
  await rejected;
  assert.equal(starting.mock.callCount(), 0);
  assert.deepEqual(state.pages, []);
  state.worker(worker({ id: 'other', runId: 'other-run' }));
  const result = await state.tasks.request('bridge.start', {
    workerId: 'other',
    expectedRun: { runId: 'other-run', epoch: 7 },
    consent: true,
    tabId: 101,
  });
  assert.equal(result.tabId, 101);
  assert.equal(starting.mock.callCount(), 1);
  assert.equal(state.creations.length, 1);
});

test('Start rechecks published ownership after its final snapshot read returns', async (context) => {
  const state = setup(context);
  let stateReads = 0;
  let replaced = false;
  state.native(async (method) => {
    if (method === 'state') {
      stateReads++;
      return state.current;
    }

    return { progress: null, importedCount: 0 };
  });
  state.broadcast((message) => {
    if (!replaced && stateReads === 4 && message.event === 'snapshot') {
      replaced = true;
      state.worker(worker({ runId: 'replacement' }));
      state.tasks.update(state.current);
    }
  });
  const starting = context.mock.method(BridgeRunner.prototype, 'start', async () => {});
  await assert.rejects(state.tasks.request('bridge.start', start), /earlier task run/);
  assert.equal(replaced, true);
  assert.equal(starting.mock.callCount(), 0);
  assert.deepEqual(state.pages, []);
});

test('a final Start admission timeout retains identity and cannot replay a send or retain its reservation', async (context) => {
  const state = setup(context);
  const timeout = new NativeRequestTimeout('state');
  let stateReads = 0;
  state.native(async (method) => {
    if (method === 'state') {
      stateReads++;

      if (stateReads === 4) {
        throw timeout;
      }

      return state.current;
    }

    return { progress: null, importedCount: 0 };
  });
  const starting = context.mock.method(BridgeRunner.prototype, 'start', async () => {});
  await assert.rejects(state.tasks.request('bridge.start', start), (error) => error === timeout);
  assert.equal(stateReads, 4);
  assert.equal(starting.mock.callCount(), 0);
  assert.deepEqual(state.pages, []);
  state.worker(worker({ id: 'other', runId: 'other-run' }));
  await state.tasks.request('bridge.start', {
    workerId: 'other',
    expectedRun: { runId: 'other-run', epoch: 7 },
    consent: true,
    tabId: 101,
  });
  assert.equal(starting.mock.callCount(), 1);
  assert.equal(state.creations.length, 1);
});

test('Start with a checkpoint keeps the saved conversation instead of opening a fresh chat', async (context) => {
  const state = setup(context);
  const { view } = linkedReply(state);
  state.native(async (method) => {
    if (method === 'state') {
      return state.current;
    }

    return { progress: progress({ lastImportedId: 'saved-batch' }), importedCount: 1 };
  });
  const starting = context.mock.method(BridgeRunner.prototype, 'start', async () => {});
  const result = await state.tasks.request('bridge.start', start);
  assert.equal(result.tabId, 7);
  assert.equal(result.url, view.url);
  assert.equal(starting.mock.callCount(), 1);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
});

test('Start can replace an inactive old runner when a newly reviewed run owns the task', async (context) => {
  const state = setup(context);
  const starting = context.mock.method(BridgeRunner.prototype, 'start', async function () {
    this.status.active = false;
  });
  await state.tasks.request('bridge.start', start);
  state.worker(worker({ runId: 'replacement' }));
  state.tasks.update(state.current);
  const result = await state.tasks.request('bridge.start', {
    ...start,
    expectedRun: { runId: 'replacement', epoch: 7 },
  });
  assert.equal(result.workerId, 'worker');
  assert.equal(starting.mock.callCount(), 2);
});

for (const replacement of [
  { reason: 'a result awaiting approval', changes: { humanAcceptanceReady: true } },
  {
    reason: 'a local batch',
    changes: {
      queue: [
        {
          protocol: 'mitter/1',
          id: 'new-batch',
          workerId: 'worker',
          projectId: 'project',
          summary: 'New local work',
          actions: [{ type: 'finish', summary: 'Done' }],
        },
      ],
    },
  },
]) {
  test(`Start superseded by ${replacement.reason} cannot dispatch a runner`, async (context) => {
    const state = setup(context);
    const creation = deferred();
    state.create(() => creation.promise);
    const starting = context.mock.method(BridgeRunner.prototype, 'start', async () => {});
    const request = state.tasks.request('bridge.start', start);
    await until(() => state.creations.length === 1);
    state.worker(worker(replacement.changes));
    const rejected = assert.rejects(request, /pending local work|result ready for review/);
    creation.resolve({ id: 7, url: 'https://chatgpt.com/', autoDiscardable: true });
    await rejected;
    assert.equal(starting.mock.callCount(), 0);
    assert.deepEqual(state.pages, []);
  });
}

test('Stop supersedes a Start waiting for tab creation without any later send or import', async (context) => {
  const state = setup(context);
  const creation = deferred();
  state.create(() => creation.promise);
  const starting = state.tasks.request('bridge.start', start);
  await until(() => state.creations.length === 1);
  await state.tasks.request('bridge.halt', { workerId: 'worker', id: 'stop-operation' });
  creation.resolve({ id: 7, url: 'https://chatgpt.com/', autoDiscardable: true });
  await assert.rejects(starting, /superseded by Stop or Steer/);
  assert.deepEqual(
    state.calls.map((call) => call.method),
    ['state', 'state', 'worker.bridgeLoad', 'state', 'worker.stop', 'state'],
  );
  assert.deepEqual(state.calls[4].params, { workerId: 'worker', id: 'stop-operation' });
  assert.deepEqual(state.pages, []);
  assert.deepEqual(await state.tasks.request('bridge.list', {}), []);
});

test('malformed stop, restore, and rollback requests cannot stop a runner or dispatch native work', async (context) => {
  const state = setup(context);
  context.mock.method(BridgeRunner.prototype, 'start', async () => {});
  const stopping = context.mock.method(BridgeRunner.prototype, 'stop', async () => {});
  await state.tasks.request('bridge.start', start);
  const before = state.calls.length;
  const invalid = [
    ['bridge.halt', { workerId: 'worker', id: null }],
    ['bridge.halt', { workerId: 'worker', id: [] }],
    ['bridge.pause', { workerId: 'worker', epoch: null }],
    ['bridge.pause', { workerId: 'worker', expectedRun: null }],
    [
      'worker.restoreFile',
      { workerId: 'worker', path: '../secret', expectedHash: 'a'.repeat(64), confirm: true },
    ],
    ['worker.restoreFile', { workerId: 'worker', path: 'file.ts', expectedHash: null, confirm: true }],
    [
      'worker.restoreFile',
      { workerId: 'worker', path: 'file.ts', expectedHash: 'a'.repeat(64), confirm: false },
    ],
    [
      'worker.restoreFile',
      { workerId: 'worker', path: 'file.ts', expectedHash: 'a'.repeat(64), confirm: true, expectedRun: null },
    ],
    ['worker.rollback', { workerId: 'worker', confirm: 'true' }],
    ['worker.rollback', { workerId: 'worker', confirm: true, epoch: null }],
  ];

  for (const [method, params] of invalid) {
    await assert.rejects(state.tasks.request(method, params));
  }

  assert.equal(stopping.mock.callCount(), 0);
  assert.equal(state.calls.length, before);
});

test('malformed follow-ups cannot enqueue work or arm automatic continuation', async (context) => {
  const state = setup(context);
  const invalid = [
    null,
    [],
    {},
    ...[null, 'true', 1, [], {}].map((autoStart) => ({
      id: 'followup',
      instruction: 'Change this selection.',
      autoStart,
    })),
    { id: 'followup', instruction: 1 },
    {
      id: 'followup',
      instruction: 'Change this selection.',
      selection: { path: 'file.ts', hash: 'a'.repeat(64), start: 0, end: 2, text: 'wrong range' },
    },
  ];

  for (const request of invalid) {
    await assert.rejects(state.tasks.request('worker.followup', { workerId: 'worker', request }));
  }

  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.pages, []);
  assert.deepEqual(state.creations, []);
});

test('follow-up autoStart omission continues by default while explicit false remains queued', async (context) => {
  const state = setup(context);
  state.native(async (method, params) => {
    if (method === 'state') {
      return state.current;
    }

    assert.equal(method, 'worker.followup');
    return {
      ...params.request,
      autoStart: params.request.autoStart ?? true,
      workerId: params.workerId,
      status: 'queued',
      createdAt: 0,
      baseRunId: 'run',
    };
  });
  const omitted = { id: 'omitted', instruction: 'A next instruction.' };
  await state.tasks.request('worker.followup', { workerId: 'worker', request: omitted });
  assert.equal(Object.hasOwn(state.calls[0].params.request, 'autoStart'), false);
  assert.deepEqual(
    state.calls.map((call) => call.method),
    ['worker.followup', 'state'],
  );

  const disabled = { id: 'disabled', instruction: 'Save without starting.', autoStart: false };
  await state.tasks.request('worker.followup', { workerId: 'worker', request: disabled });
  assert.deepEqual(
    state.calls.map((call) => call.method),
    ['worker.followup', 'state', 'worker.followup'],
  );
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
});

test('validated follow-ups preserve exact selected source and verify their saved identity before continuation', async (context) => {
  const state = setup(context);
  const selection = { path: 'file.ts', hash: 'a'.repeat(64), start: 0, end: 4, text: '\ufeff😀\r' };
  const request = { id: 'followup', instruction: '  Keep the exact source.  ', selection, autoStart: false };
  const saved = {
    ...request,
    instruction: 'Keep the exact source.',
    workerId: 'worker',
    status: 'queued',
    createdAt: 0,
    baseRunId: 'run',
  };
  state.native(async () => saved);
  assert.deepEqual(await state.tasks.request('worker.followup', { workerId: 'worker', request }), saved);
  assert.deepEqual(state.calls[0].params.request.selection, selection);
  assert.equal(state.calls[0].params.request.instruction, request.instruction);
  assert.equal(state.calls.length, 1);

  for (const result of [null, { ...saved, id: 'another' }, { ...saved, workerId: 'another' }]) {
    state.native(async () => result);
    await assert.rejects(
      state.tasks.request('worker.followup', {
        workerId: 'worker',
        request: { ...request, autoStart: true },
      }),
    );
  }

  assert.deepEqual(
    state.calls.map((call) => call.method),
    ['worker.followup', 'worker.followup', 'worker.followup', 'worker.followup'],
  );
  assert.deepEqual(state.pages, []);
  assert.deepEqual(state.creations, []);
});

for (const lifecycle of ['Stop', 'reset', 'dispose', 'replacement']) {
  test('a late follow-up acknowledgement cannot arm continuation after ' + lifecycle, async (context) => {
    const state = setup(context);
    state.tasks.update(state.current);
    const gate = deferred();
    const request = { id: 'followup', instruction: 'A saved instruction.', autoStart: true };
    state.native(async (method) => {
      if (method === 'worker.followup') {
        return gate.promise;
      }

      if (method === 'state') {
        return state.current;
      }

      return { ready: true };
    });
    const pending = state.tasks.request('worker.followup', { workerId: 'worker', request });
    await until(() => state.calls.some((call) => call.method === 'worker.followup'));

    if (lifecycle === 'Stop') {
      await state.tasks.request('bridge.halt', { workerId: 'worker' });
    } else if (lifecycle === 'reset') {
      state.tasks.clear();
    } else if (lifecycle === 'dispose') {
      state.tasks.dispose();
    } else {
      state.worker(worker({ runId: 'replacement-run' }));
      state.tasks.update(state.current);
    }

    const before = state.calls.length;
    const rejected = assert.rejects(pending, /changed|reset|incomplete/);
    gate.resolve({ ...request, workerId: 'worker', status: 'queued', createdAt: 0, baseRunId: 'run' });
    await rejected;
    await settle();
    assert.equal(state.calls.length, before);
    assert.deepEqual(state.pages, []);
    assert.deepEqual(state.creations, []);
  });
}

test('invalid steering cannot invalidate an in-flight Start or acquire control ownership', async (context) => {
  const state = setup(context);
  const creation = deferred();
  state.create(() => creation.promise);
  const starting = state.tasks.request('bridge.start', start);
  await until(() => state.creations.length === 1);
  await assert.rejects(state.tasks.request('bridge.steer', { workerId: 'worker', request: {} }));
  assert.equal(
    state.calls.some((call) => call.method === 'worker.steerValidate'),
    false,
  );
  creation.resolve({ id: 7, url: 'https://chatgpt.com/', autoDiscardable: true });
  const result = await starting;
  assert.equal(result.workerId, 'worker');
  assert.equal(result.maxTurns, 15);
  assert.equal(result.tabId, 7);
});

test('active chat runs reject conflicting starts, continuations, extensions, and manual imports', async (context) => {
  const state = setup(context);
  const inspection = deferred();
  state.native(async (method, params) => {
    if (method === 'state') {
      return { ...snapshot, runtime: { ...snapshot.runtime, version: APP_VERSION }, workers: [worker()] };
    }

    if (method === 'worker.bridgeLoad') {
      return { progress: null, importedCount: 0 };
    }

    if (method === 'worker.bridgeSave') {
      return params.progress;
    }

    if (method === 'worker.prompt' || method === 'worker.report') {
      return 'Exact prompt';
    }

    return { ready: true };
  });
  state.page(async (_tabId, action) => {
    if (action.op === 'inspect') {
      return inspection.promise;
    }

    return { url: 'https://chatgpt.com', ready: true, count: 0, draft: false, busy: false };
  });
  await state.tasks.request('bridge.start', start);
  await until(() => state.pages.some(({ message }) => message.action?.op === 'inspect'));
  await assert.rejects(state.tasks.request('bridge.start', start), /already starting/);
  await assert.rejects(
    state.tasks.request('bridge.continueFresh', { workerId: 'worker' }),
    /Stop the current/,
  );
  await assert.rejects(
    state.tasks.request('bridge.extend', { workerId: 'worker', confirm: true }),
    /Pause and explicitly/,
  );
  await assert.rejects(
    state.tasks.request('worker.import', { workerId: 'worker', text: 'literal handoff' }),
    /Stop automatic mode/,
  );
  assert.equal(state.creations.length, 1);
  assert.equal(
    state.calls.some((call) =>
      ['worker.continueFresh', 'worker.bridgeExtend', 'worker.import'].includes(call.method),
    ),
    false,
  );
  state.tasks.dispose();
  inspection.resolve({ url: 'https://chatgpt.com', ready: true, count: 0, draft: false, busy: false });
});

test('Start schema rejects missing consent and invalid budgets before any host or tab work', async (context) => {
  const state = setup(context);
  await assert.rejects(state.tasks.request('bridge.start', { ...reviewed, newChat: true }));
  await assert.rejects(state.tasks.request('bridge.start', { ...start, maxTurns: '15' }));
  await assert.rejects(state.tasks.request('bridge.start', { ...start, maxMinutes: 61 }));
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.creations, []);
});

test('Resume admits queued work only with proof naming that exact batch', async (context) => {
  const state = setup(context);
  state.permission(false);
  state.worker(
    worker({
      queue: [
        {
          protocol: 'mitter/1',
          id: 'batch',
          workerId: 'worker',
          projectId: 'project',
          summary: 'Batch',
          actions: [{ type: 'finish', summary: 'Done' }],
        },
      ],
    }),
  );
  await assert.rejects(state.tasks.request('bridge.resume', reviewed), /unfinished local batch/);
  state.checkpoint({ progress: progress({ lastImportedId: 'unrelated' }), importedCount: 1 });
  await assert.rejects(state.tasks.request('bridge.resume', reviewed), /unfinished local batch/);
  assert.equal(state.permissionChecks, 0);
  state.checkpoint({ progress: progress({ lastImportedId: 'batch' }), importedCount: 1 });
  assert.deepEqual(await state.tasks.request('bridge.resume', reviewed), { resumed: false });
  state.checkpoint({
    progress: progress({
      stage: 'waiting_reply',
      approvedReply: {
        id: 'batch',
        hash: 'b'.repeat(64),
        url: 'https://chatgpt.com/c/original',
        at: 0,
      },
    }),
    importedCount: 1,
  });
  assert.deepEqual(await state.tasks.request('bridge.resume', reviewed), { resumed: false });
  assert.equal(state.permissionChecks, 2);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
});

test('local control translations preserve supplied authority before native validation', async (context) => {
  const state = setup(context);
  state.worker(worker({ mode: 'local' }));
  const authority = { ...reviewed, epoch: 7 };
  await state.tasks.request('bridge.pause', authority);
  assert.deepEqual(state.calls.at(-1), { method: 'worker.pause', params: authority });

  await state.tasks.request('bridge.continueFresh', reviewed);
  assert.deepEqual(state.calls.find((call) => call.method === 'worker.continueFresh').params, reviewed);

  const steering = {
    ...reviewed,
    request: { id: 'steering', instruction: '  Keep literal input.  ', autoStart: false },
  };
  await state.tasks.request('bridge.steer', steering);
  assert.deepEqual(state.calls.find((call) => call.method === 'worker.steerValidate').params, steering);
  assert.deepEqual(state.calls.find((call) => call.method === 'worker.steer').params, steering);

  const stop = { ...reviewed, id: 'exact-stop' };
  const result = await state.tasks.request('bridge.halt', stop);
  assert.deepEqual(state.calls.find((call) => call.method === 'worker.stop').params, stop);
  assert.deepEqual(result, { stopped: true, ready: false, epoch: 8, operationId: 'exact-stop' });
});

test('local budget extension preserves the reviewed authority in both native translations', async (context) => {
  const state = setup(context);
  state.permission(false);
  const params = { ...reviewed, confirm: true };
  assert.deepEqual(await state.tasks.request('bridge.extend', params), { resumed: false });
  assert.deepEqual(state.calls.find((call) => call.method === 'worker.bridgeExtend').params, params);
  assert.deepEqual(state.calls.find((call) => call.method === 'worker.continueFresh').params, params);
});

test('an explicit follow-up start retains its reviewed boundary for native activation', async (context) => {
  const state = setup(context);
  state.worker(
    worker({
      followups: [{ id: 'followup', instruction: 'Next instruction', status: 'queued', createdAt: 0 }],
    }),
  );
  state.native(async (method) => {
    if (method === 'state') {
      return state.current;
    }

    assert.equal(method, 'worker.followupActivate');
    return { activated: false, reason: 'Not ready' };
  });
  await state.tasks.request('worker.followupStart', reviewed);
  assert.deepEqual(state.calls.find((call) => call.method === 'worker.followupActivate').params, reviewed);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
});

test('an internal activated follow-up can start without a UI boundary field but retains its native run', async (context) => {
  const state = setup(context);
  state.worker(
    worker({
      followups: [{ id: 'followup', instruction: 'Next instruction', status: 'queued', createdAt: 0 }],
    }),
  );
  state.native(async (method) => {
    if (method === 'state') {
      return state.current;
    }

    if (method === 'worker.followupActivate') {
      state.worker(worker({ runId: 'activated-run', control: { ...worker().control, epoch: 8 } }));
      return { activated: true, id: 'followup' };
    }

    return { progress: null, importedCount: 0 };
  });
  const starting = context.mock.method(BridgeRunner.prototype, 'start', async () => {});
  const result = await state.tasks.request('worker.followupStart', { workerId: 'worker' });
  assert.equal(result.workerId, 'worker');
  assert.equal(starting.mock.callCount(), 1);
  assert.equal(state.creations.length, 1);
  assert.deepEqual(state.pages, []);
});

test('an unactivated follow-up refreshes the cache without publishing a snapshot', async (context) => {
  const state = setup(context);
  const task = worker({
    followups: [{ id: 'followup', instruction: 'Next instruction', status: 'queued', createdAt: 0 }],
  });
  state.native(async (method) => {
    if (method === 'state') {
      return { ...snapshot, workers: [task] };
    }

    return { activated: false, reason: 'Not ready' };
  });
  assert.deepEqual(await state.tasks.request('worker.followupStart', { workerId: 'worker' }), {
    queued: true,
    reason: 'Not ready',
  });
  assert.deepEqual(
    state.calls.map((call) => call.method),
    ['state', 'worker.followupActivate'],
  );
  assert.equal(
    state.broadcasts.some((message) => message.event === 'snapshot'),
    false,
  );
  assert.equal(
    state.tasks.initialMessages().find((message) => message.event === 'snapshot').data.workers[0].id,
    task.id,
  );
});

test('Continue fresh checks supersession after caching state but before publishing it', async (context) => {
  const state = setup(context);
  const pendingState = deferred();
  state.native(async (method) => {
    if (method === 'state') {
      return pendingState.promise;
    }

    return { ready: true };
  });
  const continuing = state.tasks.request('bridge.continueFresh', { workerId: 'worker' });
  await until(() => state.calls.some((call) => call.method === 'state'));
  state.blocked(true);
  pendingState.resolve({ ...snapshot, workers: [worker()] });
  await assert.rejects(continuing, /superseded/);
  assert.equal(
    state.broadcasts.some((message) => message.event === 'snapshot'),
    false,
  );
  assert.equal(
    state.tasks.initialMessages().some((message) => message.event === 'snapshot'),
    true,
  );
});

test('local rewrites require neither permissions nor a tab; remote consent never requests permission', async (context) => {
  const state = setup(context);
  state.permission(false);
  const local = await state.tasks.request('rewrite.start', { request: { ...rewrite, provider: 'local' } });
  assert.equal(local.state, 'done');
  assert.equal(local.provider, 'local');
  assert.ok(local.text.includes(rewrite.instruction));
  assert.equal(state.permissionChecks, 0);
  await assert.rejects(state.tasks.request('rewrite.start', { request: rewrite }), /Allow ChatGPT/);
  assert.equal(state.permissionChecks, 0);
  await assert.rejects(
    state.tasks.request('rewrite.start', { request: rewrite, consent: true }),
    /Allow ChatGPT/,
  );
  assert.equal(state.permissionChecks, 1);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.calls, []);
});

test('completed rewrites expire only after authorized remote starts, not permission failures', async (context) => {
  const state = setup(context, ['Date', 'setTimeout']);
  const probe = deferred();
  state.page(async (_tabId, action) => {
    if (action.op === 'probe') {
      return probe.promise;
    }

    return { url: 'https://chatgpt.com', ready: true, count: 0, draft: false, busy: false };
  });
  const result = await state.tasks.request('rewrite.start', { request: rewrite, consent: true });
  await state.tasks.request('rewrite.cancel', { id: result.id });
  context.mock.timers.tick(300001);
  state.permission(false);
  await assert.rejects(
    state.tasks.request('rewrite.start', { request: rewrite, consent: true }),
    /Allow ChatGPT/,
  );
  assert.equal((await state.tasks.request('rewrite.read', { id: result.id })).state, 'cancelled');
  state.permission(true);
  await state.tasks.request('rewrite.start', { request: rewrite, consent: true });
  await assert.rejects(state.tasks.request('rewrite.read', { id: result.id }), /expired/);
  state.tasks.dispose();
  probe.resolve({ url: 'https://chatgpt.com', ready: true, count: 0, draft: false, busy: false });
});

test('rewrite concurrency, cancellation, liveness, and reset retain both active and completed tab IDs', async (context) => {
  const state = setup(context);
  const probe = deferred();
  state.page(async (_tabId, action) => {
    if (action.op === 'probe') {
      return probe.promise;
    }

    return { url: 'https://chatgpt.com', ready: true, count: 0, busy: false, draft: false };
  });
  const first = await state.tasks.request('rewrite.start', { request: rewrite, consent: true });
  const second = await state.tasks.request('rewrite.start', { request: rewrite, consent: true });
  await until(() => state.updates.length === 2);
  assert.equal(first.state, 'waiting');
  assert.equal(second.state, 'waiting');
  await assert.rejects(
    state.tasks.request('rewrite.start', { request: rewrite, consent: true }),
    /existing rewrite/,
  );
  await assert.rejects(state.tasks.request('rewrite.read', { id: 'missing' }), /expired/);
  const cancelled = await state.tasks.request('rewrite.cancel', { id: first.id });
  assert.equal(cancelled.state, 'cancelled');
  await state.tasks.stop();
  assert.equal((await state.tasks.request('rewrite.read', { id: second.id })).state, 'cancelled');
  const ids = new Set();
  state.tasks.capturePageIds(ids);
  assert.deepEqual([...ids], [first.tabId, second.tabId]);
  probe.resolve({ url: 'https://chatgpt.com', ready: true, count: 0, busy: false, draft: false });
  await state.tasks.quiesce();
  await until(() => state.updates.filter((update) => update.changes.autoDiscardable === true).length === 2);
  assert.equal(
    state.pages.some(({ message }) => message.action?.op === 'prepare'),
    false,
  );
  assert.deepEqual(state.calls, []);
  state.tasks.clear();
  await assert.rejects(state.tasks.request('rewrite.read', { id: first.id }), /expired/);
});
