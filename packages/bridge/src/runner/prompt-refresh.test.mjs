import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

async function completedBatch() {
  const harness = createHarness();
  await harness.runner.start();
  harness.showReply();
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  harness.worker.state = 'review';
  return harness;
}

test('a new report exchange refreshes registered commands without changing a pending send', async () => {
  const harness = await completedBatch();
  const initialSend = structuredClone(harness.commits[0]);
  const rpc = harness.dependencies.rpc;
  let nextPrompt = 'Registered commands: test. Project context: current instructions.';
  let promptReads = 0;
  harness.dependencies.rpc = async (method, params) => {
    if (method === 'worker.prompt' && params.kind === 'next') {
      promptReads++;
      return nextPrompt;
    }
    return rpc(method, params);
  };
  harness.configuration.prepareOutcome = 'pending';
  await harness.runner.tick();
  const prepared = structuredClone(harness.options.lastReceipt);
  assert.equal(promptReads, 1);
  assert.equal(harness.progress().stage, 'prepared');
  assert.equal(harness.commits.length, 1);

  nextPrompt = 'A later command and context update must wait for another exchange.';
  harness.configuration.prepareOutcome = 'prepared';
  await harness.runner.tick();
  assert.equal(promptReads, 1);
  assert.equal(harness.commits.length, 2);
  assert.deepEqual(harness.commits[0], initialSend);
  assert.match(
    harness.commits[1].text,
    /Registered commands: test\. Project context: current instructions\./,
  );
  assert.doesNotMatch(harness.commits[1].text, /A later command/);
  assert.equal(harness.options.lastReceipt.exchangeId, prepared.exchangeId);
  assert.equal(harness.options.lastReceipt.messageId, prepared.messageId);
  assert.equal(harness.options.lastReceipt.textHash, prepared.textHash);
  assert.equal(harness.imports.length, 1);
  await harness.runner.stop();
});

test('a rejected context refresh preserves the completed batch without sending stale instructions', async () => {
  const harness = await completedBatch();
  const receipt = structuredClone(harness.options.lastReceipt);
  const rpc = harness.dependencies.rpc;
  harness.dependencies.rpc = async (method, params) => {
    if (method === 'worker.prompt' && params.kind === 'next') {
      return null;
    }
    return rpc(method, params);
  };
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, false);
  assert.match(harness.runner.status.reason, /invalid result for worker.prompt/);
  assert.equal(harness.progress().stage, 'report_due');
  assert.deepEqual(harness.options.lastReceipt, receipt);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.events.includes('worker.report'), false);
});

test('Stop during a context refresh prevents a late report or send', async () => {
  const harness = await completedBatch();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const rpc = harness.dependencies.rpc;
  harness.dependencies.rpc = async (method, params) => {
    if (method === 'worker.prompt' && params.kind === 'next') {
      entered.resolve();
      await release.promise;
    }
    return rpc(method, params);
  };
  const ticking = harness.runner.tick();
  await entered.promise;
  const stopping = harness.runner.stop();
  release.resolve();
  await Promise.all([ticking, stopping]);
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.events.includes('worker.report'), false);
});
