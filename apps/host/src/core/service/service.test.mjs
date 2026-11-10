import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  digest,
  envelopeHash,
  fixture,
  importBatch,
  makeEnvelope,
  makeProgress,
  makeWorker,
  registerScript,
  runToBoundary,
} from './test-fixture.mjs';

const { progressKey } = await import('../../../../../packages/bridge/src/progress.ts');
const { deliveryKey } = await import('../handoff-delivery.ts');
const { taskProgressSchema } = await import('../../../../../packages/bridge/src/progress.ts');
const { controlOperationSchema, commandJournalSchema, retiredQueueSchema } = await import('./schemas.ts');

async function approveCurrent(service, worker, extra = {}) {
  const approval = worker.pending;
  assert.ok(approval);
  await service.handle('worker.approve', {
    workerId: worker.id,
    token: approval.token,
    approve: true,
    ...extra,
  });
  await service.wait(worker.id);
}

test('startup recovery keeps identity, retires stopped queues, and resets trust', async (context) => {
  const saved = makeWorker({
    state: 'executing',
    cursor: 1,
    autoCommands: true,
    approvedFingerprint: 'a'.repeat(64),
    control: {
      version: 1,
      epoch: 2,
      mode: 'stopped',
      at: 1,
      operationId: 'stop_1',
      reason: 'Stopped.',
      retiredExchanges: ['exchange_1'],
    },
  });
  saved.queue = [makeEnvelope(saved, [{ type: 'read', path: 'file.txt' }])];
  const { worker, store } = await fixture(context, { workers: [saved] });
  assert.equal(worker.state, 'paused');
  assert.equal(worker.runId, saved.runId);
  assert.equal(worker.control.epoch, 2);
  assert.equal(worker.autoCommands, false);
  assert.equal(worker.approvedFingerprint, undefined);
  assert.deepEqual(worker.queue, []);
  const retired = retiredQueueSchema.parse(store.get('miter.retiredQueue.stop_1'));
  assert.equal(retired.cursor, 1);
  assert.deepEqual(retired.queue, saved.queue);
  assert.ok(store.events().some((event) => event.kind === 'recovery'));
});

test('read bases bind observed versions; incomplete reads cannot authorize writes', async (context) => {
  const { service, worker, store, root } = await fixture(context);
  await fs.writeFile(path.join(root, 'file.txt'), 'original content');
  await importBatch(service, worker, [{ type: 'read', path: 'file.txt', limit: 2 }]);
  await runToBoundary(service, worker);
  const firstRead = worker.observations.map((value) => JSON.parse(value)).find((value) => value.result?.base);
  assert.ok(firstRead);
  const reply = makeEnvelope(worker, [
    {
      type: 'write',
      path: 'file.txt',
      content: 'replacement',
      base: firstRead.result.base,
    },
  ]);
  const incomplete = await service.handle('worker.validateReply', {
    workerId: worker.id,
    text: JSON.stringify(reply),
  });
  assert.equal(incomplete.valid, false);
  assert.equal(incomplete.issue.code, 'BASE_INCOMPLETE');

  await importBatch(service, worker, [{ type: 'read', path: 'file.txt', offset: 2 }]);
  await runToBoundary(service, worker);
  await fs.writeFile(path.join(root, 'file.txt'), 'outside changes');
  await service.handle('worker.import', {
    workerId: worker.id,
    text: JSON.stringify(reply),
  });
  assert.equal(worker.queue[0].actions[0].expectedHash, digest('original content'));
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'outside changes');
  assert.equal(store.writes(worker.runId).length, 0);
  const audit = store.get(`edit-repair:${worker.runId}:${reply.id}`);
  assert.equal(audit.repair.current.hash, digest('outside changes'));
  assert.equal(audit.batches[0].actions[0].expectedHash, digest('original content'));
});

