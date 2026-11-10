import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { digest, fixture, makeWorker, importBatch, registerScript, runToBoundary } from './test-fixture.mjs';

const { commandJournalSchema, retiredQueueSchema } = await import('./schemas.ts');
const { parseFollowup } = await import('../../../../../packages/protocol/src/requests.ts');
const { TaskRuntime } = await import('./task-runtime.ts');

async function waitForFile(filename) {
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    try {
      await fs.access(filename);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('The test command did not reach its execution boundary.');
}

test(
  'stop archives the settled cursor, keeps committed edits, and does not abort a peer waiting on its lock',
  { timeout: 10000 },
  async (context) => {
    const { service, worker, store, project, root } = await fixture(context, {
      workers: [makeWorker(), makeWorker({ id: 'worker_2', runId: 'run_2' })],
    });
    const peer = service.workers.get('worker_2');
    assert.ok(peer);
    const profile = await registerScript(
      service,
      project,
      root,
      "require('node:fs').writeFileSync('command-entered.txt', 'ready'); setTimeout(() => {}, 4000);",
    );
    const envelope = await importBatch(service, worker, [
      {
        type: 'write',
        path: 'kept.txt',
        content: 'committed',
        expectedHash: 'missing',
      },
      { type: 'command', profileId: profile.id },
      {
        type: 'write',
        path: 'retired.txt',
        content: 'must not run',
        expectedHash: 'missing',
      },
    ]);
    await importBatch(service, peer, [
      {
        type: 'write',
        path: 'peer.txt',
        content: 'peer finished',
        expectedHash: 'missing',
      },
      { type: 'finish', summary: 'Peer finished safely.' },
    ]);
    await runToBoundary(service, worker);
    const approval = worker.pending;
    assert.ok(approval);
    await service.handle('worker.approve', {
      workerId: worker.id,
      token: approval.token,
      approve: true,
    });
    await waitForFile(path.join(root, 'command-entered.txt'));

    const waiting = Promise.withResolvers();
    const unsubscribe = service.subscribe(() => {
      if (peer.state === 'waiting_lock') {
        waiting.resolve();
      }
    });
    service.run(peer.id);
    await waiting.promise;
    unsubscribe();
    assert.equal(worker.cursor, 1);
    const result = await service.handle('worker.stop', {
      workerId: worker.id,
      id: 'stop_1',
    });
    await service.wait(peer.id);
    assert.equal(result.stopped, true);
    assert.equal(worker.state, 'paused');
    assert.equal(peer.state, 'complete');
    assert.equal(await fs.readFile(path.join(root, 'kept.txt'), 'utf8'), 'committed');
    assert.equal(await fs.readFile(path.join(root, 'peer.txt'), 'utf8'), 'peer finished');
    await assert.rejects(fs.readFile(path.join(root, 'retired.txt')), {
      code: 'ENOENT',
    });
    const retired = retiredQueueSchema.parse(store.get('miter.retiredQueue.stop_1'));
    assert.equal(retired.cursor, 1);
    assert.equal(retired.queue[0].id, envelope.id);
    assert.equal(retired.queue[0].actions.length, 3);
    const command = commandJournalSchema.parse(store.get(`command:${envelope.id}_1`));
    assert.equal(command.status, 'interrupted');
    assert.equal(command.result.aborted, true);
    assert.equal(store.writes(worker.runId).filter((value) => value.status === 'applied').length, 1);
  },
);

test('local planning registers synchronously and stops after three identical proposals', async (context) => {
  let proposals = 0;
  const models = {
    propose: async () => {
      proposals++;
      return JSON.stringify({
        summary: 'Inspect files.',
        actions: [{ type: 'list', path: '.' }],
      });
    },
    close: () => {},
  };
  const { service, worker } = await fixture(context, {
    workers: [makeWorker({ mode: 'local' })],
    models,
  });
  service.settings.coderModelPath = '/configured/model.gguf';
  service.run(worker.id);
  assert.throws(() => service.run(worker.id), /current operation/);
  await service.wait(worker.id);
  assert.equal(worker.state, 'blocked');
  assert.match(worker.error, /same proposal three times/);
  assert.equal(worker.repeatCount, 2);
  assert.equal(worker.iteration, 3);
  assert.equal(proposals, 3);
});

test('invalid steering selection cannot retire a valid queued plan or change its epoch', async (context) => {
  const { service, worker, root, store } = await fixture(context);
  await fs.writeFile(path.join(root, 'file.txt'), 'current');
  const envelope = await importBatch(service, worker, [{ type: 'list', path: '.' }]);
  const request = {
    id: 'steer_1',
    instruction: 'Modify this selection.',
    autoStart: false,
    selection: {
      path: 'file.txt',
      hash: 'a'.repeat(64),
      start: 0,
      end: 3,
      text: 'old',
    },
  };
  await assert.rejects(
    service.handle('worker.steer', { workerId: worker.id, request }),
    /selected code changed/,
  );
  assert.equal(worker.control, undefined);
  assert.equal(worker.queue[0].id, envelope.id);
  assert.equal(worker.state, 'queued');
  assert.equal(store.get('miter.controlArchive.steer_1'), undefined);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
});

test('local repeat bookkeeping precedes summary validation on rejected replies', async (context) => {
  const models = {
    propose: async () => JSON.stringify({ summary: '', actions: [{ type: 'list', path: '.' }] }),
    close: () => {},
  };
  const { service, worker, store } = await fixture(context, {
    workers: [makeWorker({ mode: 'local' })],
    models,
  });
  service.settings.coderModelPath = '/configured/model.gguf';

  for (let attempt = 0; attempt < 3; attempt++) {
    await runToBoundary(service, worker);
  }

  assert.equal(worker.repeatCount, 2);
  assert.equal(worker.iteration, 3);
  assert.equal(worker.state, 'blocked');
  assert.match(worker.error, /same proposal three times/);
  assert.equal(store.envelopeCount(worker.id), 0);
});

test('wait resolves after durable error cleanup and a failed task can run again', async (context) => {
  let attempts = 0;
  const models = {
    propose: async () => {
      attempts++;

      if (attempts === 1) {
        throw new Error('Model failed at its boundary.');
      }

      return JSON.stringify({
        summary: 'Finish after retry.',
        actions: [{ type: 'finish', summary: 'Retried safely.' }],
      });
    },
    close: () => {},
  };
  const { service, worker, store } = await fixture(context, {
    workers: [makeWorker({ mode: 'local' })],
    models,
  });
  service.settings.coderModelPath = '/configured/model.gguf';
  await runToBoundary(service, worker);
  const failed = store.workers().find((saved) => saved.id === worker.id);
  assert.ok(failed);
  assert.equal(failed.state, 'blocked');
  assert.equal(failed.error, 'Model failed at its boundary.');
  assert.equal(failed.iteration, 1);
  assert.equal(store.events().filter((event) => event.kind === 'error').length, 1);

  await runToBoundary(service, worker);
  const completed = store.workers().find((saved) => saved.id === worker.id);
  assert.ok(completed);
  assert.equal(completed.state, 'complete');
  assert.equal(completed.error, undefined);
  assert.equal(completed.iteration, 2);
  assert.equal(attempts, 2);
});

test('immediate shutdown settles admitted tasks as paused before stopping their workflows', async (context) => {
  for (const mode of ['local', 'handoff']) {
    await context.test(mode, async (context) => {
      let proposals = 0;
      const models = {
        propose: async () => {
          proposals++;
          throw new Error('Shutdown must prevent model execution.');
        },
        close: () => {},
      };
      const { service, worker, store, stoppedActors } = await fixture(context, {
        workers: [makeWorker({ mode })],
        models,
      });
      service.settings.coderModelPath = '/configured/model.gguf';

      if (mode === 'handoff') {
        await importBatch(service, worker, [{ type: 'list', path: '.' }]);
      }

      service.run(worker.id);
      await service.quiesce();

      assert.equal(worker.state, 'paused');
      assert.equal(store.workers()[0].state, 'paused');
      assert.deepEqual(stoppedActors, ['paused']);
      assert.equal(worker.error, undefined);
      assert.equal(proposals, 0);
      assert.deepEqual(store.writes(worker.runId), []);
    });
  }
});

test('aborted fulfillment preserves settled states and pauses unfinished work', async (context) => {
  for (const state of ['planning', 'paused', 'cancelled', 'complete']) {
    await context.test(state, async () => {
      const worker = makeWorker({ state: 'planning' });
      const saved = [];
      const task = new TaskRuntime(
        worker,
        { saveWorker: (worker) => saved.push(worker.state), event: () => {} },
        (_initial, changed) => ({ get: () => worker.state, move: changed, stop: () => {} }),
        () => {},
      );

      task.start(async () => {
        task.move(state);
        task.abort(new Error('Stopping the admitted run.'));
      });
      await task.wait();

      let expected = state;

      if (state === 'planning') {
        expected = 'paused';
      }

      assert.equal(worker.state, expected);
      assert.equal(saved.at(-1), expected);
      assert.equal(task.running, false);
    });
  }
});

test('shutdown aborts all tasks before model close; workflows stop after settlement', async (context) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const order = [];
  let environment;
  const models = {
    propose: async (_prompt, signal) => {
      signal.addEventListener('abort', () => order.push('abort'), { once: true });
      entered.resolve();
      await release.promise;

      return JSON.stringify({ summary: 'Retired.', actions: [{ type: 'list', path: '.' }] });
    },
    close: () => {
      order.push('close');
      release.resolve();
    },
    settled: async () => {
      assert.ok(environment);
      assert.deepEqual(
        environment.store.workers().map((saved) => saved.state),
        ['paused', 'paused'],
      );
      assert.deepEqual(environment.stoppedActors, ['paused', 'paused']);
      order.push('settled');
    },
  };
  environment = await fixture(context, {
    workers: [makeWorker({ mode: 'local' }), makeWorker({ id: 'worker_2', runId: 'run_2', mode: 'local' })],
    models,
  });
  const { service, worker, store } = environment;
  const peer = service.workers.get('worker_2');
  assert.ok(peer);
  service.settings.coderModelPath = '/configured/model.gguf';
  service.run(worker.id);
  await entered.promise;
  const peerWaiting = Promise.withResolvers();
  const unsubscribe = service.subscribe(() => {
    if (peer.state === 'waiting_model') {
      peerWaiting.resolve();
    }
  });
  service.run(peer.id);
  await peerWaiting.promise;
  unsubscribe();

  const originalSave = store.saveWorker.bind(store);
  store.saveWorker = (saved) => {
    originalSave(saved);

    if (saved.state === 'paused') {
      order.push('saved:' + saved.id);
    }
  };
  await service.quiesce();
  assert.deepEqual(order.slice(0, 2), ['abort', 'close']);
  assert.equal(order.at(-1), 'settled');
  assert.ok(order.includes('saved:' + worker.id));
  assert.ok(order.includes('saved:' + peer.id));
  assert.equal(store.envelopeCount(worker.id), 0);
  assert.equal(store.envelopeCount(peer.id), 0);
  await assert.rejects(service.handle('state', {}), /shutting down/);
});

