import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import { parseAction } from '../../../packages/protocol/src/index.js';
import { progressKey, taskProgressSchema } from '../../../packages/bridge/src/progress.js';
import { advanceCounter } from '../src/core/service/counters.js';
import { parseProgressUpdate } from '../src/core/service/progress.js';
import { digest, fixture, importBatch, makeProgress, makeWorker } from '../src/core/service/test-fixture.mjs';

function capture(owned) {
  return {
    workers: structuredClone([...owned.service.workers.values()]),
    projects: structuredClone([...owned.service.projects.values()]),
    savedWorkers: owned.store.workers(),
    savedProjects: owned.store.projects(),
    values: owned.store.db.prepare('SELECT key,value FROM kv ORDER BY key').all(),
    events: owned.store.events(),
    envelopes: owned.store.db.prepare('SELECT * FROM envelopes ORDER BY id').all(),
    journal: owned.store.db.prepare('SELECT * FROM journal ORDER BY id').all(),
    followups: owned.store.db.prepare('SELECT * FROM task_followups ORDER BY id').all(),
    messages: owned.store.db.prepare('SELECT * FROM team_messages ORDER BY id').all(),
  };
}

async function unchangedRejection(owned, method, params, expected) {
  const before = capture(owned);
  await assert.rejects(owned.service.handle(method, params), expected);
  assert.deepEqual(capture(owned), before);
}

function counterError(error) {
  assert.match(error.message, /supported limit.*Nothing was changed/);
  assert.ok(error.cause instanceof ZodError);
  return true;
}

test('counter successors retain the final exact integer but never clamp or reuse exhausted authority', () => {
  assert.equal(advanceCounter(0, 'Counter'), 1);
  assert.equal(advanceCounter(Number.MAX_SAFE_INTEGER - 1, 'Counter'), Number.MAX_SAFE_INTEGER);
  assert.equal(advanceCounter(Number.MAX_SAFE_INTEGER - 2, 'Counter', 2), Number.MAX_SAFE_INTEGER);
  assert.equal(advanceCounter(Number.MAX_SAFE_INTEGER - 8, 'Counter', 8), Number.MAX_SAFE_INTEGER);

  for (const [value, increment] of [
    [Number.MAX_SAFE_INTEGER, 1],
    [Number.MAX_SAFE_INTEGER - 1, 2],
    [Number.MAX_SAFE_INTEGER - 7, 8],
    [-1, 1],
    [0.5, 1],
  ]) {
    assert.throws(() => advanceCounter(value, 'Counter', increment), counterError);
  }
});

test('progress updates use the canonical receipt-binding validator and preserve its diagnostic cause', async (t) => {
  const owned = await fixture(t);
  const progress = makeProgress(owned.worker, {
    lastReceipt: {
      workerId: 'another_worker',
      projectId: owned.project.id,
      goalHash: digest(owned.worker.goal),
      textHash: 'a'.repeat(64),
      renderedHash: 'a'.repeat(64),
      at: 1,
    },
  });

  assert.throws(
    () => parseProgressUpdate(progress),
    (error) => {
      assert.match(error.message, /invalid bindings.*Nothing was saved/);
      assert.ok(error.cause instanceof ZodError);
      assert.deepEqual(error.cause.issues[0].path, ['lastReceipt']);
      return true;
    },
  );
});

test('progress saves redact before bounding display text and return the persisted valid revision', async (t) => {
  const owned = await fixture(t);
  const progress = makeProgress(owned.worker, { reason: 'x'.repeat(492) + ' token=a' });
  const saved = await owned.service.handle('worker.bridgeSave', { workerId: owned.worker.id, progress });
  assert.equal(saved.reason.length, 500);
  assert.ok(saved.reason.startsWith('x'.repeat(492) + ' token=['));
  assert.equal(saved.reason.includes('token=a'), false);
  assert.equal(saved.revision, 1);
  taskProgressSchema.parse(saved);
  assert.deepEqual(owned.store.get(progressKey(owned.worker.id)), saved);
  assert.deepEqual(
    (await owned.service.handle('worker.bridgeLoad', { workerId: owned.worker.id })).progress,
    saved,
  );
});

