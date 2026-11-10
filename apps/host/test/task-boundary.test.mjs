import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { parseRequest } from '../../../packages/protocol/src/index.js';
import {
  digest,
  envelopeHash,
  fixture,
  importBatch,
  makeEnvelope,
  makeWorker,
  registerScript,
  runToBoundary,
} from '../src/core/service/test-fixture.mjs';
import { deliveryKey } from '../src/core/handoff-delivery.js';
import { deferred } from './fixtures.mjs';

function currentBoundary(worker) {
  return { runId: worker.runId, epoch: worker.control?.epoch ?? 0 };
}

function captureTask({ worker, store }) {
  return {
    worker: structuredClone(worker),
    savedWorkers: store.workers(),
    projects: store.projects(),
    events: store.events(),
    values: store.db.prepare('SELECT key,value FROM kv ORDER BY key').all(),
    envelopes: store.db.prepare('SELECT * FROM envelopes ORDER BY id').all(),
    journal: store.db.prepare('SELECT * FROM journal ORDER BY id').all(),
    followups: store.db.prepare('SELECT * FROM task_followups ORDER BY id').all(),
  };
}

async function rejectedWithoutMutation(owned, method, params, message) {
  const before = captureTask(owned);
  await assert.rejects(owned.service.handle(method, { workerId: owned.worker.id, ...params }), message);
  assert.deepEqual(captureTask(owned), before);
}

for (const method of ['worker.import', 'worker.run', 'worker.resume', 'worker.approve']) {
  test(method + ' rejects a different reviewed run even when the epoch still matches', async (t) => {
    const owned = await fixture(t);
    const { service, worker, project, root } = owned;
    await importBatch(service, worker, [{ type: 'finish', summary: 'The reviewed run finished.' }]);
    await runToBoundary(service, worker);
    assert.equal(worker.state, 'complete');
    const expectedRun = currentBoundary(worker);
    let params = {};

    if (method === 'worker.approve') {
      const profile = await registerScript(service, project, root, 'process.exit(0);');
      await importBatch(service, worker, [{ type: 'command', profileId: profile.id }]);
      await runToBoundary(service, worker);
      assert.ok(worker.pending);
      params = { token: worker.pending.token, approve: true, trustRun: true };
    } else {
      await importBatch(service, worker, [{ type: 'list', path: '.' }]);

      if (method === 'worker.import') {
        params.text = JSON.stringify(makeEnvelope(worker, [{ type: 'list', path: '.' }]));
      }
    }
    assert.notEqual(worker.runId, expectedRun.runId);
    assert.equal(currentBoundary(worker).epoch, expectedRun.epoch);

    await rejectedWithoutMutation(
      owned,
      method,
      {
        ...params,
        epoch: currentBoundary(worker).epoch,
        expectedRun,
      },
      /review belongs to an earlier task run/,
    );
  });
}

for (const method of ['worker.run', 'worker.resume']) {
  test(
    method + ' rejects review intent after control advances despite a refreshed forwarding epoch',
    async (t) => {
      const owned = await fixture(t, { workers: [makeWorker({ mode: 'local' })] });
      const { service, worker } = owned;
      const expectedRun = currentBoundary(worker);
      const stopped = await service.handle('worker.stop', { workerId: worker.id, id: 'advance_control' });
      await service.handle('worker.continueFresh', { workerId: worker.id });
      assert.equal(worker.runId, expectedRun.runId);
      assert.ok(stopped.epoch > expectedRun.epoch);

      await rejectedWithoutMutation(
        owned,
        method,
        {
          epoch: stopped.epoch,
          expectedRun,
        },
        /review belongs to an earlier task run/,
      );
    },
  );
}

for (const expectedRun of [
  null,
  [],
  {},
  { runId: 7, epoch: 0 },
  { runId: 'run_1' },
  { runId: 'run_1', epoch: -1 },
  { runId: 'run_1', epoch: 0.5 },
  { runId: 'run_1', epoch: '0' },
  { runId: 'run_1', epoch: 0, extraAuthority: true },
]) {
  test('malformed expectedRun cannot import reviewed actions: ' + JSON.stringify(expectedRun), async (t) => {
    const owned = await fixture(t);
    const envelope = makeEnvelope(owned.worker, [{ type: 'list', path: '.' }]);

    await rejectedWithoutMutation(
      owned,
      'worker.import',
      {
        text: JSON.stringify(envelope),
        expectedRun,
      },
      /reviewed task boundary is invalid/,
    );
  });
}

