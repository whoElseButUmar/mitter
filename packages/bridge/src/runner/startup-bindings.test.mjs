import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

const { messageDigest } = await import('../message-wire.ts');
const { NativeRequestTimeout } = await import('../native-request.ts');

function batch(overrides = {}) {
  return {
    protocol: 'mitter/1',
    id: 'batch_1',
    workerId: 'worker_1',
    projectId: 'project_1',
    summary: 'Exact queued batch',
    actions: [
      { type: 'write', path: 'file.txt', content: '\ufeffExact bytes\r\n😀', expectedHash: 'missing' },
    ],
    ...overrides,
  };
}

async function queuedHarness(configuration = {}) {
  const progress = {
    version: 1,
    revision: 0,
    workerId: 'worker_1',
    projectId: 'project_1',
    goalHash: await messageDigest('Inspect safely.'),
    conversationUrl: 'https://chatgpt.com/c/task-1',
    turns: 3,
    maxTurns: 5,
    lowerBound: false,
    activeMs: 0,
    maxMinutes: 10,
    startedAt: 100000,
    updatedAt: 100000,
    stage: 'local_batch',
    lastImportedId: 'batch_1',
    repeats: 0,
    formatRepairs: 0,
    phase: 'stopped',
    reason: 'Paused by you.',
    ...configuration.progress,
  };
  return createHarness({
    ...configuration,
    progress,
    worker: {
      queue: [batch()],
      control: {
        version: 1,
        epoch: 7,
        mode: 'active',
        at: 100000,
        operationId: 'operation_1',
        reason: 'Started by you.',
        retiredExchanges: [],
      },
      ...configuration.worker,
    },
    options: {
      resumeExisting: true,
      expectedRun: { runId: 'run_1', epoch: 7 },
      expectedBatchId: 'batch_1',
      ...configuration.options,
    },
  });
}

function changeWorker(worker, change) {
  if (change === 'run') {
    worker.runId = 'replacement_run';
  } else if (change === 'epoch') {
    worker.control.epoch++;
  } else if (change === 'project') {
    worker.projectId = 'replacement_project';
  } else if (change === 'goal') {
    worker.goal = 'Replacement goal.';
  } else if (change === 'mode') {
    worker.mode = 'local';
  } else if (change === 'batch ID') {
    worker.queue[0].id = 'replacement_batch';
  } else if (change === 'batch contents') {
    worker.queue[0].actions[0].content = 'Replacement bytes\r\n';
  }
}

function holdStartup(harness, stage) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();

  if (stage === 'progress load') {
    const load = harness.dependencies.loadProgress;
    harness.dependencies.loadProgress = async () => {
      entered.resolve();
      await release.promise;
      return load();
    };
  } else if (stage === 'checkpoint save') {
    let held = false;
    harness.configuration.beforeSave = async () => {
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    };
  } else {
    const rpc = harness.dependencies.rpc;
    harness.dependencies.rpc = async (method, params) => {
      if (method === 'worker.prompt' && params.kind === stage) {
        entered.resolve();
        await release.promise;
      }

      return rpc(method, params);
    };
  }

  return { entered: entered.promise, release };
}

function assertNoExecution(harness) {
  for (const event of ['worker.resume', 'worker.run', 'worker.import', 'page:prepare', 'page:commit']) {
    assert.equal(harness.events.includes(event), false, event);
  }

  assert.deepEqual(harness.imports, []);
  assert.deepEqual(harness.commits, []);
}

for (const stage of ['progress load', 'checkpoint save', 'bootstrap', 'next']) {
  for (const change of ['run', 'epoch', 'project', 'goal', 'mode', 'batch ID', 'batch contents']) {
    test('runner pins ' + change + ' across the startup ' + stage + ' await', async () => {
      const harness = await queuedHarness();
      const gate = holdStartup(harness, stage);
      const starting = harness.runner.start();
      await gate.entered;
      const before = harness.events.length;
      changeWorker(harness.worker, change);
      const rejected = assert.rejects(starting, { code: 'RUN_SUPERSEDED' });
      gate.release.resolve();
      await rejected;
      assert.equal(harness.runner.status.active, false);
      assertNoExecution(harness);
      assert.equal(harness.events.slice(before).includes('worker.pause'), false);
      assert.equal(
        harness.events.slice(before).some((event) => event.startsWith('save:')),
        false,
      );
      await harness.runner.tick();
      assertNoExecution(harness);
      await harness.runner.settled();
    });
  }
}

