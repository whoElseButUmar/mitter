import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

const { buildExchangeMessage } = await import('./prompts.ts');

const newChatOptions = { newChat: true, url: 'https://chatgpt.com/' };
// The page adapter removes the root's trailing slash in its observations.
const emptyNewChat = { url: 'https://chatgpt.com' };

async function pausedBeforeSend() {
  const harness = createHarness({
    options: newChatOptions,
    view: { ...emptyNewChat, draft: true, draftText: 'A restored draft from a different task.' },
  });
  await assert.rejects(harness.runner.start(), { code: 'DRAFT_CONFLICT' });
  await harness.runner.settled();
  assert.equal(harness.commits.length, 0);
  assert.equal(harness.progress().turns, 0);
  assert.equal(harness.progress().lowerBound, false);
  assert.equal(harness.progress().stage, 'ready');
  assert.equal(harness.progress().lastReceipt, undefined);
  return structuredClone(harness.progress());
}

function resumedHarness(progress, configuration = {}) {
  return createHarness({
    ...configuration,
    progress,
    options: { ...newChatOptions, resumeExisting: true, ...configuration.options },
    view: { ...emptyNewChat, ...configuration.view },
  });
}

test('an unavailable composer waits without preparing or sending and stops with explicit recovery', async () => {
  const harness = createHarness({
    options: newChatOptions,
    view: { ...emptyNewChat, ready: false },
  });
  await harness.runner.start();
  assert.equal(harness.runner.status.phase, 'connecting');
  assert.equal(harness.runner.status.active, true);
  harness.advance(60000);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, true);
  assert.equal(harness.events.includes('page:prepare'), false);
  assert.equal(harness.commits.length, 0);
  harness.advance(1);
  await harness.runner.tick();
  await harness.runner.settled();
  assert.equal(harness.runner.status.errorCode, 'CHAT_NOT_READY');
  assert.equal(harness.runner.status.active, false);
  assert.match(harness.runner.status.reason, /check page loading and sign in if needed/);
  assert.match(harness.runner.status.reason, /No new Send was attempted/);
  assert.equal(harness.events.includes('page:prepare'), false);
  assert.equal(harness.commits.length, 0);
  assert.equal(harness.progress().turns, 0);
  assert.equal(harness.progress().stage, 'ready');

  harness.setView({ ready: true });
  await harness.runner.tick();
  assert.equal(harness.commits.length, 0, 'Readiness alone cannot resume a timed-out task.');
  const resumed = resumedHarness(structuredClone(harness.progress()));
  await resumed.runner.start();
  await resumed.runner.tick();
  assert.equal(resumed.commits.length, 1, 'An explicit resume sends the never-sent bootstrap exactly once.');
  assert.equal(resumed.imports.length, 0);
  await resumed.runner.stop();
});

test('a composer becoming ready before timeout continues the original startup once', async () => {
  const harness = createHarness({ options: newChatOptions, view: { ...emptyNewChat, ready: false } });
  await harness.runner.start();
  harness.advance(1000);
  harness.setView({ ready: true });
  await harness.runner.tick();
  await harness.runner.tick();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.runner.status.errorCode, undefined);
  await harness.runner.stop();
});

test('clearing a draft before the first send lets a saved new task resume exactly once', async () => {
  const progress = await pausedBeforeSend();
  const harness = resumedHarness(progress);
  await harness.runner.start();
  assert.equal(harness.commits.length, 1);
  assert.match(harness.commits[0].text, /BOOTSTRAP/);
  assert.equal(harness.progress().turns, 1);
  assert.equal(harness.progress().stage, 'waiting_reply');
  assert.equal(harness.runner.status.phase, 'waiting_reply');
  await harness.runner.tick();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
  await harness.runner.stop();
});

test('a browser root URL with a trailing slash also resumes a never-sent task', async () => {
  const progress = await pausedBeforeSend();
  const harness = resumedHarness(progress, { view: { url: 'https://chatgpt.com/' } });
  await harness.runner.start();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.progress().turns, 1);
  await harness.runner.stop();
});

test('resuming an unsent task still preserves a restored unrelated draft', async () => {
  const progress = await pausedBeforeSend();
  const harness = resumedHarness(progress, {
    view: { draft: true, draftText: 'The draft has not been cleared.' },
  });
  await assert.rejects(harness.runner.start(), { code: 'DRAFT_CONFLICT' });
  assert.equal(harness.commits.length, 0);
  assert.equal(harness.progress().turns, 0);
});