for (const method of [
  'worker.stop',
  'worker.steer',
  'worker.continueFresh',
  'worker.pause',
  'worker.cancel',
  'worker.skip',
  'worker.rollback',
  'worker.restoreFile',
  'worker.accept',
  'worker.followup',
  'worker.followupCancel',
  'worker.followupActivate',
  'worker.bridgeExtend',
]) {
  test(method + ' checks a provided reviewed boundary before any run mutation', async (t) => {
    const owned = await fixture(t);
    await importBatch(owned.service, owned.worker, [{ type: 'list', path: '.' }]);

    await rejectedWithoutMutation(
      owned,
      method,
      {
        confirm: true,
        id: 'reviewed_operation',
        expectedRun: { runId: 'previous_reviewed_run', epoch: 0 },
      },
      /review belongs to an earlier task run/,
    );
  });
}

test('malformed reviewed boundaries retain schema diagnostics without exposing raw validation JSON', async (t) => {
  const owned = await fixture(t);
  const envelope = makeEnvelope(owned.worker, [{ type: 'list', path: '.' }]);
  const before = captureTask(owned);

  await assert.rejects(
    owned.service.handle('worker.import', {
      workerId: owned.worker.id,
      text: JSON.stringify(envelope),
      expectedRun: { runId: owned.worker.runId, epoch: '0' },
    }),
    (error) => {
      assert.match(error.message, /reviewed task boundary is invalid/);
      assert.ok(error.cause instanceof ZodError);
      assert.ok(!error.message.includes('invalid_type'));
      return true;
    },
  );
  assert.deepEqual(captureTask(owned), before);
});

test('native request parsing retains a matching boundary for ordinary import and run', async (t) => {
  const { service, worker } = await fixture(t);
  const expectedRun = currentBoundary(worker);
  const envelope = makeEnvelope(worker, [{ type: 'finish', summary: 'Explicitly reviewed work.' }]);
  const imported = await service.dispatch(
    parseRequest({
      id: 'reviewed_import',
      method: 'worker.import',
      params: { workerId: worker.id, expectedRun, text: JSON.stringify(envelope) },
    }),
  );
  assert.equal(imported.ok, true);
  const started = await service.dispatch(
    parseRequest({
      id: 'reviewed_run',
      method: 'worker.run',
      params: { workerId: worker.id, expectedRun },
    }),
  );
  assert.equal(started.ok, true);
  await service.wait(worker.id);
  assert.equal(worker.state, 'complete');
});

test('matching reviewed boundaries preserve the existing token and forwarding epoch gates', async (t) => {
  const owned = await fixture(t);
  const { service, worker, project, root, store } = owned;
  const profile = await registerScript(service, project, root, 'process.exit(0);');
  await importBatch(service, worker, [{ type: 'command', profileId: profile.id }]);
  await runToBoundary(service, worker);
  assert.ok(worker.pending);
  worker.control = {
    version: 1,
    epoch: 2,
    mode: 'active',
    at: Date.now(),
    operationId: 'current_control',
    reason: 'Current control authority',
    retiredExchanges: [],
  };
  store.saveWorker(worker);
  const expectedRun = currentBoundary(worker);

  await rejectedWithoutMutation(
    owned,
    'worker.approve',
    {
      expectedRun,
      epoch: 0,
      token: worker.pending.token,
      approve: true,
    },
    /operation belongs to an earlier run/,
  );
  await rejectedWithoutMutation(
    owned,
    'worker.approve',
    {
      expectedRun,
      epoch: expectedRun.epoch,
      token: 'different_token',
      approve: true,
    },
    /Approval expired/,
  );
});

test('exact delivery start uses saved post-import authority instead of an obsolete reviewed run ID', async (t) => {
  const owned = await fixture(t);
  const { service, worker, store } = owned;
  await importBatch(service, worker, [{ type: 'finish', summary: 'Original run finished.' }]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'complete');
  const expectedRun = currentBoundary(worker);
  const envelope = makeEnvelope(worker, [{ type: 'finish', summary: 'New explicitly reviewed run.' }]);

  await service.handle('worker.import', {
    workerId: worker.id,
    text: JSON.stringify(envelope),
    expectedRun,
  });
  assert.notEqual(worker.runId, expectedRun.runId);
  assert.equal(store.get(deliveryKey(envelope.id)).runId, worker.runId);
  const start = {
    expectedRun,
    envelopeId: envelope.id,
    envelopeHash: envelopeHash(envelope),
  };

  await rejectedWithoutMutation(
    owned,
    'worker.run',
    {
      ...start,
      expectedRun: { runId: expectedRun.runId, epoch: -1 },
    },
    /reviewed task boundary is invalid/,
  );
  await rejectedWithoutMutation(
    owned,
    'worker.run',
    {
      ...start,
      envelopeHash: '0'.repeat(64),
    },
    /exact batch/,
  );
  await rejectedWithoutMutation(
    owned,
    'worker.run',
    {
      ...start,
      envelopeId: 'never_imported',
    },
    /exact batch/,
  );

  await service.handle('worker.run', { workerId: worker.id, ...start });
  await service.wait(worker.id);
  const beforeRetry = captureTask(owned);
  const acknowledged = await service.handle('worker.run', { workerId: worker.id, ...start });
  assert.equal(acknowledged.acknowledged, true);
  assert.deepEqual(captureTask(owned), beforeRetry);

  await importBatch(service, worker, [{ type: 'finish', summary: 'A different run owns the task now.' }]);
  assert.notEqual(store.get(deliveryKey(envelope.id)).runId, worker.runId);
  await rejectedWithoutMutation(owned, 'worker.run', start, /exact batch/);
});

