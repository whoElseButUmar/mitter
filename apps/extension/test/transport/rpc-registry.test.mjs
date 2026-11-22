import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  coreRpcRegistry,
  isRpcMethod,
  parseRpcParams,
  parseRpcResult,
} from '../../../../packages/protocol/src/rpc.ts';
import { taskProgressSchema } from '../../../../packages/bridge/src/progress.ts';
import { bridgeProgressLoadSchema } from '../../../../packages/bridge/src/runner/progress-load.ts';
import { HostClient } from '../../src/client.ts';
import { NativeHost } from '../../src/transport/native-host.ts';
import { parseNativeResult } from '../../src/transport/native-results.ts';
import { nativeRpcRegistry, progressRpcRegistry, resetRpcRegistry } from '../../src/schemas/native-rpc.ts';
import {
  forwardedMethods,
  forwardedRpcRegistry,
  viewRpcRegistry,
  parseViewResult,
} from '../../src/schemas/view-rpc.ts';
import { localRpcRegistry, parseLocalResult } from '../../src/schemas/local-results.ts';
import {
  terminalRpcRegistry,
  nativeTerminalRpcRegistry,
  parseTerminalResult,
} from '../../src/schemas/terminal.ts';
import { mockPort, answerViewHandshake } from './chrome-mock.mjs';

const forwarded = [
  'state',
  'system.health',
  'system.readiness',
  'worker.previewStatus',
  'project.appRuns',
  'worker.previewStart',
  'worker.previewStop',
  'system.backups',
  'system.backup',
  'system.verifyBackup',
  'project.context',
  'project.add',
  'project.create',
  'project.rename',
  'project.pickFolder',
  'project.reveal',
  'project.read',
  'workflow.list',
  'workflow.record',
  'workflow.expect',
  'workflow.save',
  'workflow.cancel',
  'workflow.replay',
  'workflow.delete',
  'project.profile',
  'worker.change',
  'worker.restoreFile',
  'worker.syntax',
  'worker.reveal',
  'worker.read',
  'worker.browse',
  'worker.asset',
  'worker.openFile',
  'worker.team',
  'worker.teamMessage',
  'worker.followups',
  'worker.followupCancel',
  'worker.create',
  'worker.rename',
  'worker.run',
  'worker.resume',
  'worker.pause',
  'worker.cancel',
  'worker.approve',
  'worker.setupDecision',
  'worker.skip',
  'worker.rollback',
  'worker.accept',
  'worker.prompt',
  'worker.report',
  'worker.history',
  'worker.import',
  'worker.files',
  'worker.handoffSeen',
  'settings.update',
];
const local = [
  'bridge.start',
  'bridge.stopStarted',
  'bridge.resume',
  'bridge.continuePending',
  'bridge.extend',
  'bridge.resend',
  'bridge.lastPrompt',
  'bridge.halt',
  'bridge.steer',
  'bridge.continueFresh',
  'bridge.pause',
  'bridge.stop',
  'bridge.replyPreview',
  'bridge.replyApply',
  'bridge.list',
  'bridge.lastChat',
  'bridge.tabs',
  'bridge.newChat',
  'bridge.openChat',
  'rewrite.start',
  'rewrite.read',
  'rewrite.cancel',
  'workspace.read',
  'workspace.action',
  'notifications.get',
  'notifications.set',
  'debug.read',
  'debug.clear',
  'worker.followup',
  'worker.followupStart',
];
const nativeOnly = [
  'worker.steerValidate',
  'worker.stop',
  'worker.steer',
  'worker.continueFresh',
  'worker.followup',
  'worker.followupActivate',
  'worker.validateReply',
];
const progress = ['worker.bridgeLoad', 'worker.bridgeSave', 'worker.bridgeExtend'];
const terminal = [
  'terminal.list',
  'terminal.create',
  'terminal.attach',
  'terminal.read',
  'terminal.write',
  'terminal.resize',
  'terminal.close',
  'terminal.release',
];
const reset = ['system.resetPrepare', 'system.reset', 'system.resetComplete'];

function matchesMethods(registry, methods) {
  assert.deepEqual(Object.keys(registry).sort(), [...methods].sort());
}

function invalidResult(method) {
  return (error) => {
    assert.equal(error.code, 'RPC_RESULT_INVALID');
    assert.equal(error.retryable, false);
    assert.equal(error.method, method);
    assert.ok(error.cause instanceof z.ZodError);
    assert.equal(error.message.includes('"code"'), false);
    return true;
  };
}

