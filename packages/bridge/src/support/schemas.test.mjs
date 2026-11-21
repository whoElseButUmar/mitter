import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';

const { chatChoiceSchema } = await import('../start-sheet.ts');
const { chatLinkSchema, parseChatLinks, ChatLinkStore, LINK_STORAGE_KEY } = await import('../chat-links.ts');
const { dataResetStateSchema } = await import('../data-reset.ts');
const { resetViewContextSchema } = await import('../reset-views.ts');
const { debugEntrySchema } = await import('../diagnostics.ts');
const { replyHeadersSchema, replyHeaders, replyPreviewSchema } = await import('../reply-recovery.ts');
const { replyGapObservationSchema } = await import('../reply-gap.ts');
const { tabStateSchema, tabLeaseSchema, ChatTabLiveness } = await import('../tab-liveness.ts');
const { rewriteResultSchema } = await import('../rewrite-runner.ts');

const link = {
  providerId: 'chatgpt',
  id: 7,
  url: 'https://chatgpt.com/c/task-1',
  title: 'Task chat',
  newChat: false,
};
const receipt = {
  workerId: 'worker_1',
  projectId: 'project_1',
  goalHash: 'a'.repeat(64),
  textHash: 'b'.repeat(64),
  renderedHash: 'b'.repeat(64),
  at: 100,
};

test('serialized support schemas preserve absent optional fields', () => {
  for (const [schema, value] of [
    [chatChoiceSchema, { providerId: 'chatgpt', id: 7, title: 'Task chat', url: 'https://chatgpt.com' }],
    [chatLinkSchema, link],
    [dataResetStateSchema, { phase: 'idle' }],
    [resetViewContextSchema, {}],
    [tabStateSchema, {}],
    [replyHeadersSchema, { id: 'reply_1', workerId: 'worker_1', projectId: 'project_1' }],
    [rewriteResultSchema, { id: 'rewrite_1', state: 'waiting', tabId: 7, at: 100 }],
  ]) {
    assert.deepEqual(schema.parse(value), value);
    assert.equal(typeof schema.description, 'string');
  }
});

test('schemas reject malformed fields rather than coercing or defaulting them', () => {
  assert.equal(chatChoiceSchema.safeParse({ ...link, id: '7' }).success, false);
  assert.equal(chatChoiceSchema.safeParse({ ...link, providerId: undefined }).success, false);
  assert.equal(chatChoiceSchema.safeParse({ ...link, providerId: 'gemini' }).success, false);
  assert.equal(chatLinkSchema.safeParse({ ...link, maxTurns: 21 }).success, false);
  assert.equal(chatLinkSchema.safeParse({ ...link, maxMinutes: '30' }).success, false);
  assert.equal(dataResetStateSchema.safeParse({ phase: 'unknown' }).success, false);
  assert.equal(resetViewContextSchema.safeParse({ documentId: 123 }).success, false);
  assert.equal(tabStateSchema.safeParse({ autoDiscardable: 'false' }).success, false);
  assert.equal(
    debugEntrySchema.safeParse({ id: 1, time: 100, kind: 'test', message: 'x'.repeat(4001) }).success,
    false,
  );
  assert.equal(
    replyGapObservationSchema.safeParse({ missing: true, elapsedMs: -1, started: false }).success,
    false,
  );
});

test('legacy link parsing still discards invalid optional metadata without dropping a valid destination', () => {
  const links = parseChatLinks({
    worker_1: {
      ...link,
      url: link.url + '/?mode=test#reply',
      maxTurns: '20',
      maxMinutes: 61,
      bindingPending: false,
      projectId: 'invalid project',
      updatedAt: -100,
      lastReceipt: receipt,
    },
  });
  assert.deepEqual(links.get('worker_1'), { ...link, updatedAt: -100 });
  assert.equal(chatLinkSchema.safeParse(links.get('worker_1')).success, true);
});

test('link receipts remain bound to both the stored project and the map task ID', () => {
  const bound = { ...link, projectId: receipt.projectId, lastReceipt: receipt };
  assert.deepEqual(parseChatLinks({ worker_1: bound }).get('worker_1').lastReceipt, receipt);
  assert.equal(parseChatLinks({ worker_2: bound }).get('worker_2').lastReceipt, undefined);
  assert.equal(
    parseChatLinks({ worker_1: { ...bound, projectId: 'project_2' } }).get('worker_1').lastReceipt,
    undefined,
  );
});

test('link storage writes keep optional absence through JSON serialization and schema validation', async () => {
  const writes = [];
  const store = new ChatLinkStore({
    get: async () => ({}),
    async set(value) {
      writes.push(value);
    },
  });
  store.set('worker_1', link);
  await store.flush(true);
  assert.deepEqual(writes, [{ [LINK_STORAGE_KEY]: { version: 3, links: { worker_1: link } } }]);
  await store.quiesce();
});

test('header validation stays relaxed about actions and legacy exchange identifiers', () => {
  const headers = { id: 'reply_1', workerId: 'worker_1', projectId: 'project_1' };
  const envelope = { protocol: 'mitter/1', ...headers, actions: [{ type: 'invalid-action' }] };
  assert.deepEqual(replyHeaders(JSON.stringify(envelope), 'worker_1', 'project_1'), headers);
  assert.deepEqual(
    replyHeaders(JSON.stringify({ ...envelope, replyTo: 'legacy_exchange' }), 'worker_1', 'project_1'),
    { ...headers, replyTo: 'legacy_exchange' },
  );
  assert.throws(
    () => replyHeaders(JSON.stringify({ ...envelope, replyTo: 1 }), 'worker_1', 'project_1'),
    /Reply headers do not match this task/,
  );
  assert.throws(
    () => replyHeaders(JSON.stringify(envelope), 'worker_2', 'project_1'),
    /Reply headers do not match this task/,
  );
});

test('preview and rewrite schemas retain literal user text and intentional empty strings', () => {
  const preview = {
    ticket: 'opaque ticket',
    workerId: 'worker_1',
    taskName: '<b>Task</b>',
    summary: '',
    source: 'clipboard',
    actions: ['<img src=x>', 'Write source.txt (8 bytes)'],
    expiresAt: 100,
  };
  assert.deepEqual(replyPreviewSchema.parse(preview), preview);
  const rewritten = { id: 'rewrite_1', state: 'done', text: 'Literal\r\n`code`', tabId: 7, at: 100 };
  assert.deepEqual(rewriteResultSchema.parse(rewritten), rewritten);
});

test('tab leases reject invalid integers and oversized journals while absent recovery data changes no policy', async () => {
  for (const value of [[-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], Array(257).fill(1)]) {
    assert.equal(tabLeaseSchema.safeParse(value).success, false);
  }
  let tabReads = 0;
  let writes = 0;
  const liveness = new ChatTabLiveness(
    {
      async get() {
        tabReads++;
        return {};
      },
      async update() {
        assert.fail('Absent recovery metadata cannot authorize a tab update');
      },
    },
    {
      get: async () => ({}),
      async set() {
        writes++;
      },
    },
    () => {},
  );
  await liveness.ready;
  assert.equal(tabReads, 0);
  assert.equal(writes, 0);
  await liveness.releaseAll();
});
