import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { HostClient } from '../../src/client.ts';
import { NativeHost } from '../../src/transport/native-host.ts';
import { rpcRequestSchema, rpcResponseSchema, workspaceStateSchema } from '../../src/schemas/messages.ts';
import { assetChunkSchema } from '../../src/schemas/preview.ts';
import { responseSchema } from '../../../../packages/protocol/src/index.ts';
import { WorkspaceStateSchema, emptyWorkspace } from '../../../../packages/ui/src/workspace.ts';
import { PreviewChunkSchema } from '../../../../packages/ui/src/preview/schemas.ts';
import { mockPort, assetChunk } from './chrome-mock.mjs';

function hostClient(context) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const ports = [];
  globalThis.chrome = {
    runtime: {
      connect() {
        const port = mockPort('mitter-ui');
        ports.push(port);
        return port;
      },
    },
  };
  const client = new HostClient(
    () => {},
    () => {},
  );
  context.after(() => client.close());
  return { client, ports };
}

test('extension envelopes reuse shared contracts without accepting null view parameters', () => {
  assert.equal(rpcResponseSchema, responseSchema);
  assert.equal(workspaceStateSchema, WorkspaceStateSchema);
  assert.equal(assetChunkSchema.shape.data, PreviewChunkSchema.shape.data);
  assert.deepEqual(assetChunkSchema.parse(assetChunk), assetChunk);

  for (const params of [null, undefined, [], 1, 'parameters']) {
    assert.equal(rpcRequestSchema.safeParse({ id: 'request', method: 'worker.run', params }).success, false);
  }

  const workspace = {
    ...emptyWorkspace(),
    recentlyClosed: [
      {
        key: 'key',
        group: 'group',
        kind: 'task',
        id: 'task',
        projectId: 'project',
        label: 'Task',
        index: 0,
        closedAt: -1,
      },
    ],
  };
  assert.equal(workspaceStateSchema.safeParse(workspace).success, false);
});

test('malformed view request envelopes cannot connect, send, or schedule a replay', async (context) => {
  const { client, ports } = hostClient(context);

  for (const params of [null, [], 'parameters']) {
    await assert.rejects(client.request('worker.run', params), z.ZodError);
  }

  for (const method of ['', ' ', 'x'.repeat(101)]) {
    await assert.rejects(client.request(method, {}), z.ZodError);
  }

  context.mock.timers.tick(60000);
  assert.deepEqual(ports, []);
});

test('default view requests validate known results and retain diagnostics without replaying', async (context) => {
  const { client, ports } = hostClient(context);
  const cases = [
    ['notifications.get', {}, { enabled: true }],
    ['workspace.read', {}, { ...emptyWorkspace(), revision: null }],
    ['worker.files', { workerId: 'worker' }, [{ path: 'source.ts', status: 'applied', bytes: '12' }]],
    ['worker.create', { projectId: 'project', mode: 'handoff', goal: 'A task goal.' }, { id: 'worker' }],
    ['worker.prompt', { workerId: 'worker' }, null],
    ['worker.asset', { workerId: 'worker', path: 'index.html' }, { ...assetChunk, stamp: 'not-sha256' }],
    ['bridge.lastPrompt', { workerId: 'worker' }, false],
    [
      'bridge.resend',
      {
        workerId: 'worker',
        expectedRun: { runId: 'run', epoch: 7 },
        confirm: true,
        expectedPrompt: 'Exact prompt',
      },
      { sent: 'true' },
    ],
  ];

  for (const [method, params, result] of cases) {
    const pending = client.request(method, params);
    const port = ports[0];
    const request = port.messages.at(-1);
    port.onMessage.emit({ id: request.id, ok: true, result });
    await assert.rejects(pending, (error) => {
      assert.ok(error.cause instanceof z.ZodError);
      assert.equal(error.code, 'RPC_RESULT_INVALID');
      assert.equal(error.retryable, false);
      assert.equal(error.method, method);
      assert.equal(error.message.includes('"code"'), false);
      return true;
    });
  }

  assert.equal(ports.length, 1);
  assert.equal(ports[0].messages.length, cases.length);
  const valid = client.request('notifications.get');
  ports[0].onMessage.emit({
    id: ports[0].messages.at(-1).id,
    ok: true,
    result: { enabled: false, sound: true },
  });
  assert.deepEqual(await valid, { enabled: false, sound: true });
});

test('native envelope validation precedes connection and preserves the exact method for reset admission', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const ports = [];
  const admissions = [];
  globalThis.chrome = {
    runtime: {
      connectNative() {
        const port = mockPort('native');
        ports.push(port);
        return port;
      },
    },
  };
  const host = new NativeHost({
    allow(method) {
      admissions.push(method);
      return false;
    },
    snapshot() {},
    resetRequired() {},
    disconnected() {},
    log() {},
  });
  context.after(() => host.dispose());
  await assert.rejects(host.request('', {}), z.ZodError);
  await assert.rejects(host.request('worker.run', []), z.ZodError);
  assert.deepEqual(admissions, []);
  await assert.rejects(host.request(' terminal.write ', { data: 'exact input' }), /Unknown request method/);
  assert.deepEqual(admissions, []);
  await assert.rejects(
    host.request('terminal.write', { clientId: 'view', sessionId: 'session', data: 'exact input' }),
    /No task operation/,
  );
  assert.deepEqual(admissions, ['terminal.write']);
  assert.deepEqual(ports, []);
});
