import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

const { buildExchangeMessage, renewExchangeMessage } = await import('./prompts.ts');
const { messageDigest, unwrapMessage } = await import('../message-wire.ts');

async function watchingHarness() {
  const harness = createHarness();
  await harness.runner.start();
  await harness.runner.stop('Cannot read reply.', 'error', 'REPLY_UNREADABLE');
  return harness;
}

test('resending rotates only the framing and Miter example, preserving matching UUIDs in the reviewed goal and report', () => {
  const worker = { id: 'worker_1', projectId: 'project_1' };
  const first = '12345678-aaaa-4444-bbbb-123456789abc';
  const next = '12345678-bbbb-4444-aaaa-123456789abc';
  const example = JSON.stringify(
    {
      protocol: 'mitter/1',
      id: 'REPLACE_WITH_A_NEW_UNIQUE_ID_EVERY_TURN',
      workerId: worker.id,
      projectId: worker.projectId,
      summary: 'What this batch does',
      actions: [{ type: 'list', path: '.' }],
    },
    null,
    2,
  );
  const body = [
    'Keep the literal old ID in this task: ' + first,
    'For THIS ChatGPT handoff, wrap the actions in exactly this envelope instead of the simpler local-model shape:',
    example,
    'BEGIN UNTRUSTED MITTER REPORT',
    'const archived = ' + JSON.stringify({ replyTo: first }) + ';',
    example,
    'END UNTRUSTED MITTER REPORT',
  ].join('\n');
  const original = buildExchangeMessage(body, first, worker);
  assert.equal(renewExchangeMessage(original, first, next, worker), buildExchangeMessage(body, next, worker));
  assert.equal(renewExchangeMessage(original, next, first, worker), undefined);
  assert.equal(
    renewExchangeMessage(
      original.replace('CURRENT REPLY CONTRACT', 'Edited instructions'),
      first,
      next,
      worker,
    ),
    undefined,
  );
});

async function holdReplyWatch(harness) {
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
  const watching = harness.runner.tick();
  await entered.promise;
  return { watching, release };
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

test('a restart between resend checkpoint and composer insertion reuses the new receipt exactly once', async () => {
  const previous = await watchingHarness();
  const reviewed = await previous.runner.recoveryPrompt();
  previous.configuration.failReceipt = true;
  await assert.rejects(previous.runner.resendPrompt(true, reviewed), { code: 'RECEIPT_SAVE_FAILED' });
  assert.equal(previous.commits.length, 1);
  const progress = previous.progress();
  assert.equal(progress.stage, 'prepared');
  const receipt = progress.lastReceipt;
  assert.equal(receipt.replacesExchangeId, unwrapMessage(reviewed).exchangeId);
  for (const [visible, expectedSends] of [
    [reviewed, 1],
    [reviewed + 'edited', 0],
  ]) {
    const resumed = createHarness({
      progress: structuredClone(progress),
      options: { resumeExisting: true },
      view: { count: 2, userCount: 1, lastRole: 'assistant', lastUserId: 'sent_user', lastUserText: visible },
    });
    if (expectedSends === 1) {
      await resumed.runner.start();
      assert.equal(resumed.commits[0].messageId, receipt.messageId);
      assert.equal(await messageDigest(resumed.commits[0].text), receipt.textHash);
      assert.equal(resumed.runner.status.turns, 2);
    } else {
      await assert.rejects(resumed.runner.start(), { code: 'PREPARED_MESSAGE_CHANGED' });
    }
    assert.equal(resumed.commits.length, expectedSends);
    assert.equal(resumed.imports.length, 0);
    await resumed.runner.stop();
  }
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

test(
  'confirmed resend waits for an in-flight read and reserves exactly one recovery',
  { timeout: 2000 },
  async () => {
    const harness = await watchingHarness();
    const reviewed = await harness.runner.recoveryPrompt();
    const poll = await holdReplyWatch(harness);
    const resending = harness.runner.resendPrompt(true, reviewed);
    resending.catch(() => {});
    await assert.rejects(harness.runner.resendPrompt(true, reviewed), /after your confirmation/);
    await harness.runner.tick();
    assert.equal(harness.events.filter((event) => event === 'page:inspect').length, 1);
    assert.equal(harness.commits.length, 1);
    poll.release.resolve();
    await poll.watching;
    assert.deepEqual(await resending, { sent: true });
    await harness.runner.settled();
    assert.equal(harness.commits.length, 2);
    assert.equal(
      harness.commits[1].text,
      renewExchangeMessage(
        reviewed,
        unwrapMessage(reviewed).exchangeId,
        harness.options.lastReceipt.exchangeId,
        harness.worker,
      ),
    );
    assert.notEqual(harness.options.lastReceipt.exchangeId, unwrapMessage(reviewed).exchangeId);
    assert.equal(harness.runner.status.turns, 2);
    assert.equal(harness.imports.length, 0);
    await harness.runner.stop();
  },
);

test(
  'Stop while resend waits for the read prevents another inspection or send',
  { timeout: 2000 },
  async () => {
    const harness = await watchingHarness();
    const reviewed = await harness.runner.recoveryPrompt();
    const poll = await holdReplyWatch(harness);
    const resending = harness.runner.resendPrompt(true, reviewed);
    const rejection = assert.rejects(resending, /Task stopped during resend/);
    await harness.runner.stop();
    poll.release.resolve();
    await Promise.all([poll.watching, rejection]);
    await harness.runner.settled();
    assert.equal(harness.events.filter((event) => event === 'page:inspect').length, 2);
    assert.equal(harness.commits.length, 1);
    assert.equal(harness.imports.length, 0);
  },
);

test('a replaced task while resend waits cannot use the prior confirmation', { timeout: 2000 }, async () => {
  const harness = await watchingHarness();
  const reviewed = await harness.runner.recoveryPrompt();
  const poll = await holdReplyWatch(harness);
  const resending = harness.runner.resendPrompt(true, reviewed);
  const rejection = assert.rejects(resending, { code: 'RUN_SUPERSEDED' });
  harness.worker.runId = 'replacement_run';
  poll.release.resolve();
  await Promise.all([poll.watching, rejection]);
  await harness.runner.settled();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
});

test(
  'a stable reply found by the in-flight read cancels resend without racing activation',
  { timeout: 2000 },
  async () => {
    const harness = await watchingHarness();
    const reviewed = await harness.runner.recoveryPrompt();
    harness.showReply();
    await harness.runner.tick();
    harness.advance(1800);
    const poll = await holdReplyWatch(harness);
    const resending = harness.runner.resendPrompt(true, reviewed);
    resending.catch(() => {});
    poll.release.resolve();
    await poll.watching;
    assert.deepEqual(await resending, { sent: false, replyFound: true });
    await harness.runner.settled();
    assert.equal(harness.runner.status.monitoring, true);
    assert.equal(harness.commits.length, 1);
    assert.equal(harness.imports.length, 0);
    harness.advance(1800);
    await harness.runner.tick();
    assert.equal(harness.runner.status.active, true);
    await harness.runner.stop();
  },
);
