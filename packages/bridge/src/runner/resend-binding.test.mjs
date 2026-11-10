import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

const { buildExchangeMessage } = await import('./prompts.ts');
const { messageDigest, unwrapMessage } = await import('../message-wire.ts');

async function watchingHarness() {
  const harness = createHarness();
  await harness.runner.start();
  await harness.runner.stop('Cannot read reply.', 'error', 'REPLY_UNREADABLE');
  return harness;
}

async function replacePendingPrompt(harness) {
  const previous = harness.options.lastReceipt;
  const text = buildExchangeMessage(
    'A different pending prompt with `literal`\\source\n',
    previous.exchangeId,
    harness.worker,
  );
  const frame = unwrapMessage(text);
  assert.ok(frame);
  const textHash = await messageDigest(text);
  const receipt = {
    ...previous,
    textHash,
    renderedHash: textHash,
    payloadHash: await messageDigest(frame.payload),
  };
  harness.options.lastReceipt = receipt;
  harness.runner.progress.lastReceipt = receipt;
  harness.runner.expectedUserText = text;
  harness.setView({ lastUserText: text });
  return text;
}

test('resend requires the exact reviewed prompt rather than absent, malformed or normalized text', async () => {
  const harness = await watchingHarness();
  const reviewed = await harness.runner.recoveryPrompt();
  for (const expectedPrompt of [
    undefined,
    null,
    {},
    reviewed + '\n',
    reviewed.replace('BOOTSTRAP', 'bootstrap'),
  ]) {
    await assert.rejects(harness.runner.resendPrompt(true, expectedPrompt), { code: 'RESEND_MISMATCH' });
    assert.equal(harness.runner.status.monitoring, true);
    assert.equal(harness.runner.status.turns, 1);
    assert.equal(harness.commits.length, 1);
    assert.equal(harness.imports.length, 0);
  }
  await harness.runner.stop();
});

test('a pending prompt replaced during the resend inspection cannot use the older review', async () => {
  const harness = await watchingHarness();
  const reviewed = await harness.runner.recoveryPrompt();
  const page = harness.dependencies.page;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let held = false;
  harness.dependencies.page = async (tabId, request) => {
    if (request.op === 'inspect' && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return page(tabId, request);
  };
  const resending = harness.runner.resendPrompt(true, reviewed);
  const rejection = assert.rejects(resending, { code: 'RESEND_MISMATCH' });
  await entered.promise;
  const replacement = await replacePendingPrompt(harness);
  assert.notEqual(replacement, reviewed);
  release.resolve();
  await rejection;
  await harness.runner.settled();
  assert.equal(harness.runner.status.monitoring, true);
  assert.equal(harness.runner.status.turns, 1);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.events.filter((event) => event === 'page:prepare').length, 1);
  assert.equal(harness.imports.length, 0);
  await harness.runner.stop();
});

test('a receipt replaced after prompt recovery still blocks the reviewed send', async () => {
  const harness = await watchingHarness();
  const reviewed = await harness.runner.recoveryPrompt();
  const recover = harness.runner.recoveryPrompt.bind(harness.runner);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  harness.runner.recoveryPrompt = async () => {
    const text = await recover();
    entered.resolve();
    await release.promise;
    return text;
  };
  const resending = harness.runner.resendPrompt(true, reviewed);
  const rejection = assert.rejects(resending, { code: 'RESEND_MISMATCH' });
  await entered.promise;
  await replacePendingPrompt(harness);
  release.resolve();
  await rejection;
  await harness.runner.settled();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.events.filter((event) => event === 'page:prepare').length, 1);
  assert.equal(harness.imports.length, 0);
});

test('prompt recovery returns the text actually validated before an asynchronous field replacement', async (context) => {
  const harness = await watchingHarness();
  const reviewed = harness.commits[0].text;
  const matches = harness.runner.matchesSavedReceipt.bind(harness.runner);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  context.mock.method(harness.runner, 'matchesSavedReceipt', async (text) => {
    const matching = await matches(text);
    entered.resolve();
    await release.promise;
    return matching;
  });
  const recovering = harness.runner.recoveryPrompt();
  await entered.promise;
  harness.runner.expectedUserText = 'Unverified replacement that was never sent.';
  release.resolve();
  assert.equal(await recovering, reviewed);
  await harness.runner.stop();
});

test('a replaced execution epoch during the resend checkpoint cannot reach preparation or commit', async () => {
  const harness = await watchingHarness();
  const reviewed = await harness.runner.recoveryPrompt();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let held = false;
  harness.configuration.beforeSave = async (progress) => {
    if (progress.stage === 'prepared' && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
  };
  const resending = harness.runner.resendPrompt(true, reviewed);
  const rejection = assert.rejects(resending, { code: 'RUN_SUPERSEDED' });
  await entered.promise;
  harness.worker.control = {
    version: 1,
    epoch: 1,
    mode: 'fresh',
    at: harness.now(),
    operationId: 'replacement_1',
    reason: 'Continue fresh',
    retiredExchanges: [harness.options.lastReceipt.exchangeId],
  };
  harness.worker.runId = 'replacement_run';
  release.resolve();
  await rejection;
  await harness.runner.settled();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.events.filter((event) => event === 'page:prepare').length, 1);
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.runner.pendingSend, undefined);
});
