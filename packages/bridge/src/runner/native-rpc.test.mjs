import assert from 'node:assert/strict';
import { test } from 'node:test';
import './test-source-loader.mjs';

const { z } = await import('zod');
const { coreRpcRegistry, isRpcMethod, RpcResultValidationError, parseRpcParams } =
  await import('../../../protocol/src/rpc.ts');
const { bridgeRpcRegistry, requestBridgeRpc } = await import('./rpc-results.ts');
const { taskProgressSchema } = await import('../progress.ts');
const { savedBridgeProgressLoadSchema } = await import('./progress-load.ts');
const { NativeRequestTimeout } = await import('../native-request.ts');

const identity = { workerId: 'worker_1', epoch: 7 };
const delivery = { ...identity, envelopeId: 'reply_1', envelopeHash: 'a'.repeat(64) };
const source = '\ufeffconst text = "😀";\r\n';
const text =
  '  ' +
  JSON.stringify({
    protocol: 'mitter/1',
    id: 'reply_1',
    workerId: identity.workerId,
    projectId: 'project_1',
    summary: 'Preserve source',
    actions: [{ type: 'write', path: 'source.js', content: source, base: 'missing' }],
  }) +
  '\r\n ';

function assertDescribed(schema) {
  assert.ok(schema.description?.trim());
  if (schema instanceof z.ZodObject) {
    for (const [name, field] of Object.entries(schema.shape)) {
      assert.ok(field.description?.trim(), name);
    }
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      assertDescribed(option);
    }
  }
}

test('bridge progress composes the canonical registry without copying core contracts', () => {
  for (const [method, contract] of Object.entries(coreRpcRegistry)) {
    assert.equal(bridgeRpcRegistry[method], contract);
  }
  assert.equal(bridgeRpcRegistry['worker.bridgeLoad'].result, savedBridgeProgressLoadSchema);
  assert.equal(bridgeRpcRegistry['worker.bridgeSave'].result, taskProgressSchema);
  assert.equal(bridgeRpcRegistry['worker.bridgeExtend'].result, taskProgressSchema);
  assert.equal(isRpcMethod(bridgeRpcRegistry, 'worker.bridgeSave'), true);
  assert.equal(isRpcMethod(bridgeRpcRegistry, 'toString'), false);
  for (const contract of Object.values(bridgeRpcRegistry)) {
    assertDescribed(contract.params);
    assertDescribed(contract.result);
  }
});

test('outgoing validation preserves original wire fields, exact envelope/source bytes and reviewed bindings', async () => {
  const params = Object.freeze({
    ...identity,
    text,
    reconcile: true,
    expectedRun: Object.freeze({ runId: 'reviewed_run', epoch: 7 }),
    forwarderMetadata: 'Retain this original wire field.',
  });
  let calls = 0;
  const receipt = Object.freeze({ queued: true });
  const result = await requestBridgeRpc(
    async (method, sent) => {
      calls++;
      assert.equal(method, 'worker.import');
      assert.equal(sent, params);
      assert.equal(sent.text, text);
      assert.equal(JSON.parse(sent.text).actions[0].content, source);
      assert.equal(sent.expectedRun, params.expectedRun);
      assert.equal(sent.forwarderMetadata, params.forwarderMetadata);
      return receipt;
    },
    'worker.import',
    params,
  );
  assert.deepEqual(result, receipt);
  assert.equal(calls, 1);
});

test('host-owned defaults and normalization are inspected but never substituted into requests', async () => {
  const prompt = Object.freeze({ workerId: identity.workerId });
  assert.equal(parseRpcParams(bridgeRpcRegistry, 'worker.prompt', prompt).kind, 'bootstrap');
  assert.equal(
    await requestBridgeRpc(
      async (method, sent) => {
        assert.equal(method, 'worker.prompt');
        assert.equal(sent, prompt);
        assert.equal(Object.hasOwn(sent, 'kind'), false);
        return '  exact pending prompt\r\n😀\ufeff';
      },
      'worker.prompt',
      prompt,
    ),
    '  exact pending prompt\r\n😀\ufeff',
  );

  const profile = Object.freeze({
    projectId: 'project_1',
    profile: Object.freeze({
      id: 'check',
      label: 'Check',
      program: 'node',
      args: ['checked.js'],
      timeoutMs: null,
    }),
  });
  assert.equal(parseRpcParams(bridgeRpcRegistry, 'project.profile', profile).profile.timeoutMs, 120000);
  const failure = new Error('Host policy refused.');
  await assert.rejects(
    requestBridgeRpc(
      async (method, sent) => {
        assert.equal(method, 'project.profile');
        assert.equal(sent, profile);
        assert.equal(sent.profile, profile.profile);
        assert.equal(sent.profile.timeoutMs, null);
        throw failure;
      },
      'project.profile',
      profile,
    ),
    (error) => error === failure,
  );
});

