import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { coreRpcRegistry } from '../../protocol/src/rpc.ts';
import { callCoreRpc } from '../src/rpc.ts';

function invalidResult(method) {
  return (error) => {
    assert.equal(error.code, 'RPC_RESULT_INVALID');
    assert.equal(error.retryable, false);
    assert.equal(error.method, method);
    assert.ok(error.cause instanceof z.ZodError);
    return true;
  };
}

test('UI RPC validation covers every canonical core method and rejects unknown/null parameters before sending', async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };

  for (const method of Object.keys(coreRpcRegistry)) {
    await assert.rejects(callCoreRpc(rpc, method, null));
  }

  for (const method of ['unknown.method', 'constructor', '__proto__']) {
    await assert.rejects(callCoreRpc(rpc, method), /Unknown request method/);
  }

  await assert.rejects(callCoreRpc(rpc, 'worker.run', {}));
  await assert.rejects(
    callCoreRpc(rpc, 'worker.restoreFile', {
      workerId: 'worker',
      path: 'file.ts',
      expectedHash: 'missing',
      confirm: true,
    }),
  );
  assert.deepEqual(calls, []);
});

test('UI RPC validation preserves literal source and supplied defaults/authority without parsing the wire copy', async () => {
  const calls = [];
  const expectedRun = { runId: 'run', epoch: 7 };
  const params = {
    workerId: 'worker',
    expectedRun,
    epoch: 7,
    text: '\ufeff```json\r\n{"message":"😀"}\r\n```\r\n',
  };
  assert.deepEqual(
    await callCoreRpc(
      async (method, supplied) => {
        calls.push({ method, params: supplied });
        assert.equal(supplied, params);
        return { queued: true };
      },
      'worker.import',
      params,
    ),
    { queued: true },
  );
  assert.deepEqual(calls, [{ method: 'worker.import', params }]);
});

test('UI known read and mutation results are complete contracts rather than raw callback acknowledgements', async () => {
  const calls = [];
  const cases = [
    ['system.health', {}, { version: '1', database: { ok: true } }],
    ['system.backup', {}, { id: 'backup' }],
    [
      'system.verifyBackup',
      { id: 'state-20261011T123456789Z-11111111-1111-4111-8111-111111111111' },
      { verified: true },
    ],
    ['worker.files', { workerId: 'worker' }, [{ path: 'file.ts', status: 'applied' }]],
    ['worker.change', { workerId: 'worker', path: 'file.ts' }, { path: 'file.ts', canRestore: true }],
    [
      'worker.restoreFile',
      { workerId: 'worker', path: 'file.ts', expectedHash: 'a'.repeat(64), confirm: true },
      { restored: 1 },
    ],
    ['project.read', { projectId: 'project', path: 'file.ts' }, { content: 'Exact source' }],
    ['project.context', { projectId: 'project' }, { mission: 'Project goal' }],
    ['worker.teamMessage', { workerId: 'worker', id: 'message', message: 'Context' }, { ok: true }],
  ];

  for (const [method, params, malformed] of cases) {
    for (const result of [malformed, null]) {
      await assert.rejects(
        callCoreRpc(
          async (requested, supplied) => {
            calls.push({ method: requested, params: supplied });
            return result;
          },
          method,
          params,
        ),
        invalidResult(method),
      );
    }
  }

  assert.equal(calls.length, cases.length * 2);
});