test('an exact framed bootstrap in a never-sent chat keeps its exchange and sends once', async () => {
  const progress = await pausedBeforeSend();
  const exchangeId = 'abcd1234-1234-1234-1234-abcd12341234';
  const worker = { id: progress.workerId, projectId: progress.projectId };
  const draftText = buildExchangeMessage('BOOTSTRAP', exchangeId, worker);
  const harness = resumedHarness(progress, { view: { draft: true, draftText } });

  await harness.runner.start();
  assert.deepEqual(
    harness.commits.map((commit) => commit.text),
    [draftText],
  );
  assert.equal(harness.progress().lastReceipt.exchangeId, exchangeId);
  assert.equal(harness.progress().lastReceipt.expectsReplyTo, true);
  assert.equal(harness.progress().turns, 1);
  assert.equal(harness.commits[0].adoptBootstrapDraft, true);
  await harness.runner.stop();
});

test('an edited bootstrap with the same exchange ID remains untouched', async () => {
  const progress = await pausedBeforeSend();
  const exchangeId = 'abcd1234-1234-1234-1234-abcd12341234';
  const worker = { id: progress.workerId, projectId: progress.projectId };
  const draftText = buildExchangeMessage('BOOTSTRAP\nUser edit', exchangeId, worker);
  const harness = resumedHarness(progress, { view: { draft: true, draftText } });

  await assert.rejects(harness.runner.start(), { code: 'DRAFT_CONFLICT' });
  assert.equal(harness.events.includes('page:prepare'), false);
  assert.equal(harness.commits.length, 0);
});

test('exact zero-turn progress cannot authorize sending into another populated chat', async () => {
  const progress = await pausedBeforeSend();
  const harness = resumedHarness(progress, {
    view: { count: 1, userCount: 1, lastRole: 'user', lastUserText: 'An unrelated conversation.' },
  });
  await assert.rejects(harness.runner.start(), { code: 'CHAT_OWNERSHIP' });
  assert.equal(harness.commits.length, 0);
  assert.equal(harness.imports.length, 0);
});

test('an unsent new task waits for a busy composer before its first send', async () => {
  const progress = await pausedBeforeSend();
  const harness = resumedHarness(progress, { view: { busy: true } });
  await harness.runner.start();
  assert.equal(harness.commits.length, 0);
  harness.setView({ busy: false });
  await harness.runner.tick();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.progress().turns, 1);
  await harness.runner.stop();
});

test('a blank new chat cannot reset known or uncertain previous work', async (context) => {
  const unsent = await pausedBeforeSend();
  for (const [name, changes] of [
    ['a lower-bound count', { lowerBound: true }],
    ['a reserved turn', { turns: 1 }],
    ['a prepared exchange', { stage: 'prepared' }],
    ['an imported reply', { lastImportedId: 'previous_reply' }],
    ['a saved conversation', { conversationUrl: 'https://chatgpt.com/c/previous' }],
  ]) {
    await context.test(name, async () => {
      const harness = resumedHarness({ ...unsent, ...changes });
      await harness.runner.start();
      assert.equal(harness.runner.status.phase, 'connecting');
      assert.equal(harness.commits.length, 0);
      harness.advance(61000);
      await harness.runner.tick();
      assert.equal(harness.runner.status.errorCode, 'CHAT_NOT_LOADED');
      assert.equal(harness.commits.length, 0);
      assert.equal(harness.imports.length, 0);
      await harness.runner.stop();
    });
  }
});

test('missing progress and host imports do not qualify as a never-sent task', async (context) => {
  await context.test('no saved progress', async () => {
    const harness = resumedHarness(undefined);
    await harness.runner.start();
    assert.equal(harness.progress().lowerBound, true);
    assert.equal(harness.runner.status.phase, 'connecting');
    assert.equal(harness.commits.length, 0);
    await harness.runner.stop();
  });
  await context.test('host already accepted a batch', async () => {
    const progress = await pausedBeforeSend();
    const harness = resumedHarness(progress);
    harness.dependencies.loadProgress = async () => ({ progress, importedCount: 1 });
    await harness.runner.start();
    assert.equal(harness.progress().turns, 1);
    assert.equal(harness.runner.status.phase, 'connecting');
    assert.equal(harness.commits.length, 0);
    await harness.runner.stop();
  });
});

test('a committed initial receipt on a blank root is awaited without resending', async () => {
  const original = createHarness({ options: newChatOptions, view: emptyNewChat });
  await original.runner.start();
  await original.runner.stop();
  assert.equal(original.commits.length, 1);
  const progress = structuredClone(original.progress());
  const receipt = structuredClone(progress.lastReceipt);
  const harness = resumedHarness(progress);
  await harness.runner.start();
  assert.equal(harness.runner.status.phase, 'waiting_reply');
  assert.equal(harness.runner.status.turns, 1);
  assert.deepEqual(harness.progress().lastReceipt, receipt);
  await harness.runner.tick();
  assert.equal(harness.commits.length, 0);
  assert.equal(harness.imports.length, 0);
  await harness.runner.stop();
});