test('malformed native requests fail before dispatch rather than becoming normalized authority', async (context) => {
  for (const [method, params] of [
    ['worker.import', { ...identity, text, epoch: null, reconcile: true }],
    ['worker.import', { ...identity, text, reconcile: 'true' }],
    ['worker.run', { ...identity, envelopeId: delivery.envelopeId }],
    ['worker.run', { ...delivery, epoch: Number.MAX_SAFE_INTEGER + 1 }],
    ['worker.resume', { ...identity, workerId: 'invalid worker' }],
    ['worker.pause', { ...identity, expectedRun: { runId: 'reviewed_run', epoch: -1 } }],
    ['worker.prompt', { workerId: identity.workerId, kind: null }],
    ['state', null],
    ['worker.missing', {}],
  ]) {
    await context.test(method, async () => {
      let calls = 0;
      await assert.rejects(
        requestBridgeRpc(
          async () => {
            calls++;
            throw new Error('An invalid request reached native dispatch.');
          },
          method,
          params,
        ),
      );
      assert.equal(calls, 0);
    });
  }
});

for (const [method, params, receipts] of [
  [
    'worker.import',
    { ...identity, text, reconcile: true },
    [{ queued: true }, { queued: true, acknowledged: true }, { queued: false, acknowledged: true }],
  ],
  [
    'worker.run',
    delivery,
    [
      { started: true },
      { started: true, acknowledged: true, state: 'complete' },
      { started: true, acknowledged: true, state: 'paused' },
    ],
  ],
  ['worker.resume', identity, [{ started: true }]],
  [
    'worker.pause',
    identity,
    [
      { stopping: true },
      { stopping: false },
      { stopping: false, completed: true },
      { stopping: false, review: true },
    ],
  ],
]) {
  test(method + ' accepts real host receipt variants without changing their meaning', async () => {
    for (const receipt of receipts) {
      let calls = 0;
      assert.deepEqual(
        await requestBridgeRpc(
          async () => {
            calls++;
            return Object.freeze(receipt);
          },
          method,
          params,
        ),
        receipt,
      );
      assert.equal(calls, 1);
    }
  });

  test(method + ' rejects malformed, null, and wrong-variant receipts without retrying', async () => {
    for (const receipt of [
      undefined,
      null,
      {},
      { denied: true },
      { started: false },
      { queued: false },
      { stopping: 'false' },
    ]) {
      let calls = 0;
      await assert.rejects(
        requestBridgeRpc(
          async () => {
            calls++;
            return receipt;
          },
          method,
          params,
        ),
        (error) => {
          assert.ok(error instanceof RpcResultValidationError);
          assert.equal(error.method, method);
          assert.equal(error.code, 'RPC_RESULT_INVALID');
          assert.equal(error.retryable, false);
          assert.ok(error.cause instanceof z.ZodError);
          assert.match(error.message, /may already have completed/);
          assert.equal(error.message.includes('"stopping"'), false);
          return true;
        },
      );
      assert.equal(calls, 1);
    }
  });
}

test('native policy errors and typed timeouts retain their original identity and codes', async () => {
  const refused = new Error('Approval is required.');
  refused.code = 'APPROVAL_REQUIRED';
  for (const failure of [refused, new NativeRequestTimeout('worker.import')]) {
    let calls = 0;
    await assert.rejects(
      requestBridgeRpc(
        async () => {
          calls++;
          throw failure;
        },
        'worker.import',
        { ...identity, text, reconcile: true },
      ),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
  }
});
