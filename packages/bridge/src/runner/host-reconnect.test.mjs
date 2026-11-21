import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';
import { PageBridgeError } from '../page-transport.ts';

async function waitingHarness(configuration) {
  const harness = createHarness(configuration);
  const snapshot = harness.dependencies.snapshot;
  const reads = [];
  let offline = false;
  const loadProgress = harness.dependencies.loadProgress;
  harness.dependencies.loadProgress = async () => {
    reads.push('progress');
    return loadProgress();
  };
  harness.dependencies.reconnectHost = async () => {
    reads.push('state');
    offline = false;
    return snapshot();
  };
  harness.dependencies.snapshot = () => {
    if (offline) {
      return undefined;
    }
    return snapshot();
  };
  await harness.runner.start();
  assert.equal(harness.runner.status.phase, 'waiting_reply');
  reads.length = 0;
  return {
    ...harness,
    reads,
    snapshot,
    offline(value) {
      offline = value;
    },
    disconnect() {
      assert.equal(harness.runner.hostDisconnected(), true);
      offline = true;
    },
  };
}

test('an idle reply wait reconnects with state/progress reads and resumes on a later tick without Send', async () => {
  const harness = await waitingHarness();
  const receipt = structuredClone(harness.progress().lastReceipt);
  const before = harness.events.length;
  harness.disconnect();
  assert.equal(harness.runner.status.phase, 'reconnecting');
  assert.equal(harness.runner.status.errorCode, 'HOST_RECONNECTING');
  await harness.runner.tick();
  assert.deepEqual(harness.reads, ['state', 'progress']);
  assert.deepEqual(
    harness.events.slice(before),
    [],
    'Reconnect itself performs no page or mutation operation.',
  );
  assert.equal(harness.runner.status.phase, 'waiting_reply');
  assert.equal(harness.runner.status.active, true);
  assert.equal(harness.runner.status.errorCode, undefined);
  assert.deepEqual(harness.progress().lastReceipt, receipt);
  await harness.runner.tick();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
  await harness.runner.stop();
});

test('repeated disconnect notifications retain bounded read backoff instead of resetting the lease', async () => {
  const harness = await waitingHarness();
  let reads = 0;
  harness.dependencies.reconnectHost = async () => {
    reads++;
    throw new Error('Native host still unavailable.');
  };
  harness.disconnect();
  for (let attempt = 0; attempt < 6; attempt++) {
    await harness.runner.tick();
    assert.equal(reads, attempt + 1);
    assert.equal(harness.runner.hostDisconnected(), true);
    await harness.runner.tick();
    assert.equal(reads, attempt + 1, 'Immediate ticks do not bypass backoff.');
    harness.advance(Math.min(16000, 1000 * 2 ** attempt));
  }
  await harness.runner.tick();
  assert.equal(reads, 6);
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.runner.status.errorCode, 'HOST_RECONNECT_FAILED');
  assert.match(harness.runner.status.reason, /Setup.*Resume/);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
});

test('the host recovery deadline remains bounded', async (context) => {
  for (const [elapsed, expected] of [
    [60000, 'HOST_RECONNECT_FAILED'],
    [600000, 'HOST_RECONNECT_FAILED'],
  ]) {
    await context.test(String(elapsed), async () => {
      const harness = await waitingHarness();
      harness.disconnect();
      harness.advance(elapsed);
      await harness.runner.tick();
      assert.equal(harness.runner.status.errorCode, expected);
      assert.deepEqual(harness.reads, []);
      assert.equal(harness.commits.length, 1);
    });
  }
});

test('host reconnect does not reset the original active-time budget', async () => {
  const harness = await waitingHarness({ options: { maxMinutes: 1 } });
  harness.advance(59000);
  harness.disconnect();
  harness.advance(1000);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.runner.status.errorCode, 'TIME_LIMIT');
  assert.deepEqual(harness.reads, []);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
});

test('Pause during a held state read prevents late reconnection and any import', async () => {
  const harness = await waitingHarness();
  const pending = Promise.withResolvers();
  harness.dependencies.reconnectHost = async () => pending.promise;
  harness.disconnect();
  const tick = harness.runner.tick();
  await harness.runner.stop('Paused by you.');
  harness.offline(false);
  pending.resolve(harness.snapshot());
  await tick;
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.runner.status.reason, 'Paused by you.');
  assert.deepEqual(harness.reads, []);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
});

test('fresh paused, changed-run, changed-goal and changed-checkpoint evidence prevent automatic continuation', async (context) => {
  for (const change of ['paused', 'run', 'goal', 'checkpoint']) {
    await context.test(change, async () => {
      const harness = await waitingHarness();
      harness.disconnect();
      if (change === 'paused') {
        harness.worker.state = 'paused';
      } else if (change === 'run') {
        harness.worker.runId = 'replacement';
      } else if (change === 'goal') {
        harness.worker.goal = 'A different task';
      } else {
        harness.dependencies.loadProgress = async () => ({
          progress: { ...harness.progress(), revision: 999 },
          importedCount: 0,
        });
      }
      await harness.runner.tick();
      assert.equal(harness.runner.status.active, false);
      assert.ok(['RUN_SUPERSEDED', 'PROGRESS_BINDING'].includes(harness.runner.status.errorCode));
      assert.equal(harness.commits.length, 1);
      assert.equal(harness.imports.length, 0);
    });
  }
});

test('a superseded controller lease and malformed saved progress are not retried', async (context) => {
  for (const change of ['guard', 'progress']) {
    await context.test(change, async () => {
      const harness = await waitingHarness();
      harness.disconnect();
      if (change === 'guard') {
        harness.dependencies.checkAvailable = () => {
          throw new Error('Data reset superseded the runner.');
        };
      } else {
        harness.dependencies.loadProgress = async () => ({
          progress: { stage: 'waiting_reply' },
          importedCount: 0,
        });
      }
      await harness.runner.tick();
      assert.equal(harness.runner.status.active, false);
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.commits.length, 1);
    });
  }
});

test('a disconnect while any operation is in flight is not eligible for automatic host continuation', async () => {
  const harness = await waitingHarness();
  const pending = Promise.withResolvers();
  const page = harness.dependencies.page;
  harness.dependencies.page = async (tabId, request) => {
    if (request.op === 'inspect') {
      await pending.promise;
    }
    return page(tabId, request);
  };
  const tick = harness.runner.tick();
  assert.equal(harness.runner.hostDisconnected(), false);
  await harness.runner.stop('Host connection lost during an operation.');
  pending.resolve();
  await tick;
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
});

test('startup read failures may recover after 30 seconds, but never extend the original 60-second window', async () => {
  const harness = createHarness({ readError: true });
  await harness.runner.start();
  harness.advance(31000);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, true);
  assert.equal(harness.runner.status.phase, 'reconnecting');
  harness.configuration.readError = false;
  await harness.runner.tick();
  assert.equal(harness.commits.length, 1);
  await harness.runner.stop();

  const slow = createHarness({ view: { ready: false } });
  await slow.runner.start();
  slow.advance(55000);
  slow.dependencies.page = async () => {
    throw new PageBridgeError('BRIDGE_TIMEOUT', 'Page still loading.', true);
  };
  await slow.runner.tick();
  assert.equal(slow.runner.status.active, true);
  slow.advance(5001);
  await slow.runner.tick();
  assert.equal(slow.runner.status.active, false);
  assert.equal(slow.commits.length, 0);
});