test('exact import/start retries acknowledge once and remain fenced after stop', async (context) => {
  const { service, worker, store } = await fixture(context);
  const envelope = await importBatch(service, worker, [{ type: 'list', path: '.' }]);
  const text = JSON.stringify(envelope);
  await assert.rejects(service.handle('worker.import', { workerId: worker.id, text }), /already imported/);
  assert.deepEqual(
    await service.handle('worker.import', {
      workerId: worker.id,
      text,
      reconcile: true,
    }),
    {
      queued: true,
      acknowledged: true,
    },
  );
  await assert.rejects(
    service.handle('worker.import', {
      workerId: worker.id,
      text: JSON.stringify({ ...envelope, summary: 'Different contents.' }),
      reconcile: true,
    }),
    /exact batch/,
  );

  const start = {
    workerId: worker.id,
    envelopeId: envelope.id,
    envelopeHash: envelopeHash(envelope),
  };
  let durableBeforeRun = false;
  const originalRun = service.run.bind(service);
  service.run = (workerId) => {
    durableBeforeRun = store.get(deliveryKey(envelope.id)).started === true;
    originalRun(workerId);
  };
  await service.handle('worker.run', start);
  assert.equal(durableBeforeRun, true);
  await service.wait(worker.id);
  const observations = worker.observations.slice();
  assert.equal((await service.handle('worker.run', start)).acknowledged, true);
  assert.deepEqual(worker.observations, observations);
  assert.equal(store.envelopeCount(worker.id), 1);

  const stopped = await service.handle('worker.stop', {
    workerId: worker.id,
    id: 'stop_1',
  });
  await assert.rejects(
    service.handle('worker.import', {
      workerId: worker.id,
      text,
      reconcile: true,
    }),
    /stopped/,
  );
  await service.handle('worker.continueFresh', { workerId: worker.id });
  await assert.rejects(service.handle('worker.run', { ...start, epoch: stopped.epoch }), /exact batch/);
});

test('approval is token/revision-bound and batch trust never carries into a new import', async (context) => {
  const { service, worker, project, root } = await fixture(context);
  const profile = await registerScript(
    service,
    project,
    root,
    "require('node:fs').appendFileSync('runs.txt', 'run\\n');",
  );
  await importBatch(service, worker, [{ type: 'command', profileId: profile.id }]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'awaiting_approval');
  const oldApproval = worker.pending;
  assert.ok(oldApproval);
  await assert.rejects(
    service.handle('worker.approve', {
      workerId: worker.id,
      token: 'wrong',
      approve: true,
    }),
    /expired/,
  );
  await service.handle('project.profile', { projectId: project.id, profile });
  await assert.rejects(
    service.handle('worker.approve', {
      workerId: worker.id,
      token: oldApproval.token,
      approve: true,
    }),
    /Workspace changed/,
  );
  await assert.rejects(fs.readFile(path.join(root, 'runs.txt')), {
    code: 'ENOENT',
  });

  await runToBoundary(service, worker);
  await approveCurrent(service, worker, { trustRun: true });
  assert.equal(await fs.readFile(path.join(root, 'runs.txt'), 'utf8'), 'run\n');
  await importBatch(service, worker, [{ type: 'command', profileId: profile.id }]);
  assert.equal(worker.autoCommands, false);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'awaiting_approval');
  assert.equal(await fs.readFile(path.join(root, 'runs.txt'), 'utf8'), 'run\n');
});

test('failed commands save evidence before retiring their stale remainder', async (context) => {
  const { service, worker, project, root, store } = await fixture(context);
  const profile = await registerScript(
    service,
    project,
    root,
    "require('node:fs').appendFileSync('runs.txt', 'run\\n'); process.exit(7);",
  );
  const envelope = await importBatch(service, worker, [
    { type: 'command', profileId: profile.id },
    { type: 'write', path: 'must-not-run.txt', content: 'stale', expectedHash: 'missing' },
    { type: 'finish', summary: 'Must not finish.' },
  ]);
  const publications = [];
  const originalSave = store.saveWorker.bind(store);
  store.saveWorker = (saved) => {
    originalSave(saved);
    const evidence = saved.observations.map((observation) => JSON.parse(observation));

    if (evidence.some((observation) => observation.result?.code === 7)) {
      publications.push({ cursor: saved.cursor, state: saved.state });
    }
  };
  await runToBoundary(service, worker);
  await approveCurrent(service, worker);
  assert.equal(worker.state, 'blocked');
  assert.match(worker.error, /Command failed/);
  assert.equal(worker.cursor, envelope.actions.length);
  assert.deepEqual(publications[0], { cursor: 0, state: 'executing' });
  assert.deepEqual(publications.at(-1), { cursor: envelope.actions.length, state: 'blocked' });
  const journal = commandJournalSchema.parse(store.get('command:' + envelope.id + '_0'));
  assert.equal(journal.status, 'finished');
  assert.equal(journal.result.code, 7);
  await assert.rejects(fs.access(path.join(root, 'must-not-run.txt')), { code: 'ENOENT' });

  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.equal(await fs.readFile(path.join(root, 'runs.txt'), 'utf8'), 'run\n');
  assert.equal(worker.completion, undefined);
});