test('construction captures full queued ownership rather than adopting a replacement at start', async () => {
  const harness = await queuedHarness();
  changeWorker(harness.worker, 'batch contents');
  await assert.rejects(harness.runner.start(), { code: 'RUN_SUPERSEDED' });
  assertNoExecution(harness);
  assert.equal(
    harness.events.some((event) => event.startsWith('save:')),
    false,
  );
});

for (const expectedRun of [
  { runId: 'replacement_run', epoch: 7 },
  { runId: 'run_1', epoch: 8 },
]) {
  test(
    'runner cannot substitute the current task for a conflicting reviewed boundary ' +
      JSON.stringify(expectedRun),
    async () => {
      const harness = await queuedHarness({ options: { expectedRun } });
      await assert.rejects(harness.runner.start(), { code: 'RUN_SUPERSEDED' });
      assertNoExecution(harness);
      assert.equal(
        harness.events.some((event) => event.startsWith('save:')),
        false,
      );
    },
  );
}

test('an explicit reviewed batch cannot be replaced by a different queued head before startup', async () => {
  const harness = await queuedHarness({ worker: { queue: [batch({ id: 'unreviewed_batch' })] } });
  await assert.rejects(harness.runner.start(), { code: 'RUN_SUPERSEDED' });
  assertNoExecution(harness);
  assert.equal(
    harness.events.some((event) => event.startsWith('save:')),
    false,
  );
});

test('availability is checked before a startup progress load can cross the dependency boundary', async () => {
  const harness = await queuedHarness();
  let loads = 0;
  const load = harness.dependencies.loadProgress;
  harness.dependencies.loadProgress = () => {
    loads++;
    return load();
  };
  harness.dependencies.checkAvailable = () => {
    throw new Error('Reset retired this startup.');
  };
  await assert.rejects(harness.runner.start(), /Reset retired/);
  assert.equal(loads, 0);
  assertNoExecution(harness);
});

test('native startup RPCs retain the exact captured run and nonzero execution epoch', async () => {
  const expectedRun = { runId: '  literal run\\id\r\n😀  ', epoch: 7 };
  const harness = await queuedHarness({ worker: { runId: expectedRun.runId }, options: { expectedRun } });
  const sent = [];
  const rpc = harness.dependencies.rpc;
  harness.dependencies.rpc = (method, params) => {
    sent.push({ method, params });
    assert.deepEqual(params.expectedRun, expectedRun);
    return rpc(method, params);
  };
  await harness.runner.start();
  const resume = sent.find((call) => call.method === 'worker.resume');
  assert.deepEqual(resume.params, { workerId: 'worker_1', epoch: 7, expectedRun });
  assert.equal(sent.filter((call) => call.method === 'worker.resume').length, 1);
  assert.equal(harness.runner.status.turns, 3);
  assert.equal(harness.runner.status.phase, 'running');
  assert.deepEqual(harness.imports, []);
  assert.deepEqual(harness.commits, []);
});

for (const progress of [
  { conversationUrl: 'https://chatgpt.com/c/unrelated' },
  { conversationUrl: undefined },
  { lastImportedId: 'unreviewed_batch' },
  { stage: 'waiting_reply' },
  { stage: 'commit_intent' },
]) {
  test('pending startup rejects changed checkpoint authority ' + JSON.stringify(progress), async () => {
    const harness = await queuedHarness({
      alreadyImported: true,
      progress: {
        approvedReply: {
          id: 'batch_1',
          hash: 'a'.repeat(64),
          url: 'https://chatgpt.com/c/task-1',
          at: 100000,
        },
        ...progress,
      },
    });
    let code = 'PROGRESS_BINDING';

    if (progress.conversationUrl === 'https://chatgpt.com/c/unrelated') {
      code = 'NAVIGATED';
    }

    await assert.rejects(harness.runner.start(), { code });
    assert.equal(harness.events.includes('worker.handoffSeen'), false);
    assert.equal(
      harness.events.some((event) => event.startsWith('save:')),
      false,
    );
    assertNoExecution(harness);
  });
}

