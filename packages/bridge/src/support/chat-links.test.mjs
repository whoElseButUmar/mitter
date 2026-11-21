import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';
import { setImmediate } from 'node:timers/promises';
import { worker, chatLink } from './fixtures.mjs';
const { ChatLinkStore, LINK_STORAGE_KEY, LEGACY_LINK_STORAGE_KEY, linkURL, parseChatLinks } =
  await import('../chat-links.ts');

test('chat-link parsing retains URL restrictions, metadata bounds and the first-64 limit', () => {
  assert.equal(
    linkURL('https://chat.openai.com/g/custom/c/task-1/?query=yes#reply'),
    'https://chat.openai.com/g/custom/c/task-1',
  );
  assert.equal(linkURL('https://chatgpt.com/?temporary=true'), 'https://chatgpt.com');
  for (const url of [
    'https://example.com/c/task-1',
    'http://chatgpt.com/c/task-1',
    'https://chatgpt.com/settings',
  ]) {
    assert.equal(linkURL(url), undefined);
  }
  const parsed = parseChatLinks({
    worker_1: {
      ...chatLink,
      title: 'x'.repeat(250),
      maxTurns: 20,
      maxMinutes: 61,
      bindingPending: true,
    },
    'invalid id': chatLink,
    negative: { ...chatLink, id: -1 },
  });
  assert.equal(parsed.size, 1);
  assert.equal(parsed.get('worker_1').title.length, 200);
  assert.equal(parsed.get('worker_1').maxTurns, 20);
  assert.equal(parsed.get('worker_1').maxMinutes, undefined);
  assert.equal(parsed.get('worker_1').bindingPending, true);
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => ['worker_' + index, chatLink]));
  assert.equal(parseChatLinks(many).size, 64);
  assert.equal(parseChatLinks(many).has('worker_64'), false);
});

test('the first-64 history bound applies before decoding destination metadata', () => {
  const history = Object.fromEntries(Array.from({ length: 64 }, (_, index) => ['worker_' + index, chatLink]));
  history.worker_64 = Object.defineProperty({ ...chatLink }, 'title', {
    get() {
      assert.fail('Out-of-bound destinations must not be decoded');
    },
  });
  const links = parseChatLinks(history);
  assert.equal(links.size, 64);
  assert.equal(links.has('worker_64'), false);
});

test('chat-link writes serialize, preserve pre-load changes, clone reads and drain before quiescence', async () => {
  const loading = Promise.withResolvers();
  const firstWrite = Promise.withResolvers();
  const writes = [];
  const store = new ChatLinkStore({
    get: () => loading.promise,
    async set(value) {
      writes.push(structuredClone(value));
      if (writes.length === 1) {
        await firstWrite.promise;
      }
    },
  });
  store.set(worker.id, chatLink);
  loading.resolve({
    [LINK_STORAGE_KEY]: {
      version: 3,
      links: { [worker.id]: { ...chatLink, title: 'Old title' } },
    },
  });
  await setImmediate();
  assert.equal(store.get(worker.id).title, chatLink.title);
  const copy = store.get(worker.id);
  copy.title = 'Mutated read';
  const entries = store.entries();
  entries[0][1].title = 'Mutated entries';
  assert.equal(store.get(worker.id).title, chatLink.title);
  store.set(worker.id, { ...chatLink, url: 'https://chatgpt.com/c/task-2' });
  assert.equal(writes.length, 1);
  const quiescence = store.quiesce();
  store.set(worker.id, { ...chatLink, url: 'https://chatgpt.com/c/task-3' });
  firstWrite.resolve();
  await quiescence;
  assert.equal(writes.length, 2);
  assert.equal(writes[1][LINK_STORAGE_KEY].links[worker.id].url, 'https://chatgpt.com/c/task-2');
  assert.deepEqual(store.entries(), []);
});

test('link-history migrations retain valid destinations beside malformed records without trusting receipts', async () => {
  const store = new ChatLinkStore({
    get: async () => ({
      [LEGACY_LINK_STORAGE_KEY]: {
        version: 2,
        links: {
          worker_1: {
            ...chatLink,
            title: 1,
            newChat: true,
            projectId: 'project_1',
            lastReceipt: { workerId: 'foreign' },
          },
          worker_2: null,
          worker_3: { ...chatLink, id: '7' },
        },
      },
    }),
    set: async () => {},
  });
  await store.ready;
  assert.deepEqual(store.entries(), [
    ['worker_1', { ...chatLink, title: 'Task conversation', projectId: 'project_1' }],
  ]);
  await store.quiesce();
});

test('malformed link-storage envelopes are reported instead of silently treated as empty history', async () => {
  for (const data of [null, [], false]) {
    const warnings = [];
    const store = new ChatLinkStore({ get: async () => data, set: async () => {} }, undefined, (message) =>
      warnings.push(message),
    );
    await store.ready;
    assert.deepEqual(store.entries(), []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Resume history could not be read/);
    await store.quiesce();
  }
});

