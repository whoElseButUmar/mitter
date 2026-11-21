import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatConnections } from '../../src/background/chat-connections.ts';
import { deferred, settle } from './chrome-mock.mjs';

function setup() {
  const updates = [];
  const creations = [];
  const reads = [];
  const loads = [];
  let sessions = [];
  let current;
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
    snapshot: () => current,
    sessions: () => sessions,
    log: () => {},
  });

  return {
    chats,
    updates,
    creations,
    reads,
    loads,
    snapshot(value) {
      current = value;
    },
    sessions(value) {
      sessions = value;
    },
    queried(value) {
      queried = value;
    },
  };
}

function signInSetup() {
  const state = setup();
  state.snapshot({ workers: [{ id: 'worker', projectId: 'project', runId: 'run', control: { epoch: 1 } }] });
  state.sessions([{ workerId: 'worker', tabId: 7, active: false }]);
  state.chats.links.set('worker', {
    providerId: 'chatgpt',
    id: 7,
    url: 'https://chatgpt.com',
    title: 'Task chat',
    newChat: true,
    projectId: 'project',
  });
  return state;
}

for (const url of ['https://chatgpt.com/auth/login', 'https://auth.openai.com/log-in', undefined]) {
  test('the live-owned sign-in tab can be focused but never becomes a resumable chat: ' + url, async () => {
    const state = signInSetup();
    await state.chats.links.ready;
    state.queried([{ id: 7, url }]);
    const original = state.chats.links.get('worker');
    assert.equal(await state.chats.signInTab('worker', () => {}), 7);
    assert.equal(await state.chats.saved('worker'), undefined);
    assert.deepEqual(state.chats.links.get('worker'), original);
    assert.deepEqual(state.creations, []);
    assert.deepEqual(state.updates, []);
    await state.chats.links.quiesce();
  });
}

for (const tab of [
  { id: 7, url: 'https://example.com/' },
  { id: 7, url: 'https://auth.openai.com.example.com/' },
  { id: 7, url: 'https://user:password@auth.openai.com/' },
  { id: 7, url: 'http://auth.openai.com/' },
  { id: 7, url: 'https://chatgpt.com/authentication' },
  { id: 7, url: 'https://chatgpt.com/auth/login', pendingUrl: 'https://example.com/' },
  { id: 8, url: 'https://chatgpt.com/auth/login' },
]) {
  test(
    'sign-in recovery rejects an unrelated readable address or wrong tab: ' + JSON.stringify(tab),
    async () => {
      const state = signInSetup();
      await state.chats.links.ready;
      chrome.tabs.get = async () => tab;
      assert.equal(await state.chats.signInTab('worker', () => {}), undefined);
      assert.deepEqual(state.creations, []);
      assert.deepEqual(state.updates, []);
      await state.chats.links.quiesce();
    },
  );
}

test('saved tab IDs alone, mismatched projects and competing owners cannot recover sign-in', async () => {
  const state = signInSetup();
  await state.chats.links.ready;
  state.queried([{ id: 7 }]);
  state.sessions([]);
  assert.equal(await state.chats.signInTab('worker', () => {}), undefined);
  state.sessions([{ workerId: 'worker', tabId: 7 }]);
  state.snapshot({ workers: [{ id: 'worker', projectId: 'different', runId: 'run' }] });
  assert.equal(await state.chats.signInTab('worker', () => {}), undefined);
  state.snapshot({ workers: [{ id: 'worker', projectId: 'project', runId: 'run' }] });
  state.sessions([
    { workerId: 'worker', tabId: 7 },
    { workerId: 'another', tabId: 7 },
  ]);
  assert.equal(await state.chats.signInTab('worker', () => {}), undefined);
  state.sessions([{ workerId: 'worker', tabId: 7 }]);
  state.chats.reserve('another', state.chats.links.get('worker'));
  assert.equal(await state.chats.signInTab('worker', () => {}), undefined);
  assert.deepEqual(state.reads, []);
  await state.chats.links.quiesce();
});