test('checkpoint URL comparison normalizes identity without changing exact imported source or counters', async () => {
  const harness = await queuedHarness({
    options: { url: 'https://chatgpt.com/c/task-1/?source=selection#reply' },
  });
  const originalBatch = structuredClone(harness.worker.queue[0]);
  await harness.runner.start();
  assert.equal(harness.runner.status.url, 'https://chatgpt.com/c/task-1');
  assert.equal(harness.progress().conversationUrl, 'https://chatgpt.com/c/task-1');
  assert.equal(harness.runner.status.turns, 3);
  assert.deepEqual(harness.worker.queue[0], originalBatch);
  assert.equal(harness.events.filter((event) => event === 'worker.resume').length, 1);
  assert.deepEqual(harness.commits, []);
});

test('a queued head consumed after resume dispatch is allowed while the acknowledgement awaits', async () => {
  const harness = await queuedHarness();
  const entered = Promise.withResolvers();
  const acknowledgement = Promise.withResolvers();
  const rpc = harness.dependencies.rpc;
  harness.dependencies.rpc = async (method, params) => {
    const result = await rpc(method, params);

    if (method === 'worker.resume') {
      harness.worker.queue = [];
      entered.resolve();
      await acknowledgement.promise;
    }

    return result;
  };
  const starting = harness.runner.start();
  await entered.promise;
  acknowledgement.resolve();
  await starting;
  assert.equal(harness.runner.status.active, true);
  assert.equal(harness.runner.status.phase, 'running');
  assert.equal(harness.events.filter((event) => event === 'worker.resume').length, 1);
  assert.equal(harness.events.includes('worker.pause'), false);
  assert.deepEqual(harness.imports, []);
  assert.deepEqual(harness.commits, []);
});

test('a late resume acknowledgement cannot checkpoint or pause a replacement run', async () => {
  const harness = await queuedHarness();
  const entered = Promise.withResolvers();
  const acknowledgement = Promise.withResolvers();
  const rpc = harness.dependencies.rpc;
  harness.dependencies.rpc = async (method, params) => {
    const result = await rpc(method, params);

    if (method === 'worker.resume') {
      entered.resolve();
      await acknowledgement.promise;
    }

    return result;
  };
  const starting = harness.runner.start();
  await entered.promise;
  const before = harness.events.length;
  harness.worker.runId = 'replacement_run';
  const rejected = assert.rejects(starting, { code: 'RUN_SUPERSEDED' });
  acknowledgement.resolve();
  await rejected;
  assert.equal(harness.events.slice(before).includes('worker.pause'), false);
  assert.equal(
    harness.events.slice(before).some((event) => event.startsWith('save:')),
    false,
  );
  assert.equal(harness.events.filter((event) => event === 'worker.resume').length, 1);
  assert.equal(harness.runner.status.active, false);
});

for (const receipt of [null, {}, { started: false }, { started: 'true' }, 'lost acknowledgement']) {
  test('runner startup native resume ' + JSON.stringify(receipt) + ' cannot authorize replay', async () => {
    const harness = await queuedHarness();
    const timeout = new NativeRequestTimeout('worker.resume');
    const rpc = harness.dependencies.rpc;
    harness.dependencies.rpc = async (method, params) => {
      if (method === 'worker.resume') {
        harness.events.push(method);

        if (receipt === 'lost acknowledgement') {
          throw timeout;
        }

        return receipt;
      }

      return rpc(method, params);
    };
    await assert.rejects(harness.runner.start(), (error) => {
      if (receipt === 'lost acknowledgement') {
        assert.equal(error, timeout);
      } else {
        assert.equal(error.code, 'RPC_RESULT_INVALID');
        assert.equal(error.method, 'worker.resume');
        assert.equal(error.retryable, false);
      }

      return true;
    });
    const before = harness.events.length;
    harness.advance(180000);
    await harness.runner.tick();
    assert.equal(harness.events.length, before);
    assert.equal(harness.events.filter((event) => event === 'worker.resume').length, 1);
    assert.equal(harness.events.includes('worker.run'), false);
    assert.deepEqual(harness.imports, []);
    assert.deepEqual(harness.commits, []);
  });
}
