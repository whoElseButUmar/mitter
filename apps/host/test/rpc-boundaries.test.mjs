import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ZodError } from 'zod';
import {
  RpcResultValidationError,
  assetChunkSchema,
  changedFileSchema,
  fileReviewSchema,
  fileTextSchema,
  healthSchema,
  stateBackupSchema,
  teamMessageSchema,
  teamResultSchema,
  controlResultSchema,
  followupActivationSchema,
  projectContextSchema,
  workerCreationSchema,
  commandProfileInputSchema,
  syntaxCheckSchema,
  workspaceRollbackSchema,
} from '../../../packages/protocol/src/rpc.js';
import { taskProgressSchema, progressKey } from '../../../packages/bridge/src/progress.js';
import { bridgeProgressLoadSchema } from '../../../packages/bridge/src/runner/progress-load.js';
import { serviceRpcRegistry } from '../src/core/service/rpc.js';
import { readControlOperation } from '../src/core/service/schemas.js';
import { deliveryKey } from '../src/core/handoff-delivery.js';
import { fixture, makeProgress, importBatch, envelopeHash } from '../src/core/service/test-fixture.mjs';
import { createStateBackup, restoreStateBackup, stateRestoreResultSchema } from '../src/core/backups.js';
import { nativeTerminalCheckSchema } from '../src/core/pty-runtime.js';
import { EXPECTED_VERSION } from '../src/core/terminal/helper-check.js';
import { memoryStore, temporaryDirectory } from './fixtures.mjs';