for (const change of ['link', 'run', 'epoch', 'reset']) {
  test('a late sign-in tab lookup cannot outlive its owner: ' + change, async () => {
    const state = signInSetup();
    await state.chats.links.ready;
    const read = deferred();
    let cancelled = false;
    chrome.tabs.get = () => read.promise;
    const opening = state.chats.signInTab('worker', () => {
      if (cancelled) {
        throw new Error('Reset retired this request.');
      }
    });
    await settle();
    if (change === 'link') {
      state.chats.links.set('worker', { ...state.chats.links.get('worker'), id: 8 });
    } else if (change === 'run') {
      state.snapshot({
        workers: [{ id: 'worker', projectId: 'project', runId: 'replacement', control: { epoch: 1 } }],
      });
    } else if (change === 'epoch') {
      state.snapshot({
        workers: [{ id: 'worker', projectId: 'project', runId: 'run', control: { epoch: 2 } }],
      });
    } else {
      cancelled = true;
    }
    const rejected = assert.rejects(opening, /changed|retired/);
    read.resolve({ id: 7 });
    await rejected;
    assert.deepEqual(state.creations, []);
    assert.deepEqual(state.updates, []);
    await state.chats.links.quiesce();
  });
}

test('chat reservations enforce task and conversation ownership across different tab IDs', async () => {
  const state = setup();
  await state.chats.links.ready;
  const choice = {
    id: 7,
    url: 'https://chatgpt.com/c/conversation',
    providerId: 'chatgpt',
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
    providerId: 'chatgpt',
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
  const first = {
    providerId: 'chatgpt',
    id: 7,
    url: 'https://chatgpt.com/c/shared',
    title: 'Shared',
    newChat: false,
  };
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
  const first = {
    providerId: 'chatgpt',
    id: 7,
    url: 'https://chatgpt.com/',
    title: 'New chat',
    newChat: true,
  };
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

for (const activeUrl of ['https://chatgpt.com/', 'https://chatgpt.com/c/personal']) {
  test('automatic new-chat opens a separate background tab without inspecting ' + activeUrl, async () => {
    const state = setup();
    state.queried([{ id: 7, url: activeUrl, title: 'Personal chat with a draft' }]);
    const choice = await state.chats.fresh('worker');
    assert.equal(choice.id, 8);
    assert.deepEqual(state.reads, []);
    assert.deepEqual(state.updates, []);
    assert.deepEqual(state.creations, [{ url: 'https://chatgpt.com/', active: false }]);
    assert.equal(state.chats.isCreatedTab('worker', 7), false);
    assert.equal(state.chats.isCreatedTab('worker', 8), true);
    await state.chats.links.quiesce();
  });
}

test('a saved conversation search cannot reopen a tab after its admission is cancelled', async () => {
  const state = setup();
  await state.chats.links.ready;
  state.chats.links.set('worker', {
    id: 7,
    url: 'https://chatgpt.com/c/original',
    providerId: 'chatgpt',
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
    providerId: 'chatgpt',
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
    providerId: 'chatgpt',
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
      state.chats.links.set('worker', { providerId: 'chatgpt', id: 7, title: 'Pending', ...pending });
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
  state.chats.links.set('worker', {
    providerId: 'chatgpt',
    id: 7,
    title: 'Pending',
    url: 'https://chatgpt.com',
    newChat: true,
  });
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
    providerId: 'chatgpt',
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

test('manual-only providers cannot reserve automatic task connections or claim their tabs', async () => {
  const state = setup();
  await state.chats.links.ready;
  for (const [providerId, url] of [
    ['gemini', 'https://gemini.google.com/app'],
    ['perplexity', 'https://www.perplexity.ai'],
  ]) {
    assert.throws(
      () => state.chats.reserve('manual', { providerId, id: 7, url, title: 'Manual', newChat: true }),
      /manual handoff only/,
    );
  }
  state.chats.reserve('automatic', {
    providerId: 'chatgpt',
    id: 7,
    url: 'https://chatgpt.com',
    title: 'New chat',
    newChat: true,
  });
  assert.deepEqual(state.reads, []);
  assert.deepEqual(state.loads, []);
  assert.deepEqual(state.updates, []);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.chats.links.entries(), []);
  await state.chats.links.quiesce();
});

test('only a tab created by this coordinator retains bounded stale-draft cleanup eligibility', async () => {
  const state = setup();
  const created = await state.chats.fresh('created');
  assert.equal(state.chats.isCreatedTab('created', created.id), true);
  assert.equal(state.chats.isCreatedTab('other', created.id), false);
  state.chats.forgetCreatedTab(created.id);
  assert.equal(state.chats.isCreatedTab('created', created.id), false);
  await state.chats.fresh('created');
  state.chats.clearReservations();
  assert.equal(state.chats.isCreatedTab('created', created.id), false);
  await state.chats.links.quiesce();
});