test('required link flushes expose storage failures without blocking later serialized writes', async () => {
  const failure = new Error('Storage failed');
  let fail = true;
  const warnings = [];
  const store = new ChatLinkStore(
    {
      get: async () => ({}),
      async set() {
        if (fail) {
          throw failure;
        }
      },
    },
    undefined,
    (message) => warnings.push(message),
  );
  store.set(worker.id, chatLink);
  await store.flush();
  await assert.rejects(store.flush(true), (error) => error === failure);
  assert.equal(warnings.length, 1);
  fail = false;
  store.set(worker.id, chatLink);
  await store.flush(true);
});

test('version-two destinations migrate on write and survive reload with explicit provider identity', async () => {
  const { providerId, ...oldLink } = chatLink;
  assert.equal(providerId, 'chatgpt');
  const data = {
    [LEGACY_LINK_STORAGE_KEY]: { version: 2, links: { [worker.id]: oldLink } },
  };
  const local = {
    async get(key) {
      return { [key]: structuredClone(data[key]) };
    },
    async set(value) {
      Object.assign(data, structuredClone(value));
    },
  };
  const store = new ChatLinkStore(local);
  await store.ready;
  assert.deepEqual(store.get(worker.id), chatLink);
  assert.equal(data[LINK_STORAGE_KEY], undefined);
  store.set(worker.id, { ...store.get(worker.id), title: 'Updated' });
  await store.flush(true);
  assert.deepEqual(data[LINK_STORAGE_KEY], {
    version: 3,
    links: { [worker.id]: { ...chatLink, title: 'Updated' } },
  });
  assert.deepEqual(data[LEGACY_LINK_STORAGE_KEY].links[worker.id], oldLink);
  await store.quiesce();
  const reloaded = new ChatLinkStore(local);
  await reloaded.ready;
  assert.deepEqual(reloaded.get(worker.id), { ...chatLink, title: 'Updated' });
  reloaded.delete(worker.id);
  await reloaded.flush(true);
  await reloaded.quiesce();
  const cleared = new ChatLinkStore(local);
  await cleared.ready;
  assert.deepEqual(cleared.entries(), []);
  await cleared.quiesce();
});

test('unversioned session history gains provider identity but never adopts an explicit foreign provider', async () => {
  const { providerId, ...oldLink } = chatLink;
  assert.equal(providerId, 'chatgpt');
  const store = new ChatLinkStore(
    { get: async () => ({}), set: async () => {} },
    {
      get: async () => ({
        mitterChatLinks: {
          [worker.id]: oldLink,
          foreign: { ...oldLink, providerId: 'gemini' },
          unknown: { ...oldLink, providerId: 'unrecognized' },
          wrongOrigin: { ...oldLink, url: 'https://gemini.google.com/app/task' },
        },
      }),
      set: async () => assert.fail('Legacy history is read-only'),
    },
  );
  await store.ready;
  assert.deepEqual(store.entries(), [[worker.id, chatLink]]);
  await store.quiesce();
});

test('unreadable current history is not replaced or bypassed through legacy history', async () => {
  for (const current of [
    { version: 4, links: {} },
    { version: 3, links: { [worker.id]: { ...chatLink, providerId: 'gemini' } } },
    { version: 3, links: { [worker.id]: { ...chatLink, providerId: undefined } } },
  ]) {
    const reads = [];
    const warnings = [];
    const store = new ChatLinkStore(
      {
        async get(key) {
          reads.push(key);
          return { [LINK_STORAGE_KEY]: current };
        },
        set: async () => assert.fail('Unreadable history must not be overwritten'),
      },
      undefined,
      (message) => warnings.push(message),
    );
    // A write queued before storage returns must also stop on a failed read.
    store.set('new_worker', chatLink);
    await assert.rejects(store.flush(true), /Invalid chat-link storage/);
    assert.deepEqual(reads, [LINK_STORAGE_KEY]);
    assert.equal(
      warnings.some((message) => message.includes('could not be read')),
      true,
    );
    assert.equal(store.get(worker.id), undefined);
    assert.throws(() => store.set(worker.id, chatLink), /history could not be loaded/);
    await store.quiesce();
  }
});

test('storage read rejections block queued writes even without a rejection reason', async () => {
  for (const failure of [new Error('Storage unavailable'), undefined]) {
    const store = new ChatLinkStore({
      get: async () => Promise.reject(failure),
      set: async () => assert.fail('A failed read must not allow history to be overwritten'),
    });
    store.set(worker.id, chatLink);
    await assert.rejects(store.flush(true), /Resume history could not be read/);
    assert.throws(() => store.set(worker.id, chatLink), /history could not be loaded/);
    await store.quiesce();
  }
});
