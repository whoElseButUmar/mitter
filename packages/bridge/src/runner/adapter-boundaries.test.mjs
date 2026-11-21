import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createHarness } from './fixtures.mjs';

const { BridgeRunner } = await import('./bridge-runner.ts');
const { ZodError } = await import('zod');

function replacePageResult(harness, operation, replace) {
  const page = harness.dependencies.page;
  harness.dependencies.page = async function (tabId, request) {
    assert.equal(this, harness.dependencies);
    const view = await page(tabId, request);
    if (request.op === operation) {
      return replace(view);
    }
    return view;
  };
}

async function acceptReply(harness) {
  await harness.runner.start();
  harness.showReply();
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.runner.status.phase, 'running');
}

test('runner options reject malformed identities and receipts before acquiring resources', () => {
  for (const changes of [
    { workerId: 'invalid worker' },
    { projectId: null },
    { tabId: -1 },
    { token: 42 },
    { previousProgress: { turns: '1' } },
    { lastReceipt: { workerId: 'worker_1' } },
  ]) {
    const harness = createHarness();
    assert.throws(
      () => new BridgeRunner({ ...harness.options, ...changes }, harness.dependencies),
      (error) => {
        assert.match(error.message, /Invalid bridge options/);
        assert.ok(error.cause instanceof ZodError);
        return true;
      },
    );
    assert.deepEqual(harness.events, []);
  }
});

test('malformed progress loads cannot reset history or authorize page mutations', async (context) => {
  for (const value of [
    undefined,
    null,
    [],
    'private history',
    {},
    { progress: null },
    { importedCount: 0 },
  ]) {
    await context.test(String(value), async () => {
      const harness = createHarness();
      harness.dependencies.loadProgress = async () => value;
      await assert.rejects(harness.runner.start(), (error) => {
        assert.equal(error.code, 'PROGRESS_VERSION');
        assert.ok(error.cause instanceof ZodError);
        return true;
      });
      assert.equal(
        harness.events.some((event) => event.startsWith('save:')),
        false,
      );
      assert.equal(harness.events.includes('page:prepare'), false);
      assert.equal(harness.commits.length, 0);
      assert.equal(harness.imports.length, 0);
    });
  }
});

test('malformed initial page observations cannot prepare, Send, or import', async (context) => {
  for (const [name, replace] of [
    ['missing state', () => undefined],
    ['null', () => null],
    ['negative count', (view) => ({ ...view, count: -1 })],
    ['truthy draft', (view) => ({ ...view, draft: 'false' })],
    ['malformed transcript', (view) => ({ ...view, transcript: { users: 1 } })],
  ]) {
    await context.test(name, async () => {
      const harness = createHarness();
      replacePageResult(harness, 'inspect', replace);
      await harness.runner.start();
      assert.equal(harness.runner.status.phase, 'reconnecting');
      harness.advance(30000);
      await harness.runner.tick();
      assert.equal(harness.runner.status.active, true);
      assert.equal(harness.runner.status.phase, 'reconnecting');
      harness.advance(30000);
      await harness.runner.tick();
      assert.equal(harness.runner.status.errorCode, 'INVALID_PAGE_STATE');
      assert.equal(harness.runner.status.reason.includes('"users"'), false);
      assert.equal(harness.events.includes('page:prepare'), false);
      assert.equal(harness.commits.length, 0);
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.runner.status.turns, 0);
    });
  }
});

test('malformed preparation results never advance to a commit', async () => {
  const harness = createHarness();
  replacePageResult(harness, 'prepare', (view) => ({ ...view, composerSession: 'invalid document' }));
  await harness.runner.start();
  await harness.runner.tick();
  assert.equal(harness.commits.length, 0);
  assert.equal(harness.runner.status.turns, 0);
  assert.equal(harness.progress().stage, 'prepared');
});

test('malformed commit acknowledgements stay read-only even with a saved document ledger', async () => {
  const harness = createHarness();
  replacePageResult(harness, 'commit', (view) => ({ ...view, outcome: undefined }));
  await harness.runner.start();
  for (const delay of [0, 1800, 1800]) {
    harness.advance(delay);
    await harness.runner.tick();
  }
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.runner.status.turns, 1);
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.progress().stage, 'waiting_reply');
});

test('malformed independent Pause observations cannot stop a valid local batch', async () => {
  const harness = createHarness();
  await acceptReply(harness);
  replacePageResult(harness, 'control', (view) => ({ ...view, stopped: 'true' }));
  await harness.runner.tick();
  await setImmediate();
  assert.equal(harness.events.includes('page:control'), true);
  assert.equal(harness.runner.status.active, true);
  assert.equal(harness.events.includes('worker.pause'), false);
  assert.equal(harness.imports.length, 1);
});

test('malformed late-watch observations retain the deadline without importing or replaying Send', async () => {
  const harness = createHarness();
  await harness.runner.start();
  await harness.runner.stop('Cannot read reply.', 'error', 'REPLY_UNREADABLE');
  const deadline = harness.runner.status.watchUntil;
  const saved = harness.progress();
  harness.showReply();
  replacePageResult(harness, 'inspect', (view) => ({ ...view, busy: 'false' }));
  for (const delay of [1800, 1800, 1800]) {
    harness.advance(delay);
    await harness.runner.tick();
  }
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.runner.status.watchUntil, deadline);
  assert.deepEqual(harness.progress(), saved);
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.commits.length, 1);
});

test('untrusted page evidence is removed without mutating the adapter-owned observation', async () => {
  const harness = createHarness();
  const page = harness.dependencies.page;
  const observations = [];
  harness.dependencies.page = async (tabId, request) => {
    const observation = Object.freeze({ ...(await page(tabId, request)), replyEvidence: 'exchange' });
    observations.push(observation);
    return observation;
  };
  await harness.runner.start();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
  assert.ok(observations.every((view) => view.replyEvidence === 'exchange'));
});
