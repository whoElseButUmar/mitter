import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

const { parseProposalEnvelope } = await import('../../../protocol/src/proposal.ts');
const { NativeRequestTimeout } = await import('../native-request.ts');
const { PageBridgeError } = await import('../page-transport.ts');

test('native timeout wording reports uncertainty without promising reconciliation or a blind retry', () => {
  for (const method of ['worker.prompt', 'state', 'worker.import', 'worker.run']) {
    const error = new NativeRequestTimeout(method);
    assert.equal(error.message, method + ' acknowledgement timed out. The outcome is not confirmed.');
    assert.equal(error.code, 'NATIVE_REQUEST_TIMEOUT');
    assert.equal(error.method, method);
  }
});

test('failed chat interruption does not claim local work stopped after an unacknowledged pause', async () => {
  const harness = createHarness();
  await harness.runner.start();
  harness.worker.state = 'executing';
  const logs = [];
  harness.dependencies.log = (kind, message) => logs.push({ kind, message });
  const rpc = harness.dependencies.rpc;
  const page = harness.dependencies.page;
  harness.dependencies.rpc = async (method, params) => {
    if (method === 'worker.pause') {
      throw new NativeRequestTimeout(method);
    }
    return rpc(method, params);
  };
  harness.dependencies.page = async (tabId, request) => {
    if (request.op === 'interrupt') {
      throw new PageBridgeError('BRIDGE_TIMEOUT', 'No interruption acknowledgement.', true);
    }
    return page(tabId, request);
  };
  await harness.runner.stop();
  await harness.runner.interruptGeneration();
  const interruption = logs.find((entry) => entry.kind === 'bridge.interrupt');
  assert.ok(interruption);
  assert.equal(interruption.message, 'No interruption acknowledgement. Chat interruption was not confirmed.');
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.commits.length, 1);
});

for (const heldOperation of ['worker.pause', 'page:stop']) {
  test(`direct Stop and settled both drain the pending ${heldOperation} request`, async () => {
    const harness = createHarness();
    await harness.runner.start();
    harness.worker.state = 'executing';
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const rpc = harness.dependencies.rpc;
    const page = harness.dependencies.page;
    harness.dependencies.rpc = async (method, params) => {
      const result = await rpc(method, params);
      if (method === heldOperation) {
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    harness.dependencies.page = async (tabId, request) => {
      const result = await page(tabId, request);
      if ('page:' + request.op === heldOperation) {
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const stopping = harness.runner.stop();
    await entered.promise;
    assert.equal(harness.runner.status.active, false);
    let settled = false;
    let stoppedAgain = false;
    const settling = harness.runner.settled().then(() => {
      settled = true;
    });
    const stoppingAgain = harness.runner.stop().then(() => {
      stoppedAgain = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    try {
      assert.equal(settled, false, 'Settled must include direct Stop requests');
      assert.equal(stoppedAgain, false, 'A repeated Stop must join the pending Stop');
    } finally {
      release.resolve();
      await Promise.all([stopping, stoppingAgain, settling]);
    }
    assert.equal(settled, true);
    assert.equal(stoppedAgain, true);
    assert.equal(harness.imports.length, 0);
    assert.equal(harness.commits.length, 1);
  });
}

test('Stop during byte-exact reply hashing cannot repopulate the cleared delivery payload', async (context) => {
  const harness = createHarness();
  await harness.runner.start();
  const envelope = harness.showReply({
    summary: 'DO_NOT_RETAIN_AFTER_STOP',
    actions: [{ type: 'write', path: 'file.txt', content: '  `literal`\\source\n', expectedHash: 'missing' }],
  });
  await harness.runner.tick();
  harness.advance(1800);
  const canonical = JSON.stringify(parseProposalEnvelope(JSON.stringify(envelope)));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  context.mock.method(crypto.subtle, 'digest', async (algorithm, bytes) => {
    if (new TextDecoder().decode(bytes) === canonical) {
      entered.resolve();
      await release.promise;
    }
    return digest(algorithm, bytes);
  });
  const ticking = harness.runner.tick();
  await Promise.race([
    entered.promise,
    ticking.then(() => {
      throw new Error('Expected reply hashing to pause: ' + harness.runner.status.reason);
    }),
  ]);
  await harness.runner.stop();
  release.resolve();
  await ticking;
  await harness.runner.settled();
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.runner.pendingDelivery, undefined);
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.events.includes('worker.run'), false);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.progress().phase, 'stopped');
});