test('finished commands recover cursor lag; invalid records stay quarantined', async (context) => {
  const { service, worker, project, root, store } = await fixture(context);
  const profile = await registerScript(
    service,
    project,
    root,
    "require('node:fs').appendFileSync('runs.txt', 'run\\n');",
  );
  const first = await importBatch(service, worker, [{ type: 'command', profileId: profile.id }]);
  await runToBoundary(service, worker);
  await approveCurrent(service, worker);
  const saved = commandJournalSchema.parse(store.get(`command:${first.id}_0`));
  assert.equal(saved.status, 'finished');
  worker.queue = [first];
  worker.cursor = 0;
  worker.state = 'paused';
  store.saveWorker(worker);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.equal(await fs.readFile(path.join(root, 'runs.txt'), 'utf8'), 'run\n');

  for (const record of [
    { status: 'started', workerId: worker.id, profile, time: 1 },
    { status: 'finished', workerId: worker.id, result: { code: 0 } },
  ]) {
    const next = await importBatch(service, worker, [{ type: 'command', profileId: profile.id }]);
    const key = `command:${next.id}_0`;
    store.set(key, record);
    await runToBoundary(service, worker);
    assert.equal(worker.state, 'blocked');
    assert.match(worker.error, /quarantined|invalid/);
    assert.deepEqual(store.get(key), record);
    assert.equal(await fs.readFile(path.join(root, 'runs.txt'), 'utf8'), 'run\n');
    await service.handle('worker.skip', { workerId: worker.id, confirm: true });
  }
});

