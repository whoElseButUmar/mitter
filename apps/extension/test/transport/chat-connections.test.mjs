import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatConnections } from '../../src/background/chat-connections.ts';
import { deferred, settle } from './chrome-mock.mjs';

function setup() {
  const updates = [];
  const creations = [];
  const probes = [];
  const reads = [];
  const loads = [];
  let sessions = [];
  let rewriteTabs = [];
  let view = {
    url: 'https://chatgpt.com',
    ready: true,
    draft: false,
    busy: false,
    count: 0,
  };
  let queried = [{ id: 7, url: 'https://chatgpt.com/', title: 'Chat' }];
  const storage = { get: async () => ({}), set: async () => {} };
  globalThis.chrome = {
    storage: { local: storage, session: storage },
    tabs: {
      query: async (params) => {
        reads.push({ method: 'query', params });
        return queried;
      },
      get: async (id) => {
        reads.push({ method: 'get', id });
        return queried.find((tab) => tab.id === id);
      },
      update: async (id, change) => {
        updates.push({ id, change });
      },
      create: async (change) => {
        creations.push(change);
        return { id: 8, ...change };
      },
    },
  };
  const chats = new ChatConnections({
    rpc: async (method, params) => {
      loads.push({ method, params });
      return { progress: null, importedCount: 0 };
    },
    page: {
      request: async (tabId, action) => {
        probes.push({ tabId, action });
        return view;
      },
      forget() {},
    },
    snapshot: () => undefined,
    sessions: () => sessions,
    rewriteTabs: () => rewriteTabs,
    log: () => {},
  });

  return {
    chats,
    updates,
    creations,
    probes,
    reads,
    loads,
    sessions(value) {
      sessions = value;
    },
    rewriteTabs(value) {
      rewriteTabs = value;
    },
    view(value) {
      view = value;
    },
    queried(value) {
      queried = value;
    },
  };
}

test('chat reservations enforce task and conversation ownership across different tab IDs', async () => {
  const state = setup();
  await state.chats.links.ready;
  const choice = {
    id: 7,
    url: 'https://chatgpt.com/c/conversation',
    title: 'Chat',
    newChat: false,
  };
  state.chats.reserve('worker', choice);
  assert.throws(() => state.chats.reserve('another', choice), /Another task/);
  state.chats.release('another', 7);
  assert.throws(() => state.chats.reserve('another', choice), /Another task/);
  state.chats.release('worker', 7);
  state.sessions([{ workerId: 'worker', tabId: 9, url: choice.url, active: true }]);
  assert.throws(() => state.chats.reserve('another', choice), /Another task/);
  await state.chats.links.quiesce();
});

test('pending reservations bind the normalized conversation across duplicate tabs until their owner releases', async () => {
  const state = setup();
  await state.chats.links.ready;
  const first = {
    id: 7,
    url: 'https://chatgpt.com/c/shared/?source=first',
    title: 'Shared',
    newChat: false,
  };
  const duplicate = { ...first, id: 8, url: 'https://chatgpt.com/c/shared#second' };
  state.chats.reserve('first-worker', first);
  assert.throws(() => state.chats.reserve('second-worker', duplicate), /Another task/);
  state.chats.release('second-worker', first.id);
  state.chats.release('first-worker', duplicate.id);
  assert.throws(() => state.chats.reserve('second-worker', duplicate), /Another task/);
  state.chats.release('first-worker', first.id);
  state.chats.reserve('second-worker', duplicate);
  assert.throws(() => state.chats.reserve('first-worker', first), /Another task/);
  state.chats.clearReservations();
  state.chats.reserve('first-worker', first);
  await state.chats.links.quiesce();
});

test("releasing one duplicate tab keeps the same task's other pending conversation binding", async () => {
  const state = setup();
  await state.chats.links.ready;
  const first = { id: 7, url: 'https://chatgpt.com/c/shared', title: 'Shared', newChat: false };
  state.chats.reserve('worker', first);
  state.chats.reserve('worker', { ...first, id: 8 });
  state.chats.release('worker', first.id);
  assert.throws(() => state.chats.reserve('another', { ...first, id: 9 }), /Another task/);
  state.chats.release('worker', 8);
  state.chats.reserve('another', { ...first, id: 9 });
  await state.chats.links.quiesce();
});