test('save permits the final safe revision and rejects its successor before any persistence', async (t) => {
  const owned = await fixture(t);
  const progress = makeProgress(owned.worker, { revision: Number.MAX_SAFE_INTEGER - 1 });
  owned.store.set(progressKey(owned.worker.id), progress);
  const saved = await owned.service.handle('worker.bridgeSave', { workerId: owned.worker.id, progress });
  assert.equal(saved.revision, Number.MAX_SAFE_INTEGER);
  const writes = t.mock.method(owned.store, 'set');

  await unchangedRejection(
    owned,
    'worker.bridgeSave',
    { workerId: owned.worker.id, progress: saved },
    counterError,
  );
  await unchangedRejection(
    owned,
    'worker.bridgeExtend',
    { workerId: owned.worker.id, confirm: true },
    counterError,
  );
  assert.equal(writes.mock.callCount(), 0);
  assert.deepEqual(
    (await owned.service.handle('worker.bridgeLoad', { workerId: owned.worker.id })).progress,
    saved,
  );
});

for (const method of ['worker.steer', 'worker.followupActivate']) {
  test(
    method + ' caps additive budgets while retaining counters, history and readable progress',
    async (t) => {
      const owned = await fixture(t);
      const request = { id: 'continued_request', instruction: 'Keep the original work.', autoStart: false };
      const saved = await owned.service.handle('worker.bridgeSave', {
        workerId: owned.worker.id,
        progress: makeProgress(owned.worker, {
          turns: 99990,
          maxTurns: 100000,
          activeMs: 100000 * 60000,
          maxMinutes: 100000,
        }),
      });
      let result;

      if (method === 'worker.steer') {
        result = await owned.service.handle(method, { workerId: owned.worker.id, request });
      } else {
        await owned.service.handle('worker.followup', { workerId: owned.worker.id, request });
        result = await owned.service.handle(method, { workerId: owned.worker.id });
        assert.deepEqual(owned.store.get('miter.followup.checkpoint.' + request.id), saved);
      }

      const loaded = await owned.service.handle('worker.bridgeLoad', { workerId: owned.worker.id });
      taskProgressSchema.parse(loaded.progress);
      assert.equal(loaded.progress.maxTurns, 100000);
      assert.equal(loaded.progress.maxMinutes, 100000);
      assert.equal(loaded.progress.turns, saved.turns);
      assert.equal(loaded.progress.activeMs, saved.activeMs);
      assert.equal(loaded.progress.startedAt, saved.startedAt);
      assert.equal(owned.worker.runId, 'run_1');
      assert.equal(owned.service.followups.list(owned.worker.id).length, 1);

      if (method === 'worker.steer') {
        assert.equal(loaded.progress.revision, saved.revision + 2);
        const before = capture(owned);
        assert.deepEqual(await owned.service.handle(method, { workerId: owned.worker.id, request }), result);
        assert.deepEqual(capture(owned), before);
      } else {
        assert.equal(loaded.progress.revision, saved.revision + 1);
      }
    },
  );
}

for (const [method, revision] of [
  ['worker.stop', Number.MAX_SAFE_INTEGER],
  ['worker.steer', Number.MAX_SAFE_INTEGER - 1],
  ['worker.followupActivate', Number.MAX_SAFE_INTEGER],
]) {
  test(method + ' reserves every progress successor before changing the task or saved history', async (t) => {
    const owned = await fixture(t);
    const request = { id: 'overflow_request', instruction: 'Do not retire valid work.', autoStart: false };

    if (method === 'worker.followupActivate') {
      await owned.service.handle('worker.followup', { workerId: owned.worker.id, request });
    } else {
      await importBatch(owned.service, owned.worker, [{ type: 'list', path: '.' }]);
    }

    owned.store.set(progressKey(owned.worker.id), makeProgress(owned.worker, { revision }));
    const writes = t.mock.method(owned.store, 'set');
    const saves = t.mock.method(owned.store, 'saveWorker');
    const params = { workerId: owned.worker.id };

    if (method === 'worker.stop') {
      params.id = 'overflow_stop';
    } else if (method === 'worker.steer') {
      params.request = request;
    }

    await unchangedRejection(owned, method, params, counterError);
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(saves.mock.callCount(), 0);
    assert.equal((await owned.service.handle('state', {})).workers[0].control, undefined);
  });
}

test('epoch overflow rejects before retiring a queue or poisoning the original live worker', async (t) => {
  const owned = await fixture(t, {
    workers: [
      makeWorker({
        control: {
          version: 1,
          epoch: Number.MAX_SAFE_INTEGER,
          mode: 'fresh',
          at: 1,
          operationId: 'earlier_stop',
          reason: 'Ready to continue.',
          retiredExchanges: [],
        },
      }),
    ],
  });
  const worker = owned.worker;
  const writes = t.mock.method(owned.store, 'set');
  const saves = t.mock.method(owned.store, 'saveWorker');
  await unchangedRejection(owned, 'worker.stop', { workerId: worker.id, id: 'overflow_stop' }, counterError);
  assert.equal(owned.service.workers.get(worker.id), worker);
  assert.equal(worker.control.epoch, Number.MAX_SAFE_INTEGER);
  assert.equal((await owned.service.handle('state', {})).workers[0].control.epoch, Number.MAX_SAFE_INTEGER);
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(saves.mock.callCount(), 0);
});