for (const method of ['worker.rollback', 'worker.restoreFile']) {
  test(
    method + ' rechecks its boundary after waiting for the project lock',
    { timeout: 10000 },
    async (t) => {
      const owned = await fixture(t);
      const { service, worker, project, root } = owned;
      const file = path.join(root, 'source.txt');
      await fs.writeFile(file, 'original source');
      await importBatch(service, worker, [
        {
          type: 'write',
          path: 'source.txt',
          content: 'reviewed replacement',
          expectedHash: digest('original source'),
        },
        { type: 'finish', summary: 'Completed before review.' },
      ]);
      await runToBoundary(service, worker);
      const expectedRun = currentBoundary(worker);
      const entered = deferred();
      const release = deferred();
      const lock = service.locks.using(project.root, new AbortController().signal, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;

      try {
        const rollback = service.handle(method, {
          workerId: worker.id,
          confirm: true,
          expectedRun,
          path: 'source.txt',
          expectedHash: digest('reviewed replacement'),
        });
        const rejected = assert.rejects(rollback, /review belongs to an earlier task run/);
        await service.handle('worker.stop', { workerId: worker.id, id: 'stop_during_reviewed_lock' });
        const afterStop = captureTask(owned);
        release.resolve();
        await lock;
        await rejected;
        assert.deepEqual(captureTask(owned), afterStop);
        assert.equal(await fs.readFile(file, 'utf8'), 'reviewed replacement');
      } finally {
        release.resolve();
        await lock;
      }
    },
  );
}

for (const method of ['worker.followup', 'worker.followupActivate']) {
  test(
    method + ' cannot publish a reviewed selection after its native boundary advances',
    { timeout: 10000 },
    async (t) => {
      const owned = await fixture(t);
      const { service, worker, root } = owned;
      const file = path.join(root, 'source.js');
      const source = 'const value = 1;\n';
      await fs.writeFile(file, source);
      const request = {
        id: 'reviewed_selection',
        instruction: 'Review the selected value.',
        selection: { path: 'source.js', hash: digest(source), start: 6, end: 11, text: 'value' },
      };

      if (method === 'worker.followupActivate') {
        await service.handle('worker.followup', { workerId: worker.id, request });
      }
      const expectedRun = currentBoundary(worker);
      const entered = deferred();
      const release = deferred();
      const openFile = fs.open.bind(fs);
      t.mock.method(fs, 'open', async (...arguments_) => {
        const handle = await openFile(...arguments_);

        if (arguments_[0] === file) {
          entered.resolve();
          await release.promise;
        }
        return handle;
      });
      const pending = service.handle(method, { workerId: worker.id, expectedRun, request });
      const rejected = assert.rejects(pending, /review belongs to an earlier task run/);

      try {
        await entered.promise;
        await service.handle('worker.stop', { workerId: worker.id, id: 'stop_while_selection_reads' });

        if (method === 'worker.followupActivate') {
          await fs.writeFile(file, 'const externallyChanged = 2;\n');
        }
        const afterStop = captureTask(owned);
        release.resolve();
        await rejected;
        assert.deepEqual(captureTask(owned), afterStop);
      } finally {
        release.resolve();
        await pending.catch(() => {});
      }
    },
  );
}

test('an exact delivery cannot cross a native control advance even with a refreshed forwarding epoch', async (t) => {
  const owned = await fixture(t);
  const { service, worker } = owned;
  const expectedRun = currentBoundary(worker);
  const envelope = await importBatch(service, worker, [{ type: 'list', path: '.' }]);
  const stopped = await service.handle('worker.stop', { workerId: worker.id, id: 'stop_delivery' });
  await service.handle('worker.continueFresh', { workerId: worker.id });

  await rejectedWithoutMutation(
    owned,
    'worker.run',
    {
      expectedRun,
      epoch: stopped.epoch,
      envelopeId: envelope.id,
      envelopeHash: envelopeHash(envelope),
    },
    /review belongs to an earlier task run/,
  );
});