function clients(context) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const nativePorts = [];
  const viewPorts = [];
  const admissions = [];
  globalThis.chrome = {
    runtime: {
      connectNative() {
        const port = mockPort('native');
        nativePorts.push(port);
        return port;
      },
      connect() {
        const port = mockPort('mitter-ui');
        answerViewHandshake(port);
        viewPorts.push(port);
        return port;
      },
    },
  };
  const host = new NativeHost({
    allow(method) {
      admissions.push(method);
      return true;
    },
    snapshot() {},
    resetRequired() {},
    disconnected() {},
    log() {},
  });
  const client = new HostClient(
    () => {},
    () => {},
  );
  context.after(() => {
    host.dispose();
    client.close();
  });
  return { host, client, nativePorts, viewPorts, admissions };
}

test('every accepted method has an explicit owner contract without widening view privileges', () => {
  matchesMethods(forwardedRpcRegistry, forwarded);
  assert.deepEqual([...forwardedMethods].sort(), [...forwarded].sort());
  matchesMethods(localRpcRegistry, local);
  matchesMethods(viewRpcRegistry, [...forwarded, ...local]);
  matchesMethods(coreRpcRegistry, [...forwarded, ...nativeOnly]);
  matchesMethods(progressRpcRegistry, [...forwarded, ...nativeOnly, ...progress]);
  matchesMethods(terminalRpcRegistry, terminal);
  matchesMethods(nativeTerminalRpcRegistry, [...terminal, 'terminal.disconnect']);
  matchesMethods(resetRpcRegistry, reset);
  matchesMethods(nativeRpcRegistry, [
    ...forwarded,
    ...nativeOnly,
    ...progress,
    ...terminal,
    'terminal.disconnect',
    'terminal.claim',
    'terminal.complete',
    ...reset,
  ]);

  for (const method of forwarded) {
    assert.equal(forwardedRpcRegistry[method].result, coreRpcRegistry[method].result);

    if (method !== 'worker.restoreFile' && method !== 'worker.rollback') {
      assert.equal(forwardedRpcRegistry[method].params, coreRpcRegistry[method].params);
    }
  }

  assert.equal(localRpcRegistry['worker.followup'], coreRpcRegistry['worker.followup']);
  assert.equal(
    progressRpcRegistry['worker.bridgeSave'].params.shape.progress.description,
    'The complete owner-validated progress, including supported migrations.',
  );
  assert.equal(progressRpcRegistry['worker.bridgeSave'].result, taskProgressSchema);
  assert.equal(progressRpcRegistry['worker.bridgeLoad'].result, bridgeProgressLoadSchema);

  for (const method of [
    ...nativeOnly.filter((method) => method !== 'worker.followup'),
    ...progress,
    ...terminal,
    ...reset,
  ]) {
    assert.equal(isRpcMethod(viewRpcRegistry, method), false);
  }
});

for (const [name, registry, parseResult] of [
  ['native', nativeRpcRegistry, parseNativeResult],
  ['view', viewRpcRegistry, parseViewResult],
  ['local', localRpcRegistry, parseLocalResult],
  ['terminal', terminalRpcRegistry, parseTerminalResult],
]) {
  test(name + ' validates all enumerated results and rejects unknown/prototype method fallbacks', () => {
    for (const [method, contract] of Object.entries(registry)) {
      assert.ok(contract.params instanceof z.ZodType);
      assert.ok(contract.result instanceof z.ZodType);
      assert.throws(() => parseRpcParams(registry, method, null));
      assert.throws(() => parseResult(method, undefined), invalidResult(method));

      if (method === 'bridge.lastChat') {
        assert.equal(parseResult(method, null), null);
      } else {
        assert.throws(() => parseResult(method, null), invalidResult(method));
      }
    }

    for (const method of ['unknown.method', 'constructor', 'toString', '__proto__']) {
      assert.equal(isRpcMethod(registry, method), false);
      assert.throws(() => parseRpcParams(registry, method, {}), /Unknown request method/);
      assert.throws(() => parseResult(method, { ok: true }), /Unknown request method/);
    }
  });
}