for (const method of ['worker.steer', 'worker.followupActivate']) {
  test(method + ' rejects iteration-budget overflow before its first mutation', async (t) => {
    const owned = await fixture(t, {
      workers: [
        makeWorker({ iteration: Number.MAX_SAFE_INTEGER - 7, maxIterations: Number.MAX_SAFE_INTEGER }),
      ],
    });
    const request = { id: 'iteration_overflow', instruction: 'Keep the task intact.', autoStart: false };
    const params = { workerId: owned.worker.id };

    if (method === 'worker.steer') {
      params.request = request;
    } else {
      await owned.service.handle('worker.followup', { workerId: owned.worker.id, request });
    }

    const writes = t.mock.method(owned.store, 'set');
    const saves = t.mock.method(owned.store, 'saveWorker');
    await unchangedRejection(owned, method, params, counterError);
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(saves.mock.callCount(), 0);
  });
}

test('cached control acknowledgements match their lookup ID, but historical retries keep their original epoch', async (t) => {
  const owned = await fixture(t);
  const params = { workerId: owned.worker.id, id: 'first_stop' };
  const first = await owned.service.handle('worker.stop', params);
  await owned.service.handle('worker.stop', { workerId: owned.worker.id, id: 'second_stop' });
  assert.equal(owned.worker.control.epoch, first.epoch + 1);
  const before = capture(owned);
  assert.deepEqual(await owned.service.handle('worker.stop', params), first);
  assert.deepEqual(capture(owned), before);
  const key = 'miter.controlOperation.first_stop';
  const receipt = owned.store.get(key);
  owned.store.set(key, { ...receipt, result: { ...receipt.result, operationId: 'another_stop' } });

  await unchangedRejection(owned, 'worker.stop', params, (error) => {
    assert.match(error.message, /Saved run-control acknowledgement is invalid.*not overwritten/);
    assert.ok(error.cause instanceof ZodError);
    assert.deepEqual(error.cause.issues[0].path, ['result', 'operationId']);
    return true;
  });
});

test('steering preflight and retry reject misbound cached operation IDs without altering their history', async (t) => {
  const owned = await fixture(t);
  const request = { id: 'first_steer', instruction: 'Inspect current work.', autoStart: false };
  const params = { workerId: owned.worker.id, request };
  const first = await owned.service.handle('worker.steer', params);
  await owned.service.handle('worker.stop', { workerId: owned.worker.id, id: 'later_stop' });
  const before = capture(owned);
  assert.deepEqual(await owned.service.handle('worker.steer', params), first);
  assert.deepEqual(await owned.service.handle('worker.steerValidate', params), {
    valid: true,
    alreadyApplied: true,
  });
  assert.deepEqual(capture(owned), before);
  const key = 'miter.controlOperation.first_steer';
  const receipt = owned.store.get(key);
  owned.store.set(key, { ...receipt, result: { ...receipt.result, operationId: 'another_steer' } });

  for (const method of ['worker.steer', 'worker.steerValidate']) {
    await unchangedRejection(
      owned,
      method,
      params,
      /Saved run-control acknowledgement is invalid.*not overwritten/,
    );
  }
});

test('team-message receipts bind the literal action, recipient, worker and project without normalizing payloads', async (t) => {
  const owned = await fixture(t, {
    workers: [makeWorker(), makeWorker({ id: 'worker_2', runId: 'run_2' })],
  });
  const message = '\ufeffliteral\r\n界 $&  token=a  ';
  const params = { workerId: owned.worker.id, id: 'message_1', to: 'worker_2', message };
  const result = await owned.service.handle('worker.teamMessage', params);
  const receipt = owned.store.get('team-action:' + params.id);
  assert.deepEqual(receipt.result, result);
  assert.equal(
    receipt.signature,
    digest(
      JSON.stringify({
        workerId: owned.worker.id,
        projectId: owned.worker.projectId,
        actionId: params.id,
        action: parseAction({ type: 'team_message', message, to: params.to }),
      }),
    ),
  );
  assert.equal(JSON.stringify(receipt).includes('token=a'), false);
  const before = capture(owned);
  assert.deepEqual(await owned.service.handle('worker.teamMessage', params), result);
  assert.deepEqual(capture(owned), before);

  for (const changed of [
    { message: message.replace('\r\n', '\n') },
    { message: message.slice(1) },
    { message: message.trimEnd() },
    { message: message.replace('token=a', 'token=b') },
    { to: undefined },
    { workerId: 'worker_2' },
  ]) {
    await unchangedRejection(
      owned,
      'worker.teamMessage',
      { ...params, ...changed },
      /ID was used for another/,
    );
  }

  const foreignProject = { ...owned.project, id: 'project_2', name: 'Foreign' };
  owned.store.saveProject(foreignProject);
  owned.service.projects.set(foreignProject.id, foreignProject);
  const foreignWorker = { ...owned.worker, projectId: foreignProject.id };
  const foreignBefore = capture(owned);
  assert.throws(
    () =>
      owned.service.team.execute(foreignWorker, { type: 'team_message', message, to: params.to }, params.id),
    /ID was used for another/,
  );
  assert.deepEqual(capture(owned), foreignBefore);
});

