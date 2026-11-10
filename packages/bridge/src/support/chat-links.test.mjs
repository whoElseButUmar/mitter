import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';
import { setImmediate } from 'node:timers/promises';
import { worker, chatLink } from './fixtures.mjs';
const { ChatLinkStore, LINK_STORAGE_KEY, linkURL, parseChatLinks } = await import('../chat-links.ts');

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
      version: 2,
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
      [LINK_STORAGE_KEY]: {
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