test('malformed known parameters and unsupported caller-schema requests cannot admit, connect, send, or replay', async (context) => {
  const { host, client, nativePorts, viewPorts, admissions } = clients(context);
  const malformed = [
    ['worker.run', {}],
    ['worker.import', { workerId: 'worker', text: null }],
    ['worker.approve', { workerId: 'worker', token: 'approval', approve: 'true' }],
    ['worker.read', { workerId: 'worker', path: null }],
    ['project.context', { projectId: 'project', save: 'true' }],
    ['worker.teamMessage', { workerId: 'worker', id: 'message', message: 'Exact context', to: null }],
    [
      'worker.followup',
      { workerId: 'worker', request: { id: 'followup', instruction: 'Next', autoStart: null } },
    ],
  ];

  for (const [method, params] of malformed) {
    for (const transport of [host, client]) {
      await assert.rejects(transport.request(method, params, z.unknown()), (error) => {
        assert.ok(error.cause instanceof z.ZodError);
        return true;
      });
    }
  }

  for (const method of ['unknown.method', 'constructor', '__proto__']) {
    await assert.rejects(host.request(method, {}, z.unknown()), /Unknown request method/);
    await assert.rejects(client.request(method, {}, z.unknown()), /Unknown request method/);
  }

  for (const method of [
    'worker.stop',
    'worker.bridgeLoad',
    'worker.bridgeSave',
    'terminal.create',
    'system.reset',
  ]) {
    await assert.rejects(client.request(method, {}, z.unknown()), /Unknown request method/);
  }

  context.mock.timers.tick(180000);
  assert.deepEqual(admissions, []);
  assert.deepEqual(nativePorts, []);
  assert.deepEqual(viewPorts, []);
});

const malformedAcknowledgements = [
  ['project.context', { projectId: 'project', save: true }, { mission: 'Saved' }],
  [
    'project.read',
    { projectId: 'project', path: 'file.ts' },
    { path: 'file.ts', hash: 'a'.repeat(64), text: 'source' },
  ],
  ['worker.read', { workerId: 'worker', path: 'file.ts' }, { path: 'file.ts', content: 'source' }],
  ['worker.team', { workerId: 'worker' }, { peers: [{ name: 'Incomplete', state: 'paused' }], messages: [] }],
  ['worker.teamMessage', { workerId: 'worker', id: 'message', message: 'Exact context' }, { ok: true }],
  ['worker.import', { workerId: 'worker', text: 'Exact handoff' }, { queued: false }],
  ['worker.run', { workerId: 'worker' }, { started: true, acknowledged: true }],
  ['worker.approve', { workerId: 'worker', token: 'approval', approve: true }, { approved: false }],
  ['worker.followupCancel', { workerId: 'worker', id: 'followup' }, { cancelled: 'true' }],
];

for (const boundary of ['native', 'view']) {
  test(
    boundary + ' complete known acknowledgements cannot be bypassed by a caller schema or replayed',
    async (context) => {
      const { host, client, nativePorts, viewPorts } = clients(context);
      let transport = host;
      let ports = nativePorts;

      if (boundary === 'view') {
        transport = client;
        ports = viewPorts;
      }

      let sent = 0;

      for (const [method, params, malformed] of malformedAcknowledgements) {
        for (const result of [malformed, null]) {
          const pending = transport.request(method, params, z.unknown());
          const port = ports[0];
          const request = port.messages.at(-1);
          sent += 1;
          port.onMessage.emit({ id: request.id, ok: true, result });
          await assert.rejects(pending, invalidResult(method));
          port.onMessage.emit({
            id: request.id,
            ok: true,
            result: { ok: true, note: 'Late acknowledgement' },
          });
          assert.equal(port.messages.length, sent);
        }
      }

      host.dispose();
      client.close();
      context.mock.timers.tick(180000);
      assert.equal(ports.length, 1);
      assert.equal(ports[0].messages.length, sent);
    },
  );
}