test('edits journal before cursor advancement; queued batches precede finish', async (context) => {
  const { service, worker, root, store } = await fixture(context);
  const timeline = [];
  const markWrite = store.markWrite.bind(store);
  const saveWorker = store.saveWorker.bind(store);
  store.markWrite = (actionId, status) => {
    timeline.push({ kind: 'journal', actionId, status });
    markWrite(actionId, status);
  };
  store.saveWorker = (value) => {
    timeline.push({ kind: 'worker', cursor: value.cursor });
    saveWorker(value);
  };
  const first = await importBatch(service, worker, [
    {
      type: 'write',
      path: 'first.txt',
      content: 'first',
      expectedHash: 'missing',
    },
    { type: 'finish', summary: 'Do not finish early.' },
  ]);
  await importBatch(service, worker, [
    {
      type: 'write',
      path: 'second.txt',
      content: 'second',
      expectedHash: 'missing',
    },
    { type: 'finish', summary: 'Both batches finished.' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'complete');
  assert.equal(worker.completion.summary, 'Both batches finished.');
  assert.equal(worker.completion.verification, 'not-run');
  assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'first');
  assert.equal(await fs.readFile(path.join(root, 'second.txt'), 'utf8'), 'second');
  assert.ok(worker.observations.some((value) => value.includes('Completion deferred')));
  const journalAt = timeline.findIndex(
    (value) => value.kind === 'journal' && value.actionId === first.id + '_0',
  );
  const advancedAt = timeline.findIndex((value) => value.kind === 'worker' && value.cursor === 1);
  assert.ok(journalAt >= 0 && advancedAt > journalAt);
  assert.deepEqual(
    await service.handle('worker.accept', {
      workerId: worker.id,
      confirm: true,
    }),
    {
      accepted: false,
      alreadyComplete: true,
    },
  );
});

test('a stale later edit cannot partially commit a segment or execute its command', async (context) => {
  const { service, worker, root, store, project } = await fixture(context);
  await fs.writeFile(path.join(root, 'second.txt'), 'outside');
  const profile = await registerScript(
    service,
    project,
    root,
    "require('node:fs').writeFileSync('command-ran.txt', 'unexpected');",
  );
  const envelope = await importBatch(service, worker, [
    {
      type: 'write',
      path: 'first.txt',
      content: 'must not commit',
      expectedHash: 'missing',
    },
    {
      type: 'write',
      path: 'second.txt',
      content: 'stale',
      expectedHash: digest('old'),
    },
    { type: 'command', profileId: profile.id },
    { type: 'finish', summary: 'Not finished.' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.equal(store.writes(worker.runId).length, 0);
  assert.deepEqual(worker.queue, []);
  await assert.rejects(fs.readFile(path.join(root, 'first.txt')), {
    code: 'ENOENT',
  });
  await assert.rejects(fs.readFile(path.join(root, 'command-ran.txt')), {
    code: 'ENOENT',
  });
  const audit = store.get(`edit-repair:${worker.runId}:${envelope.id}`);
  assert.equal(audit.repair.actionIndex, 1);
  assert.equal(audit.repair.discarded[0].remainingActions, 4);
});

test('finish runs commands before file checks and never reuses verification', async (context) => {
  const { service, worker, root, project, store } = await fixture(context);
  const profile = await registerScript(
    service,
    project,
    root,
    "require('node:fs').writeFileSync('generated.txt', 'verified');",
  );
  worker.checks = [
    { type: 'contains', path: 'generated.txt', text: 'verified' },
    { type: 'command', profileId: profile.id },
  ];
  const envelope = await importBatch(service, worker, [{ type: 'finish', summary: 'Verified output.' }]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'awaiting_approval');
  await approveCurrent(service, worker);
  assert.equal(worker.state, 'complete');
  assert.equal(worker.completion.checked, 2);
  assert.equal(worker.completion.verification, 'passed');
  const evidence = worker.observations.map((value) => JSON.parse(value)).find((value) => value.results);
  assert.ok(evidence);
  assert.deepEqual(
    evidence.results.map((value) => value.check.type),
    ['command', 'contains'],
  );

  worker.state = 'paused';
  worker.queue = [envelope];
  worker.cursor = 0;
  worker.completion = undefined;
  store.saveWorker(worker);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'blocked');
  assert.match(worker.error, /Cached test output is not fresh verification/);
});

test('stop persists before abort, rejects concurrent controls, and drains inference', async (context) => {
  const entered = Promise.withResolvers();
  const generated = Promise.withResolvers();
  let environment;
  let abortObserved = false;
  const models = {
    propose: async (_prompt, signal) => {
      signal.addEventListener(
        'abort',
        () => {
          const saved = environment.store.workers().find((value) => value.id === environment.worker.id);
          assert.ok(saved);
          assert.equal(saved.control.epoch, 1);
          assert.equal(saved.control.mode, 'stopped');
          const progress = taskProgressSchema.parse(environment.store.get(progressKey(saved.id)));
          assert.equal(progress.revision, 2);
          assert.equal(progress.lastReceipt, undefined);
          abortObserved = true;
        },
        { once: true },
      );
      entered.resolve();
      return generated.promise;
    },
    close: () => generated.resolve(JSON.stringify({ summary: 'Retired.', actions: [{ type: 'list' }] })),
  };
  environment = await fixture(context, {
    workers: [makeWorker({ mode: 'local' })],
    models,
  });
  const { service, worker, store } = environment;
  service.settings.coderModelPath = '/configured/model.gguf';
  const progress = makeProgress(worker, {
    stage: 'waiting_reply',
    lastReceipt: {
      workerId: worker.id,
      projectId: worker.projectId,
      goalHash: digest(worker.goal),
      textHash: 'b'.repeat(64),
      renderedHash: 'b'.repeat(64),
      at: 100,
      exchangeId: '11111111-1111-4111-8111-111111111111',
      expectsReplyTo: true,
    },
  });
  await service.handle('worker.bridgeSave', { workerId: worker.id, progress });
  service.run(worker.id);
  await entered.promise;
  const stopping = service.handle('worker.stop', {
    workerId: worker.id,
    id: 'stop_1',
  });
  assert.equal(abortObserved, true);
  assert.equal(worker.control.epoch, 1);
  assert.equal(worker.control.mode, 'stopped');
  assert.deepEqual(worker.control.retiredExchanges, ['11111111-1111-4111-8111-111111111111']);
  await assert.rejects(
    service.handle('worker.stop', { workerId: worker.id, id: 'stop_2' }),
    /already stopping/,
  );
  await assert.rejects(service.handle('worker.continueFresh', { workerId: worker.id }), /current operation/);
  await assert.rejects(
    service.handle('worker.bridgeSave', {
      workerId: worker.id,
      progress,
      epoch: 0,
    }),
    /stopped or earlier run/,
  );
  generated.resolve(
    JSON.stringify({
      summary: 'Retired.',
      actions: [
        {
          type: 'write',
          path: 'never.txt',
          content: 'never',
          expectedHash: 'missing',
        },
      ],
    }),
  );
  const result = await stopping;
  assert.equal(worker.state, 'paused');
  assert.deepEqual(worker.queue, []);
  assert.equal(store.envelopeCount(worker.id), 0);
  assert.deepEqual(await service.handle('worker.stop', { workerId: worker.id, id: 'stop_1' }), result);
  controlOperationSchema.parse(store.get('miter.controlOperation.stop_1'));
  assert.equal(worker.control.epoch, 1);
  assert.equal((await service.handle('worker.continueFresh', { workerId: worker.id })).ready, true);
  await assert.rejects(service.handle('worker.resume', { workerId: worker.id, epoch: 0 }), /earlier run/);
});

test('steering keeps task identity and binds replies to the fresh durable exchange', async (context) => {
  const { service, worker, store } = await fixture(context);
  const runId = worker.runId;
  await importBatch(service, worker, [{ type: 'list', path: '.' }]);
  const request = {
    id: 'steer_1',
    instruction: 'Keep completed edits; inspect the current files.',
    autoStart: false,
  };
  const result = await service.handle('worker.steer', {
    workerId: worker.id,
    request,
  });
  assert.equal(result.ready, true);
  assert.equal(worker.control.mode, 'fresh');
  assert.equal(worker.runId, runId);
  assert.equal(worker.activeFollowupId, request.id);
  assert.equal(service.followups.get(request.id).status, 'active');
  assert.deepEqual(
    await service.handle('worker.steerValidate', {
      workerId: worker.id,
      request,
    }),
    {
      valid: true,
      alreadyApplied: true,
    },
  );
  await assert.rejects(
    service.handle('worker.steer', {
      workerId: worker.id,
      request: { ...request, instruction: 'Different request.' },
    }),
    /used for another request/,
  );
  const stale = makeEnvelope(worker, [{ type: 'list', path: '.' }], {
    replyTo: 'old_exchange',
  });
  await assert.rejects(
    service.handle('worker.import', {
      workerId: worker.id,
      text: JSON.stringify(stale),
      epoch: result.epoch,
    }),
    /Fresh continuation/,
  );

  const progress = makeProgress(worker, {
    stage: 'commit_intent',
    lastReceipt: {
      workerId: worker.id,
      projectId: worker.projectId,
      goalHash: digest(worker.goal),
      textHash: 'b'.repeat(64),
      renderedHash: 'b'.repeat(64),
      at: 100,
      exchangeId: '22222222-2222-4222-8222-222222222222',
      expectsReplyTo: true,
    },
  });
  await service.handle('worker.bridgeSave', {
    workerId: worker.id,
    progress,
    epoch: result.epoch,
  });
  await importBatch(service, worker, [{ type: 'list', path: '.' }], {
    replyTo: '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(worker.control.mode, 'active');
  assert.equal(store.envelopeCount(worker.id), 2);
});

test('progress saves enforce revisions, retained budgets, and corrupt-record refusal', async (context) => {
  const { service, worker, store } = await fixture(context);
  const progress = makeProgress(worker);
  const saved = await service.handle('worker.bridgeSave', {
    workerId: worker.id,
    progress,
  });
  assert.equal(saved.revision, 1);
  await assert.rejects(
    service.handle('worker.bridgeSave', { workerId: worker.id, progress }),
    /another session/,
  );

  for (const overrides of [
    { turns: 1 },
    { activeMs: 0 },
    { maxTurns: 6 },
    { maxMinutes: 11 },
    { startedAt: 11 },
  ]) {
    await assert.rejects(
      service.handle('worker.bridgeSave', {
        workerId: worker.id,
        progress: { ...saved, ...overrides },
      }),
      /cannot be reset/,
    );
  }

  assert.deepEqual(store.get(progressKey(worker.id)), saved);
  await assert.rejects(service.handle('worker.bridgeExtend', { workerId: worker.id }), /authorization/);
  const extended = await service.handle('worker.bridgeExtend', {
    workerId: worker.id,
    confirm: true,
  });
  assert.equal(extended.maxTurns, 20);
  assert.equal(extended.maxMinutes, 40);
  assert.equal(extended.revision, 2);
  assert.equal(extended.turns, 2);
  const corrupt = { version: 999 };
  store.set(progressKey(worker.id), corrupt);
  await assert.rejects(service.handle('worker.bridgeLoad', { workerId: worker.id }), /not overwritten/);
  await assert.rejects(
    service.handle('worker.bridgeSave', { workerId: worker.id, progress }),
    /refusing to overwrite/,
  );
  assert.deepEqual(store.get(progressKey(worker.id)), corrupt);
});

test('follow-ups respect pending exchanges and preserve budgets and history', async (context) => {
  const { service, worker, store } = await fixture(context);
  const request = {
    id: 'followup_1',
    instruction: 'Inspect the same task.',
    autoStart: false,
  };
  await service.handle('worker.followup', { workerId: worker.id, request });
  const waiting = makeProgress(worker, { stage: 'waiting_reply' });
  await service.handle('worker.bridgeSave', {
    workerId: worker.id,
    progress: waiting,
  });
  assert.equal((await service.handle('worker.followupActivate', { workerId: worker.id })).activated, false);
  const prior = taskProgressSchema.parse(store.get(progressKey(worker.id)));
  await service.handle('worker.bridgeSave', {
    workerId: worker.id,
    progress: { ...prior, stage: 'report_due' },
  });
  const ready = taskProgressSchema.parse(store.get(progressKey(worker.id)));
  const activated = await service.handle('worker.followupActivate', {
    workerId: worker.id,
  });
  assert.equal(activated.activated, true);
  assert.equal(activated.id, request.id);
  assert.equal(worker.runId, 'run_1');
  assert.equal(service.followups.list(worker.id).length, 1);
  const next = taskProgressSchema.parse(store.get(progressKey(worker.id)));
  assert.equal(next.turns, waiting.turns);
  assert.equal(next.activeMs, waiting.activeMs);
  assert.equal(next.revision, ready.revision + 1);
  assert.equal(next.maxTurns, 17);
  assert.equal(next.maxMinutes, 31);
  assert.deepEqual(store.get('miter.followup.checkpoint.' + request.id), ready);
});

test('quiesce fences requests and drains models before close; failed drains retry', async (context) => {
  const settled = Promise.withResolvers();
  let closeCalls = 0;
  let failDrain = false;
  const models = {
    propose: async () => {
      throw new Error('Unexpected inference.');
    },
    close: () => {
      closeCalls++;
    },
    settled: async () => {
      if (failDrain) {
        failDrain = false;
        throw new Error('Model process is still retiring.');
      }

      await settled.promise;
    },
  };
  const { service, store, stoppedActors } = await fixture(context, { models });
  let databaseCloses = 0;
  const close = store.close.bind(store);
  store.close = () => {
    databaseCloses++;
    close();
  };
  failDrain = true;
  await assert.rejects(service.quiesce(), /still retiring/);
  assert.equal(databaseCloses, 0);
  const draining = service.quiesce();
  assert.equal(service.quiesce(), draining);
  await assert.rejects(service.handle('state', {}), /shutting down/);
  assert.equal(databaseCloses, 0);
  settled.resolve();
  await draining;
  await service.close();
  await service.close();
  assert.equal(databaseCloses, 1);
  assert.equal(closeCalls, 2);
  assert.ok(stoppedActors.length >= 1);
});