test('new-chat roots on separate tabs do not share a conversation reservation', async () => {
  const state = setup();
  await state.chats.links.ready;
  const first = { id: 7, url: 'https://chatgpt.com/', title: 'New chat', newChat: true };
  const second = { ...first, id: 8, url: 'https://chatgpt.com/?source=second' };
  state.chats.reserve('first-worker', first);
  state.chats.reserve('second-worker', second);
  assert.throws(() => state.chats.reserve('second-worker', first), /Another task/);
  assert.throws(() => state.chats.reserve('first-worker', second), /Another task/);
  state.chats.release('first-worker', first.id);
  assert.throws(() => state.chats.reserve('first-worker', second), /Another task/);
  state.chats.clearReservations();
  state.chats.reserve('first-worker', second);
  await state.chats.links.quiesce();
});

test('fresh selection does not probe or navigate a duplicate tab of a pending conversation', async () => {
  const state = setup();
  await state.chats.links.ready;
  state.chats.reserve('first-worker', {
    id: 9,
    url: 'https://chatgpt.com/c/shared',
    title: 'Shared',
    newChat: false,
  });
  state.queried([{ id: 7, url: 'https://chatgpt.com/c/shared/?source=duplicate', title: 'Duplicate' }]);
  const selected = await state.chats.fresh('second-worker');
  assert.equal(selected.id, 8);
  assert.equal(state.probes.length, 0);
  assert.equal(state.updates.length, 0);
  assert.equal(state.creations.length, 1);
  state.chats.release('second-worker', selected.id);
  state.chats.clearReservations();
  await state.chats.links.quiesce();
});

test('fresh chat selection never probes or navigates a tab owned by a rewrite', async () => {
  const state = setup();
  await state.chats.links.ready;
  state.rewriteTabs([7]);
  const choice = await state.chats.fresh('worker');
  assert.equal(choice.id, 8);
  assert.equal(state.probes.length, 0);
  assert.equal(state.updates.length, 0);
  assert.equal(state.creations.length, 1);
  await state.chats.links.quiesce();
});

test('a composer draft prevents tab reuse without modifying that conversation', async () => {
  const state = setup();
  await state.chats.links.ready;
  state.view({
    url: 'https://chatgpt.com',
    ready: true,
    draft: true,
    busy: false,
    count: 0,
  });
  const choice = await state.chats.fresh('worker');
  assert.equal(choice.id, 8);
  assert.equal(state.probes.length, 1);
  assert.equal(state.updates.length, 0);
  await state.chats.links.quiesce();
});

test('a saved conversation search cannot reopen a tab after its admission is cancelled', async () => {
  const state = setup();
  await state.chats.links.ready;
  state.chats.links.set('worker', {
    id: 7,
    url: 'https://chatgpt.com/c/original',
    title: 'Original',
    newChat: false,
  });
  state.queried([{ id: 7, url: 'https://chatgpt.com/c/unrelated' }]);
  const query = deferred();
  let queried = false;
  let cancelled = false;
  chrome.tabs.query = () => {
    queried = true;
    return query.promise;
  };
  const saved = state.chats.saved('worker', true, () => {
    if (cancelled) {
      throw new Error('Conversation admission cancelled.');
    }
  });
  await settle();
  assert.equal(queried, true);
  cancelled = true;
  const rejected = assert.rejects(saved, /cancelled/);
  query.resolve([]);
  await rejected;
  assert.deepEqual(state.creations, []);
  await state.chats.links.quiesce();
});