test('exact cooperative hold retries retain old receipts instead of recreating released holds', async (t) => {
  const owned = await fixture(t, {
    workers: [makeWorker(), makeWorker({ id: 'worker_2', runId: 'run_2' })],
  });
  const pause = {
    type: 'team_pause',
    workerId: 'worker_2',
    reason: '\ufeffliteral\r\nreason  ',
    seconds: 120,
  };
  const result = owned.service.team.execute(owned.worker, pause, 'hold_1');
  owned.service.team.releaseOwner(owned.worker.id);
  const before = capture(owned);
  assert.deepEqual(
    owned.service.team.execute(
      owned.worker,
      {
        seconds: pause.seconds,
        reason: pause.reason,
        workerId: pause.workerId,
        type: pause.type,
      },
      'hold_1',
    ),
    result,
  );
  assert.deepEqual(capture(owned), before);
  assert.equal(owned.service.team.reason('worker_2'), '');

  for (const action of [
    { ...pause, seconds: 121 },
    { ...pause, reason: pause.reason.replace('\r\n', '\n') },
    { type: 'team_resume', workerId: 'worker_2', context: pause.reason },
  ]) {
    const beforeReject = capture(owned);
    assert.throws(
      () => owned.service.team.execute(owned.worker, action, 'hold_1'),
      /ID was used for another/,
    );
    assert.deepEqual(capture(owned), beforeReject);
  }
});

test('legacy or damaged team receipts fail without replay, overwrite or implicit migration', async (t) => {
  const owned = await fixture(t);
  const params = { workerId: owned.worker.id, id: 'legacy_message', message: 'Do not replay.' };

  for (const receipt of [
    { ok: true, note: 'Legacy acknowledgement.' },
    { signature: 'not-a-hash', result: { ok: true, note: 'Damaged acknowledgement.' } },
    null,
    false,
  ]) {
    owned.store.set('team-action:' + params.id, receipt);
    await unchangedRejection(owned, 'worker.teamMessage', params, (error) => {
      assert.match(error.message, /cannot prove this exact request.*not replayed or overwritten/);
      assert.ok(error.cause instanceof ZodError);
      return true;
    });
  }
});

test('a team receipt copied to another action ID cannot acknowledge a request that never executed', async (t) => {
  const owned = await fixture(t);
  const params = { workerId: owned.worker.id, id: 'original_id', message: 'Same literal message.' };
  await owned.service.handle('worker.teamMessage', params);
  owned.store.set('team-action:copied_id', owned.store.get('team-action:original_id'));
  await unchangedRejection(
    owned,
    'worker.teamMessage',
    { ...params, id: 'copied_id' },
    /ID was used for another/,
  );
});

test('an existing team message without its receipt is not replayed or given a new fingerprint', async (t) => {
  const owned = await fixture(t);
  owned.service.team.message({
    id: 'receipt_missing',
    projectId: owned.project.id,
    from: owned.worker.id,
    message: 'Original message.',
    time: 1,
    kind: 'message',
  });
  await unchangedRejection(
    owned,
    'worker.teamMessage',
    {
      workerId: owned.worker.id,
      id: 'receipt_missing',
      message: 'Different message.',
    },
    /no matching acknowledgement.*not replayed or overwritten/,
  );
  assert.equal(owned.store.get('team-action:receipt_missing'), undefined);
});

test('team persistence rejects invalid timestamps before writing message rows', async (t) => {
  const owned = await fixture(t);

  for (const time of [-1, 0.5, 8640000000000001, Number.MAX_SAFE_INTEGER + 1]) {
    const before = capture(owned);
    assert.throws(
      () =>
        owned.service.team.message({
          id: 'invalid_time',
          projectId: owned.project.id,
          from: owned.worker.id,
          message: 'Do not persist.',
          time,
          kind: 'message',
        }),
      ZodError,
    );
    assert.deepEqual(capture(owned), before);
  }
});