test('queued steering accepts reordered selections and rejects changed work', async (context) => {
  const { service, worker, store, root } = await fixture(context, {
    workers: [makeWorker(), makeWorker({ id: 'worker_2', runId: 'run_2' })],
  });
  const source = 'same same';
  await fs.writeFile(path.join(root, 'file.txt'), source);
  await fs.writeFile(path.join(root, 'other.txt'), source);
  const envelope = await importBatch(service, worker, [{ type: 'list', path: '.' }]);
  const request = {
    id: 'steer_selection_1',
    instruction: 'Modify this exact selection.',
    autoStart: false,
    selection: {
      path: 'file.txt',
      hash: digest(source),
      start: 0,
      end: 4,
      text: 'same',
    },
  };
  await service.handle('worker.followup', { workerId: worker.id, request });
  const reorderedRequest = {
    ...request,
    selection: {
      text: 'same',
      end: 4,
      start: 0,
      hash: digest(source),
      path: 'file.txt',
    },
  };
  const previous = service.followups.get(request.id);
  assert.ok(previous);
  const parsedRequest = parseFollowup(reorderedRequest);
  assert.notDeepEqual(Object.keys(request.selection), Object.keys(reorderedRequest.selection));
  assert.notEqual(JSON.stringify(previous.selection), JSON.stringify(parsedRequest.selection));
  assert.deepEqual(previous.selection, parsedRequest.selection);
  assert.deepEqual(
    await service.handle('worker.steerValidate', {
      workerId: worker.id,
      request: reorderedRequest,
    }),
    { valid: true, alreadyApplied: false },
  );

  const changedSelections = [
    { ...request.selection, path: 'other.txt' },
    { ...request.selection, hash: digest('different source') },
    { ...request.selection, start: 1, end: 5, text: 'ame ' },
    { ...request.selection, end: 5, text: 'same ' },
    { ...request.selection, text: 'else' },
    undefined,
  ];

  for (const selection of changedSelections) {
    const changedRequest = { ...reorderedRequest, selection };

    for (const method of ['worker.steerValidate', 'worker.steer']) {
      await assert.rejects(
        service.handle(method, {
          workerId: worker.id,
          request: changedRequest,
        }),
        /steering request ID was already used/,
      );
    }
  }

  for (const params of [
    { workerId: 'worker_2', request: reorderedRequest },
    {
      workerId: worker.id,
      request: { ...reorderedRequest, instruction: 'Different work.' },
    },
  ]) {
    await assert.rejects(
      service.handle('worker.steerValidate', params),
      /steering request ID was already used/,
    );
  }

  service.followups.save({ ...previous, status: 'active' });
  await assert.rejects(
    service.handle('worker.steerValidate', {
      workerId: worker.id,
      request: reorderedRequest,
    }),
    /steering request ID was already used/,
  );
  service.followups.save(previous);
  assert.equal(worker.control, undefined);
  assert.equal(worker.queue[0].id, envelope.id);
  assert.equal(store.get('miter.controlArchive.' + request.id), undefined);
  assert.equal(service.followups.list(worker.id).length, 1);

  const result = await service.handle('worker.steer', {
    workerId: worker.id,
    request: reorderedRequest,
  });
  assert.equal(result.ready, true);
  assert.equal(result.epoch, 1);
  assert.equal(worker.activeFollowupId, request.id);
  assert.equal(service.followups.get(request.id).status, 'active');
  assert.equal(service.followups.list(worker.id).length, 1);
  assert.equal(worker.runId, 'run_1');
});