for (const boundary of ['native', 'view']) {
  test(
    boundary +
      ' validation preserves original supplied defaults, source bytes, and run/epoch authority on the wire',
    async (context) => {
      const { host, client, nativePorts, viewPorts } = clients(context);
      let transport = host;
      let ports = nativePorts;

      if (boundary === 'view') {
        transport = client;
        ports = viewPorts;
      }

      const expectedRun = { runId: 'reviewed-run', epoch: 7 };
      const text = '\ufeff```json\r\n{"message":"😀"}\r\n```\r\n';
      const followup = { id: 'followup', instruction: '  Keep exact source.  ' };
      const cases = [
        ['worker.prompt', { workerId: 'worker', expectedRun, callerField: 'preserved' }, 'Exact prompt'],
        ['worker.browse', { workerId: 'worker' }, { root: '/project', files: [] }],
        [
          'project.context',
          { projectId: 'project', save: true, conventions: null },
          { mission: '', conventions: '' },
        ],
        [
          'worker.import',
          { workerId: 'worker', expectedRun, epoch: 7, text, reconcile: false },
          { queued: true },
        ],
        [
          'worker.run',
          { workerId: 'worker', expectedRun, epoch: 7, envelopeId: 'batch', envelopeHash: 'a'.repeat(64) },
          { started: true },
        ],
        [
          'worker.followup',
          { workerId: 'worker', expectedRun, request: followup },
          {
            ...followup,
            instruction: 'Keep exact source.',
            autoStart: true,
            workerId: 'worker',
            status: 'queued',
            createdAt: 0,
            baseRunId: expectedRun.runId,
          },
        ],
      ];

      for (const [method, params, result] of cases) {
        const pending = transport.request(method, params);
        const port = ports[0];
        const request = port.messages.at(-1);
        assert.deepEqual(request.params, params);
        assert.equal(request.params, params);
        port.onMessage.emit({ id: request.id, ok: true, result });
        assert.deepEqual(await pending, parseRpcResult(viewRpcRegistry, method, result));
      }

      assert.equal(ports.length, 1);
      assert.equal(ports[0].messages.length, cases.length);
    },
  );
}

test('the local pending method validates input and discriminated receipts without native privilege or replay', async (context) => {
  const { host, client, nativePorts, viewPorts, admissions } = clients(context);
  const reviewed = { workerId: 'worker', expectedRun: { runId: 'run', epoch: 7 } };

  for (const params of [{}, { ...reviewed, expectedRun: null }, { ...reviewed, epoch: 8 }]) {
    await assert.rejects(client.request('bridge.continuePending', params, z.unknown()));
  }

  await assert.rejects(host.request('bridge.continuePending', reviewed), /Unknown request method/);
  await assert.rejects(client.request('worker.bridgeLoad', { workerId: 'worker' }), /Unknown request method/);
  assert.deepEqual(admissions, []);
  assert.deepEqual(nativePorts, []);
  assert.deepEqual(viewPorts, []);

  const malformed = [
    null,
    { started: true },
    { kind: 'local', result: { started: true, extra: true } },
    { kind: 'chat', result: { resumed: true, status: null } },
  ];

  for (const result of malformed) {
    const pending = client.request('bridge.continuePending', reviewed, z.unknown());
    const port = viewPorts[0];
    const request = port.messages.at(-1);
    port.onMessage.emit({ id: request.id, ok: true, result });
    await assert.rejects(pending, invalidResult('bridge.continuePending'));
    port.onMessage.emit({ id: request.id, ok: true, result: { kind: 'local', result: { started: true } } });
  }

  const params = { ...reviewed, epoch: 7, callerField: 'Retain original parameters' };
  const pending = client.request('bridge.continuePending', params);
  const port = viewPorts[0];
  const request = port.messages.at(-1);
  assert.equal(request.params, params);
  port.onMessage.emit({ id: request.id, ok: true, result: { kind: 'local', result: { started: true } } });
  assert.deepEqual(await pending, { kind: 'local', result: { started: true } });
  client.close();
  context.mock.timers.tick(180000);
  assert.equal(viewPorts.length, 1);
  assert.equal(port.messages.length, malformed.length + 1);
  assert.deepEqual(nativePorts, []);
});

test('native-only control and terminal receipts require complete acknowledgements without replay', async (context) => {
  const { host, nativePorts } = clients(context);
  const cases = [
    ['worker.stop', { workerId: 'worker', id: 'stop' }, { stopped: true }],
    [
      'worker.steerValidate',
      { workerId: 'worker', request: { id: 'steer', instruction: 'Next' } },
      { valid: true },
    ],
    ['worker.followupActivate', { workerId: 'worker' }, { activated: true }],
    ['terminal.write', { clientId: 'view', sessionId: 'session', data: '\r\n😀' }, { written: 'true' }],
    ['terminal.resize', { clientId: 'view', sessionId: 'session', cols: 80, rows: 24 }, null],
  ];

  for (const [method, params, result] of cases) {
    const pending = host.request(method, params);
    const port = nativePorts[0];
    const request = port.messages.at(-1);
    port.onMessage.emit({ id: request.id, ok: true, result });
    await assert.rejects(pending, invalidResult(method));
  }

  host.dispose();
  context.mock.timers.tick(180000);
  assert.equal(nativePorts.length, 1);
  assert.equal(nativePorts[0].messages.length, cases.length);
});