test('a bound saved link disagreeing with the reviewed checkpoint fails before any browser fallback', async () => {
  const state = setup();
  await state.chats.links.ready;
  const original = {
    id: 7,
    url: 'https://chatgpt.com/c/unrelated',
    title: 'Unrelated chat',
    newChat: false,
    bindingPending: false,
  };
  state.chats.links.set('worker', original);
  state.queried([
    { id: 7, url: original.url },
    { id: 9, url: 'https://chatgpt.com/c/original' },
  ]);
  await assert.rejects(
    state.chats.saved('worker', true, () => {}, 'https://chatgpt.com/c/original'),
    /saved chat link does not match/,
  );
  assert.deepEqual(state.reads, []);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.probes, []);
  assert.deepEqual(state.loads, []);
  assert.equal(state.chats.links.get('worker').url, original.url);
  await state.chats.links.quiesce();
});

test('a matching checkpoint normalizes chat identity without selecting another open conversation', async () => {
  const state = setup();
  await state.chats.links.ready;
  state.chats.links.set('worker', {
    id: 7,
    url: 'https://chatgpt.com/c/original/?saved=1#reply',
    title: 'Original',
    newChat: false,
  });
  state.queried([{ id: 7, url: 'https://chatgpt.com/c/original#current' }]);
  const selected = await state.chats.saved(
    'worker',
    true,
    () => {},
    'https://chatgpt.com/c/original/?checkpoint=1',
  );
  assert.equal(selected.id, 7);
  assert.equal(selected.url, 'https://chatgpt.com/c/original');
  assert.equal(selected.newChat, false);
  assert.equal(selected.bindingPending, false);
  assert.deepEqual(state.reads, [{ method: 'get', id: 7 }]);
  assert.deepEqual(state.loads, []);
  assert.deepEqual(state.creations, []);
  await state.chats.links.quiesce();
});

for (const pending of [
  { url: 'https://chatgpt.com', newChat: true },
  { url: 'https://chatgpt.com/c/provisional', newChat: false, bindingPending: true },
]) {
  test(
    'a pending link uses the validated pinned conversation without rereading a mutable checkpoint: ' +
      pending.url,
    async () => {
      const state = setup();
      await state.chats.links.ready;
      state.chats.links.set('worker', { id: 7, title: 'Pending', ...pending });
      state.queried([{ id: 7, url: 'https://chatgpt.com/c/original' }]);
      const selected = await state.chats.saved('worker', true, () => {}, 'https://chatgpt.com/c/original');
      assert.equal(selected.id, 7);
      assert.equal(selected.url, 'https://chatgpt.com/c/original');
      assert.equal(selected.newChat, false);
      assert.equal(selected.bindingPending, false);
      assert.deepEqual(state.loads, []);
      assert.deepEqual(state.reads, [{ method: 'get', id: 7 }]);
      assert.deepEqual(state.creations, []);
      await state.chats.links.quiesce();
    },
  );
}

test('an invalid pinned conversation is rejected without browser work or checkpoint fallback', async () => {
  const state = setup();
  await state.chats.links.ready;
  state.chats.links.set('worker', { id: 7, title: 'Pending', url: 'https://chatgpt.com', newChat: true });
  await assert.rejects(state.chats.saved('worker', true, () => {}, 'https://example.com/c/original'));
  assert.deepEqual(state.reads, []);
  assert.deepEqual(state.loads, []);
  assert.deepEqual(state.creations, []);
  await state.chats.links.quiesce();
});

test('resume searches only the exact saved conversation, never an arbitrary open chat', async () => {
  const state = setup();
  await state.chats.links.ready;
  state.chats.links.set('worker', {
    id: 7,
    url: 'https://chatgpt.com/c/original',
    title: 'Original',
    newChat: false,
  });
  state.queried([{ id: 7, url: 'https://chatgpt.com/c/unrelated' }]);
  assert.equal(await state.chats.saved('worker'), undefined);
  assert.equal(state.creations.length, 0);
  const reopened = await state.chats.saved('worker', true);
  assert.equal(reopened.url, 'https://chatgpt.com/c/original');
  assert.equal(state.creations[0].url, 'https://chatgpt.com/c/original');
  await state.chats.links.quiesce();
});