function capture(owned) {
  return {
    worker: structuredClone(owned.worker),
    project: structuredClone(owned.project),
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

function invalidResult(error) {
  assert.ok(error instanceof RpcResultValidationError);
  assert.equal(error.code, 'RPC_RESULT_INVALID');
  assert.equal(error.retryable, false);
  assert.ok(error.cause instanceof ZodError);
  return true;
}

test('host adapters re-export the canonical full RPC schemas rather than drifting projections', async () => {
  for (const [module, names] of [
    [await import('../src/core/assets.js'), { assetChunkSchema }],
    [await import('../src/core/backups.js'), { stateBackupSchema }],
    [await import('../src/core/health.js'), { healthSchema }],
    [await import('../src/core/collaboration.js'), { teamMessageSchema, teamResultSchema }],
    [await import('../src/core/review.js'), { fileReviewSchema }],
    [await import('../src/core/storage-schemas.js'), { changedFileSchema }],
    [await import('../src/core/syntax-check.js'), { syntaxCheckSchema }],
    [await import('../src/core/workspace/files.js'), { fileTextSchema }],
    [await import('../src/core/workspace/journal.js'), { workspaceRollbackSchema }],
    [await import('../src/core/service/schemas.js'), { controlResultSchema, followupActivationSchema }],
    [await import('../src/core/service/project-catalog.js'), { projectContextSchema }],
    [await import('../src/core/service/request-parsing.js'), { workerCreationSchema }],
    [await import('../src/core/commands.js'), { commandProfileInputSchema }],
  ]) {
    for (const [name, schema] of Object.entries(names)) {
      assert.equal(module[name], schema, name);
    }
  }

  assert.equal(serviceRpcRegistry['worker.bridgeLoad'].result, bridgeProgressLoadSchema);
  assert.equal(serviceRpcRegistry['worker.bridgeSave'].result, taskProgressSchema);
  assert.equal(serviceRpcRegistry['worker.bridgeExtend'].result, taskProgressSchema);
});

test('every Service operation rejects malformed parameter containers before effects', async (t) => {
  const owned = await fixture(t);

  for (const method of Object.keys(serviceRpcRegistry)) {
    await unchangedRejection(owned, method, [], /Expected params/);
  }
});

test('every task operation checks a malformed reviewed run before its own request or side effects', async (t) => {
  const owned = await fixture(t);

  for (const method of Object.keys(serviceRpcRegistry)) {
    if (!method.startsWith('worker.') || method === 'worker.create') {
      continue;
    }

    await unchangedRejection(
      owned,
      method,
      {
        workerId: owned.worker.id,
        expectedRun: { runId: owned.worker.runId, epoch: 0.5 },
      },
      /reviewed task boundary is invalid/,
    );
  }
});

test('project/task read paths and context fields reject before filesystem reads or partial saves', async (t) => {
  const owned = await fixture(t);
  await owned.service.handle('project.context', {
    projectId: owned.project.id,
    save: true,
    mission: 'Original',
    conventions: 'Keep literal rules.\r\n',
  });
  let opens = 0;
  t.mock.method(fs, 'open', async () => {
    opens++;
    throw new Error('Invalid input must not reach a source read.');
  });

  for (const pathValue of [null, {}, 12, '', '\0file.txt']) {
    await unchangedRejection(
      owned,
      'project.read',
      { projectId: owned.project.id, path: pathValue },
      /Invalid file path/,
    );
    await unchangedRejection(
      owned,
      'worker.read',
      { workerId: owned.worker.id, path: pathValue },
      /Invalid path/,
    );
  }

  await unchangedRejection(
    owned,
    'project.context',
    {
      projectId: owned.project.id,
      save: true,
      mission: 'Must not be saved.',
      conventions: false,
    },
    /Invalid conventions/,
  );
  assert.equal(opens, 0);
  t.mock.restoreAll();
  const literal = '\ufefforiginal\r\n界 $&  ';
  await fs.writeFile(path.join(owned.root, 'literal.txt'), literal);
  const projectRead = await owned.service.handle('project.read', {
    projectId: owned.project.id,
    path: 'literal.txt',
  });
  const taskRead = await owned.service.handle('worker.read', {
    workerId: owned.worker.id,
    path: 'literal.txt',
  });
  assert.deepEqual(taskRead, projectRead);
  assert.equal(taskRead.content, literal);
});

test('task creation retains the legacy suggested-name path for long blank names and nullish budgets', async (t) => {
  const owned = await fixture(t);
  const created = await owned.service.handle('worker.create', {
    projectId: owned.project.id,
    mode: 'handoff',
    goal: 'Keep the existing implementation.',
    name: ' '.repeat(100),
    checks: null,
    maxIterations: null,
    maxMinutes: null,
  });
  assert.ok(created.name.trim());
  assert.ok(created.name.length <= 60);
  assert.equal(created.maxIterations, 8);
  assert.equal(created.maxMinutes, 15);
  assert.deepEqual(created.checks, []);
  assert.equal(
    owned.store.workers().some((worker) => worker.id === created.id),
    true,
  );
});

test('team-message payload and stable ID validation precede delivery and cached acknowledgements', async (t) => {
  const owned = await fixture(t);
  let deliveries = 0;
  t.mock.method(owned.service.team, 'execute', () => {
    deliveries++;
    throw new Error('Invalid team inputs must not deliver context.');
  });

  for (const changed of [{ id: 12 }, { id: '' }, { message: false }, { to: null }, { to: '' }]) {
    await unchangedRejection(owned, 'worker.teamMessage', {
      workerId: owned.worker.id,
      id: 'message_1',
      message: 'Keep work.',
      ...changed,
    });
  }

  assert.equal(deliveries, 0);
});

test('handler failures keep stopped/run/token/cancellation error priority instead of becoming generic schema errors', async (t) => {
  const owned = await fixture(t);
  await unchangedRejection(
    owned,
    'worker.approve',
    {
      workerId: owned.worker.id,
      token: 'wrong',
      approve: 'true',
      trustRun: 'true',
    },
    /Approval expired or does not match this worker/,
  );
  await unchangedRejection(
    owned,
    'worker.cancel',
    { workerId: owned.worker.id, epoch: 'wrong' },
    /cancellation belongs to an earlier run/,
  );
  await unchangedRejection(
    owned,
    'worker.read',
    {
      workerId: owned.worker.id,
      path: 12,
      expectedRun: { runId: 'earlier_run', epoch: 0 },
    },
    /review belongs to an earlier task run/,
  );
  await owned.service.handle('worker.stop', { workerId: owned.worker.id, id: 'stop_1' });
  await unchangedRejection(
    owned,
    'worker.import',
    {
      workerId: owned.worker.id,
      text: null,
      reconcile: 'true',
      epoch: 'wrong',
    },
    /task is stopped.*old plan will not be replayed/,
  );
  await owned.service.quiesce();
  await assert.rejects(owned.service.handle('worker.import', null), /Host is shutting down/);
});

test('every Service result is validated by handle and dispatch without retries or success-shaped fallback', async (t) => {
  const owned = await fixture(t);
  let executions = 0;
  t.mock.method(owned.service, 'receive', async () => {
    executions++;
    return null;
  });

  for (const method of Object.keys(serviceRpcRegistry)) {
    const before = executions;
    await assert.rejects(owned.service.handle(method, {}), invalidResult);
    assert.equal(executions, before + 1);
    const response = await owned.service.dispatch({ id: 'request_1', method, params: {} });
    assert.equal(response.ok, false, method);
    assert.match(response.error, /invalid result/);
    assert.equal('result' in response, false);
    assert.equal(executions, before + 2);

    if (serviceRpcRegistry[method].mutation) {
      assert.match(response.error, /may already have completed.*Check saved state before repeating/);
    }
  }
});

test('a malformed acknowledgement after a real stop does not retry, roll back its fence, or overwrite its durable receipt', async (t) => {
  const owned = await fixture(t);
  const envelope = await importBatch(owned.service, owned.worker, [{ type: 'list', path: '.' }]);
  const stop = owned.service.interruptTask.bind(owned.service);
  let controls = 0;
  t.mock.method(owned.service, 'interruptTask', async (...args) => {
    controls++;
    const result = await stop(...args);
    return { ...result, epoch: 'malformed acknowledgement' };
  });

  const response = await owned.service.dispatch({
    id: 'stop_request',
    method: 'worker.stop',
    params: { workerId: owned.worker.id, id: 'stop_1' },
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /may already have completed/);
  assert.equal(controls, 1);
  assert.equal(owned.worker.control.mode, 'stopped');
  assert.equal(owned.worker.control.epoch, 1);
  assert.deepEqual(owned.worker.queue, []);
  const operation = readControlOperation(owned.store.get('miter.controlOperation.stop_1'), 'stop_1');
  assert.deepEqual(operation.result, { stopped: true, ready: false, epoch: 1, operationId: 'stop_1' });
  assert.equal(owned.store.get('miter.retiredQueue.stop_1').queue[0].id, envelope.id);
  t.mock.restoreAll();
  assert.deepEqual(
    await owned.service.handle('worker.stop', { workerId: owned.worker.id, id: 'stop_1' }),
    operation.result,
  );
  assert.equal(owned.worker.control.epoch, 1);
  await unchangedRejection(owned, 'worker.run', { workerId: owned.worker.id }, /task is stopped/);
});

test('import/start acknowledgement loss keeps exact byte/hash/run binding and does not replay admitted actions', async (t) => {
  const owned = await fixture(t);
  const envelope = await importBatch(owned.service, owned.worker, [
    {
      type: 'write',
      path: 'literal.txt',
      content: '\ufeffkept\r\n界 $&  ',
      expectedHash: 'missing',
    },
  ]);
  const start = owned.service.startDelivery.bind(owned.service);
  let starts = 0;
  t.mock.method(owned.service, 'startDelivery', (...args) => {
    starts++;
    start(...args);
    return { started: 'malformed acknowledgement' };
  });
  const params = { workerId: owned.worker.id, envelopeId: envelope.id, envelopeHash: envelopeHash(envelope) };
  const response = await owned.service.dispatch({ id: 'start_1', method: 'worker.run', params });
  assert.equal(response.ok, false);
  assert.match(response.error, /Check saved state before repeating/);
  assert.equal(starts, 1);
  await owned.service.wait(owned.worker.id);
  assert.equal(await fs.readFile(path.join(owned.root, 'literal.txt'), 'utf8'), envelope.actions[0].content);
  const receipt = owned.store.get(deliveryKey(envelope.id));
  assert.equal(receipt.started, true);
  assert.equal(receipt.hash, params.envelopeHash);
  assert.equal(receipt.runId, owned.worker.runId);
  const before = capture(owned);
  t.mock.restoreAll();
  const recovered = await owned.service.handle('worker.run', params);
  assert.equal(recovered.acknowledged, true);
  assert.equal(recovered.started, true);
  assert.deepEqual(capture(owned), before);
  assert.equal(owned.store.writes(owned.worker.runId).length, 1);
});

test('owner progress migrations survive registry admission and stopped saves keep their original failure priority', async (t) => {
  const owned = await fixture(t);
  const legacy = makeProgress(owned.worker, { phase: 12, reason: null, errorCode: 'obsolete' });
  const saved = await owned.service.handle('worker.bridgeSave', {
    workerId: owned.worker.id,
    progress: legacy,
  });
  assert.equal(saved.phase, 'stopped');
  assert.equal(saved.reason, 'Progress saved.');
  assert.equal(saved.errorCode, undefined);
  assert.equal(saved.revision, 1);
  assert.deepEqual(owned.store.get(progressKey(owned.worker.id)), JSON.parse(JSON.stringify(saved)));
  await owned.service.handle('worker.stop', { workerId: owned.worker.id, id: 'stop_progress' });
  await unchangedRejection(
    owned,
    'worker.bridgeSave',
    { workerId: owned.worker.id, progress: null, epoch: 0 },
    /stopped or earlier run/,
  );
});

test('tooling receipts validate complete terminal inspections and checked state restore identities', async (t) => {
  const hash = 'a'.repeat(64);
  const linux = { version: EXPECTED_VERSION, platform: 'linux', architecture: 'x64' };
  const helper = {
    helper: '/node-pty/spawn-helper',
    binding: '/node-pty/pty.node',
    modeBefore: '644',
    modeAfter: '744',
    sha256: hash,
    repaired: true,
    sharedInode: true,
    architecture: 'arm64',
  };
  const darwin = { version: EXPECTED_VERSION, platform: 'darwin', architecture: 'arm64', helper };
  assert.deepEqual(nativeTerminalCheckSchema.parse(linux), linux);
  assert.deepEqual(nativeTerminalCheckSchema.parse(darwin), darwin);

  for (const value of [
    { ...linux, version: 'unreviewed' },
    { ...linux, platform: '' },
    { ...linux, architecture: false },
    { ...linux, helper },
    { ...darwin, helper: undefined },
    { ...darwin, architecture: 'x64' },
    { ...darwin, helper: { ...helper, modeAfter: '888' } },
    { ...darwin, helper: { ...helper, sha256: 'missing' } },
  ]) {
    assert.equal(nativeTerminalCheckSchema.safeParse(value).success, false);
  }

  const backupId = 'state-20261011T123456789Z-12345678-1234-4123-8123-123456789abc';
  const receipt = { restored: backupId, rollback: backupId, projectFilesChanged: false };
  assert.deepEqual(stateRestoreResultSchema.parse(receipt), receipt);
  assert.deepEqual(stateRestoreResultSchema.parse({ restored: backupId, projectFilesChanged: false }), {
    restored: backupId,
    projectFilesChanged: false,
  });

  for (const changed of [
    { restored: '../database' },
    { rollback: 'state-invalid' },
    { projectFilesChanged: true },
  ]) {
    assert.equal(stateRestoreResultSchema.safeParse({ ...receipt, ...changed }).success, false);
  }

  const directory = await temporaryDirectory(t);
  await assert.rejects(restoreStateBackup(directory, '../backup', true), /Invalid backup ID/);
  await assert.rejects(restoreStateBackup(directory, backupId, 'true'), /Restore needs --confirm/);
  assert.deepEqual(await fs.readdir(directory), []);
  const store = memoryStore(t);
  await assert.rejects(createStateBackup(store.db, directory, ''), /Too small/);
  assert.deepEqual(await fs.readdir(directory), []);
});
