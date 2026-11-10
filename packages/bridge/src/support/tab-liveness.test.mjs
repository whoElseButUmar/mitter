import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';
import { setImmediate } from 'node:timers/promises';
import { chatLink } from './fixtures.mjs';
const { ChatTabLiveness, TAB_LEASE_KEY, assertChatTabAvailable } = await import('../tab-liveness.ts');
const { PageBridgeError } = await import('../page-transport.ts');

test('tab policy coalesces repeated syncs and never protects a tab dropped during journal persistence', async () => {
  const journal = Promise.withResolvers();
  const events = [];
  const liveness = new ChatTabLiveness(
    {
      get: async () => ({ url: chatLink.url, autoDiscardable: true }),
      async update(tabId, changes) {
        events.push(['update', tabId, changes]);
      },
    },
    {
      get: async () => ({}),
      async set(values) {
        events.push(['journal', values[TAB_LEASE_KEY]]);
        if (values[TAB_LEASE_KEY].length) {
          await journal.promise;
        }
      },
    },
    () => {},
  );
  const protecting = liveness.sync([7]);
  assert.equal(liveness.sync([7]), protecting);
  await setImmediate();
  assert.deepEqual(events, [['journal', [7]]]);
  const dropping = liveness.sync([]);
  journal.resolve();
  await protecting;
  await dropping;
  assert.deepEqual(events, [
    ['journal', [7]],
    ['journal', []],
  ]);
  await liveness.releaseAll();
});

test('tab policy journals ownership before updates and leaves pre-existing or foreign policies alone', async () => {
  const tabs = new Map([
    [7, { url: chatLink.url, autoDiscardable: true }],
    [8, { url: chatLink.url, autoDiscardable: false }],
    [9, { url: 'https://example.com', autoDiscardable: true }],
  ]);
  const events = [];
  const liveness = new ChatTabLiveness(
    {
      get: async (tabId) => tabs.get(tabId),
      async update(tabId, changes) {
        events.push(['update', tabId, changes.autoDiscardable]);
        Object.assign(tabs.get(tabId), changes);
      },
    },
    {
      get: async () => ({}),
      async set(values) {
        events.push(['journal', values[TAB_LEASE_KEY]]);
      },
    },
    () => {},
  );
  await liveness.sync([7, 8, 9]);
  assert.deepEqual(events, [
    ['journal', [7]],
    ['update', 7, false],
  ]);
  await liveness.releaseAll();
  assert.deepEqual(events.slice(2), [
    ['update', 7, true],
    ['journal', []],
  ]);
  assert.equal(tabs.get(8).autoDiscardable, false);
});

test('malformed browser tab observations cannot change policy or release journal ownership', async (context) => {
  for (const tab of [
    undefined,
    null,
    [],
    { autoDiscardable: 'false' },
    { id: 8, url: chatLink.url, autoDiscardable: true },
  ]) {
    await context.test(JSON.stringify(tab), async () => {
      const changes = [];
      const liveness = new ChatTabLiveness(
        { get: async () => tab, update: async (...args) => changes.push(args) },
        { get: async () => ({}), set: async (...args) => changes.push(args) },
        () => {},
      );
      await assert.rejects(liveness.sync([7]), /invalid.*tab/i);
      assert.deepEqual(changes, []);

      const recovering = new ChatTabLiveness(
        { get: async () => tab, update: async (...args) => changes.push(args) },
        { get: async () => ({ [TAB_LEASE_KEY]: [7] }), set: async (...args) => changes.push(args) },
        () => {},
      );
      await assert.rejects(recovering.ready, /invalid.*tab/i);
      assert.deepEqual(changes, []);
    });
  }
});

test('malformed storage envelopes cannot be mistaken for absent tab policy', async () => {
  for (const stored of [null, [], false]) {
    const liveness = new ChatTabLiveness(
      {
        get: async () => ({ url: chatLink.url, autoDiscardable: true }),
        update: async () => assert.fail('Malformed storage cannot authorize tab changes'),
      },
      { get: async () => stored, set: async () => assert.fail('Malformed storage cannot authorize writes') },
      () => {},
    );
    await assert.rejects(liveness.ready, /Invalid saved chat-tab/);
    await assert.rejects(liveness.sync([7]), /could not be recovered/);
  }
});

test('invalid saved tab policy blocks new claims, while suspended-tab errors remain transient', async () => {
  let reads = 0;
  const liveness = new ChatTabLiveness(
    {
      async get() {
        reads++;
        return {};
      },
      async update() {
        assert.fail('No tab update is authorized');
      },
    },
    {
      get: async () => ({ [TAB_LEASE_KEY]: [-1] }),
      async set() {
        assert.fail('Invalid policy cannot be journaled');
      },
    },
    () => {},
  );
  await assert.rejects(liveness.ready, /Invalid saved chat-tab/);
  await assert.rejects(liveness.sync([7]), /could not be recovered/);
  assert.equal(reads, 0);
  assert.throws(
    () => assertChatTabAvailable({ discarded: true, frozen: true }),
    (error) => error instanceof PageBridgeError && error.code === 'TAB_DISCARDED' && error.transient === true,
  );
  assert.throws(
    () => assertChatTabAvailable({ frozen: true }),
    (error) => error instanceof PageBridgeError && error.code === 'TAB_FROZEN' && error.transient === true,
  );
});
