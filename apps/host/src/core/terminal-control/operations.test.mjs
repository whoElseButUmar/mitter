import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, makeProgress } from '../service/test-fixture.mjs';
import { printStatus } from '../../cli/output.ts';
import { TerminalOperations } from './operations.ts';
import { APP_VERSION, BUILD_ID } from '../../../../../packages/protocol/src/index.ts';

function request(method, params) {
  return { version: 1, id: randomUUID(), token: 'a'.repeat(64), method, params };
}

function start(root, overrides = {}) {
  return {
    requestId: randomUUID(),
    projectPath: root,
    createProject: false,
    goal: 'Build an equipment reservation app with conflicts, filters and persistent bookings.',
    maxTurns: 10,
    maxMinutes: 30,
    consent: true,
    ...overrides,
  };
}

function relay(overrides = {}) {
  return { sessionId: randomUUID(), version: APP_VERSION, available: true, ...overrides };
}

test('an absent or outdated browser prevents project and task effects', async (context) => {
  const { service, root } = await fixture(context);
  const operations = new TerminalOperations(service);
  const projectPath = path.join(path.dirname(root), 'new-project');
  const before = service.workers.size;
  const result = await operations.dispatch(request('start', start(projectPath, { createProject: true })));
  assert.equal(result.state, 'failed');
  assert.match(result.error, /terminal connection is not ready/);
  assert.equal(service.workers.size, before);
  await assert.rejects(fs.stat(projectPath), { code: 'ENOENT' });
  await assert.rejects(operations.claim(relay({ version: 'old-version' })), /Reload/);
  const list = await operations.dispatch(request('list', {}));
  assert.equal(list.browserConnected, false);
  assert.deepEqual(list.browserVersionMismatch, {
    extensionVersion: 'old-version',
    hostVersion: APP_VERSION,
    hostBuildId: BUILD_ID,
  });
  const mismatch = await operations.dispatch(request('start', start(projectPath, { createProject: true })));
  assert.equal(mismatch.state, 'failed');
  assert.ok(mismatch.error.includes('old-version') && mismatch.error.includes(APP_VERSION));
  assert.equal(service.workers.size, before);
  await assert.rejects(fs.stat(projectPath), { code: 'ENOENT' });
});

test('a relay for different source at the same version cannot claim or admit a new task', async (context) => {
  const { service, root } = await fixture(context);
  const operations = new TerminalOperations(service);
  const current = relay({ buildId: BUILD_ID });
  await operations.claim(current);
  const before = service.workers.size;
  const incompatible = { ...current, buildId: '0123456789abcdef' };
  await assert.rejects(operations.claim(incompatible), /0123456789abcdef.*Reload/);
  const status = await operations.dispatch(request('list', {}));
  assert.equal(status.browserConnected, false);
  assert.equal(status.browserVersionMismatch.extensionBuildId, incompatible.buildId);
  const result = await operations.dispatch(request('start', start(root)));
  assert.equal(result.state, 'failed');
  assert.equal(service.workers.size, before);
  await operations.claim(current);
  assert.equal((await operations.dispatch(request('list', {}))).browserConnected, true);
});

test('a version mismatch expires, clears on a matching poll and leaves a healthy owner in place', async (context) => {
  const { service, root } = await fixture(context);
  let now = 1;
  const operations = new TerminalOperations(service, () => now);
  const wrong = relay({ version: 'old-version' });
  const current = relay();
  const list = () => operations.dispatch(request('list', {}));
  await assert.rejects(operations.claim(wrong), /Reload/);
  now += 60_001;
  assert.equal((await list()).browserVersionMismatch, undefined);
  await assert.rejects(operations.claim(wrong), /Reload/);
  await operations.claim(current);
  now += 5_001;
  assert.equal((await list()).browserVersionMismatch, undefined);
  await operations.claim(current);
  const input = start(root);
  await operations.dispatch(request('start', input));
  const { command } = await operations.claim(current);
  await assert.rejects(operations.claim(wrong), /Reload/);
  const healthy = await list();
  assert.equal(healthy.browserConnected, true);
  assert.equal(healthy.browserVersionMismatch, undefined);
  const accepted = await operations.complete({
    sessionId: current.sessionId,
    requestId: input.requestId,
    claimToken: command.claimToken,
    ok: true,
  });
  assert.equal(accepted.recorded, true);
});

test('one durable start is bound to exact input and creates one task under concurrent retries', async (context) => {
  const { service, root, store } = await fixture(context);
  const operations = new TerminalOperations(service);
  await operations.claim(relay());
  const input = start(root);
  const before = service.workers.size;
  const results = await Promise.all([
    operations.dispatch(request('start', input)),
    operations.dispatch(request('start', input)),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].state, 'queued');
  assert.equal(service.workers.size, before + 1);
  assert.equal(service.projects.size, 1);
  assert.equal(service.workers.get(results[0].workerId).autoCommands, false);
  await assert.rejects(
    operations.dispatch(request('start', { ...input, goal: input.goal + ' Changed.' })),
    /different operation/,
  );
  const saved = store.get('miter.terminal.operation.' + input.requestId);
  assert.equal(saved.input.goal, input.goal);
  assert.equal(saved.operation.workerId, results[0].workerId);
});

test('a terminal launch prompt creates a local worker and claims its exact run once', async (context) => {
  const { service, root } = await fixture(context);
  const operations = new TerminalOperations(service);
  const session = relay();
  await operations.claim(session);
  const input = start(root, {
    goal: 'Install dependencies with pnpm, start the dev server, and open the app preview.',
  });
  const operation = await operations.dispatch(request('start', input));
  const { command } = await operations.claim(session);
  assert.equal(service.workers.get(operation.workerId).mode, 'local');
  assert.equal(command.localPreview, true);
  assert.deepEqual(command.expectedRun, operation.expectedRun);
  assert.deepEqual(await operations.claim(session), { command: null });
});

test('new folders need explicit creation consent and parents must already exist', async (context) => {
  const { service, root } = await fixture(context);
  const operations = new TerminalOperations(service);
  await operations.claim(relay());
  const projectPath = path.join(path.dirname(root), 'new-project');
  const refused = await operations.dispatch(request('start', start(projectPath)));
  assert.equal(refused.state, 'failed');
  await assert.rejects(fs.stat(projectPath), { code: 'ENOENT' });
  const missingParent = await operations.dispatch(
    request('start', start(path.join(projectPath, 'nested'), { createProject: true })),
  );
  assert.equal(missingParent.state, 'failed');
  const created = await operations.dispatch(request('start', start(projectPath, { createProject: true })));
  assert.equal(created.state, 'queued');
  assert.equal((await fs.stat(projectPath)).isDirectory(), true);
  assert.equal(service.projects.size, 2);
});

test('claims persist before delivery, busy heartbeat does not claim, and commands are never issued twice', async (context) => {
  const { service, root, store } = await fixture(context);
  const operations = new TerminalOperations(service);
  const session = relay();
  await operations.claim(session);
  const input = start(root);
  await operations.dispatch(request('start', input));
  assert.deepEqual(await operations.claim({ ...session, available: false }), { command: null });
  const claimed = await operations.claim(session);
  assert.equal(claimed.command.requestId, input.requestId);
  const saved = store.get('miter.terminal.operation.' + input.requestId);
  assert.equal(saved.operation.state, 'claimed');
  assert.equal(saved.claim.token, claimed.command.claimToken);
  assert.deepEqual(await operations.claim(session), { command: null });
  await assert.rejects(
    operations.complete({
      sessionId: randomUUID(),
      requestId: input.requestId,
      claimToken: claimed.command.claimToken,
      ok: true,
    }),
    /does not match/,
  );
  const ack = {
    sessionId: session.sessionId,
    requestId: input.requestId,
    claimToken: claimed.command.claimToken,
    ok: true,
  };
  assert.deepEqual(await operations.complete(ack), { recorded: true });
  assert.deepEqual(await operations.complete(ack), { recorded: true });
  await assert.rejects(operations.complete({ ...ack, ok: false }), /different acknowledgement/);
  const receipt = await operations.dispatch(request('operation', { requestId: input.requestId }));
  assert.equal(receipt.state, 'succeeded');
  const status = await operations.dispatch(request('status', { workerId: receipt.workerId }));
  assert.equal(status.worker.state, 'idle');
  assert.equal(status.worker.completion, undefined);
});

test('host restart interrupts uncertain claims without replay, and exact late acknowledgement resolves the receipt', async (context) => {
  const { service, root } = await fixture(context);
  const first = new TerminalOperations(service);
  const session = relay();
  await first.claim(session);
  const input = start(root);
  await first.dispatch(request('start', input));
  const { command } = await first.claim(session);
  await first.close();
  const second = new TerminalOperations(service);
  const interrupted = await second.dispatch(request('start', input));
  assert.equal(interrupted.state, 'interrupted');
  await second.complete({
    sessionId: session.sessionId,
    requestId: input.requestId,
    claimToken: command.claimToken,
    ok: true,
  });
  const resolved = await second.dispatch(request('operation', { requestId: input.requestId }));
  assert.equal(resolved.state, 'succeeded');
  assert.equal(resolved.error, undefined);
  const list = await second.dispatch(request('list', {}));
  assert.equal(list.browserConnected, false);
  assert.equal((await second.dispatch(request('start', start(root)))).state, 'failed');
  assert.deepEqual(await second.claim(session), { command: null });
});

test('a lost claim acknowledgement becomes interrupted when the relay is ready again, while busy heartbeats preserve it', async (context) => {
  const { service, root } = await fixture(context);
  const operations = new TerminalOperations(service);
  const session = relay();
  await operations.claim(session);
  const input = start(root);
  await operations.dispatch(request('start', input));
  const original = await operations.claim(session);
  assert.equal(original.command.requestId, input.requestId);

  assert.deepEqual(await operations.claim({ ...session, available: false }), { command: null });
  assert.equal(
    (await operations.dispatch(request('operation', { requestId: input.requestId }))).state,
    'claimed',
  );
  assert.deepEqual(await operations.claim(session), { command: null });
  const receipt = await operations.dispatch(request('operation', { requestId: input.requestId }));
  assert.equal(receipt.state, 'interrupted');
  assert.match(receipt.error, /uncertain command was not dispatched again/);
  assert.equal((await operations.dispatch(request('start', input))).state, 'interrupted');
  assert.equal(service.workers.size, 2);
});

test('restart does not replay interrupted preparation after its worker side effect', async (context) => {
  const { service, root, store } = await fixture(context);
  const first = new TerminalOperations(service);
  await first.claim(relay());
  const input = start(root);
  const created = await first.dispatch(request('start', input));
  const saved = store.get('miter.terminal.operation.' + input.requestId);
  saved.operation.state = 'preparing';
  delete saved.operation.workerId;
  delete saved.operation.expectedRun;
  store.set('miter.terminal.operation.' + input.requestId, saved);
  await first.close();
  const count = service.workers.size;
  const second = new TerminalOperations(service);
  const recovered = await second.dispatch(request('start', input));
  assert.equal(recovered.state, 'interrupted');
  assert.equal(service.workers.size, count);
  assert.ok(service.workers.has(created.workerId));
});

test('queued commands survive restart but stale run boundaries fail before dispatch', async (context) => {
  const { service, root } = await fixture(context);
  const first = new TerminalOperations(service);
  await first.claim(relay());
  const input = start(root);
  const queued = await first.dispatch(request('start', input));
  await first.close();
  const second = new TerminalOperations(service);
  service.workers.get(queued.workerId).runId = randomUUID();
  assert.deepEqual(await second.claim(relay()), { command: null });
  assert.equal((await second.dispatch(request('operation', { requestId: input.requestId }))).state, 'failed');
});

test('stop binds the reviewed run and keeps ordinary approval data private', async (context) => {
  const { service, worker } = await fixture(context);
  const operations = new TerminalOperations(service);
  const session = relay();
  await operations.claim(session);
  const stale = {
    requestId: randomUUID(),
    workerId: worker.id,
    expectedRun: { runId: 'obsolete', epoch: 0 },
  };
  assert.equal((await operations.dispatch(request('stop', stale))).state, 'failed');
  const current = { ...stale, requestId: randomUUID(), expectedRun: { runId: worker.runId, epoch: 0 } };
  assert.equal((await operations.dispatch(request('stop', current))).state, 'queued');
  const { command } = await operations.claim(session);
  assert.equal(command.kind, 'stop');
  assert.deepEqual(command.expectedRun, current.expectedRun);
  const status = await operations.dispatch(request('status', { workerId: worker.id }));
  assert.equal('observations' in status.worker, false);
  assert.equal('queue' in status.worker, false);
  assert.equal('pending' in status.worker, false);
});

test('resume queues the existing boundary once without creating work or changing task budgets', async (context) => {
  const { service, worker, store } = await fixture(context);
  const operations = new TerminalOperations(service);
  const session = relay();
  await operations.claim(session);
  const original = structuredClone(worker);
  const calls = [];
  context.mock.method(service, 'handle', async (method) => {
    calls.push(method);
    throw new Error('Resume must not run host work.');
  });
  const input = {
    requestId: randomUUID(),
    workerId: worker.id,
    expectedRun: { runId: worker.runId, epoch: worker.control?.epoch ?? 0 },
  };
  const [first, second] = await Promise.all([
    operations.dispatch(request('resume', input)),
    operations.dispatch(request('resume', input)),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.kind, 'resume');
  assert.equal(first.state, 'queued');
  assert.deepEqual(worker, original);
  assert.equal(service.workers.size, 1);
  assert.deepEqual(calls, []);
  await assert.rejects(operations.dispatch(request('stop', input)), /different operation/);
  const { command } = await operations.claim(session);
  assert.deepEqual(command, {
    kind: 'resume',
    requestId: input.requestId,
    workerId: worker.id,
    expectedRun: input.expectedRun,
    claimToken: command.claimToken,
  });
  assert.equal(store.get('miter.terminal.operation.' + input.requestId).operation.state, 'claimed');
  const ack = {
    sessionId: session.sessionId,
    requestId: input.requestId,
    claimToken: command.claimToken,
    ok: true,
  };
  await operations.complete(ack);
  await operations.complete(ack);
  assert.deepEqual(await operations.claim(session), { command: null });
  assert.equal((await operations.dispatch(request('resume', input))).state, 'succeeded');
  assert.deepEqual(worker, original);
});

test('resume requires a fresh matching browser and the original run and epoch', async (context) => {
  const { service, worker } = await fixture(context);
  let now = 100;
  const operations = new TerminalOperations(service, () => now);
  const input = {
    workerId: worker.id,
    expectedRun: { runId: worker.runId, epoch: worker.control?.epoch ?? 0 },
  };
  const resume = (overrides = {}) =>
    operations.dispatch(request('resume', { ...input, requestId: randomUUID(), ...overrides }));
  assert.match((await resume()).error, /terminal connection is not ready/);
  await assert.rejects(operations.claim(relay({ version: 'old-version' })), /Reload/);
  assert.match((await resume()).error, /old-version/);
  const session = relay();
  await operations.claim(session);
  assert.match((await resume({ expectedRun: { runId: 'old-run', epoch: 0 } })).error, /earlier task run/);
  assert.match(
    (await resume({ expectedRun: { runId: worker.runId, epoch: input.expectedRun.epoch + 1 } })).error,
    /earlier task run/,
  );
  now = 5101;
  assert.match((await resume()).error, /terminal connection is not ready/);
  assert.deepEqual(await operations.claim(session), { command: null });
  assert.equal(service.workers.size, 1);
});

test('resume rejects retired tasks and unresolved approvals without dispatching', async (context) => {
  const { service, worker } = await fixture(context);
  const operations = new TerminalOperations(service);
  const session = relay();
  await operations.claim(session);
  const original = structuredClone(worker);
  const blocked = [
    { state: 'complete' },
    { state: 'cancelled' },
    {
      state: 'paused',
      control: {
        version: 1,
        epoch: 0,
        mode: 'stopped',
        at: 0,
        operationId: 'stop',
        reason: 'Stopped',
        retiredExchanges: [],
      },
    },
    { mode: 'local' },
    { humanAcceptanceReady: true },
    {
      pending: {
        token: 'approval',
        fingerprint: 'fingerprint',
        action: { type: 'write', path: 'file.txt', content: 'Pending', expectedHash: 'missing' },
        reason: 'Review required',
        revision: 0,
      },
    },
  ];
  for (const overrides of blocked) {
    service.workers.set(worker.id, { ...original, ...overrides });
    const result = await operations.dispatch(
      request('resume', {
        requestId: randomUUID(),
        workerId: worker.id,
        expectedRun: { runId: worker.runId, epoch: 0 },
      }),
    );
    assert.equal(result.state, 'failed');
    assert.deepEqual(await operations.claim(session), { command: null });
    assert.deepEqual(service.workers.get(worker.id), { ...original, ...overrides });
  }
});

test('queued resume rechecks completion, stop, approval and run identity before claiming', async (context) => {
  const { service, worker } = await fixture(context);
  const operations = new TerminalOperations(service);
  const session = relay();
  await operations.claim(session);
  const original = structuredClone(worker);
  const changes = [
    { state: 'complete' },
    { state: 'cancelled' },
    {
      state: 'paused',
      control: {
        version: 1,
        epoch: 0,
        mode: 'stopped',
        at: 0,
        operationId: 'stop',
        reason: 'Stopped',
        retiredExchanges: [],
      },
    },
    { humanAcceptanceReady: true },
    { runId: 'replacement-run' },
    {
      pending: {
        token: 'approval',
        fingerprint: 'fingerprint',
        action: { type: 'write', path: 'file.txt', content: 'Pending', expectedHash: 'missing' },
        reason: 'Review required',
        revision: 0,
      },
    },
  ];
  for (const change of changes) {
    service.workers.set(worker.id, structuredClone(original));
    const input = {
      requestId: randomUUID(),
      workerId: worker.id,
      expectedRun: { runId: original.runId, epoch: 0 },
    };
    assert.equal((await operations.dispatch(request('resume', input))).state, 'queued');
    Object.assign(service.workers.get(worker.id), change);
    assert.deepEqual(await operations.claim(session), { command: null });
    assert.equal(
      (await operations.dispatch(request('operation', { requestId: input.requestId }))).state,
      'failed',
    );
  }
});

test('interrupted resume claims never replay after restart and accept only their exact late receipt', async (context) => {
  const { service, worker } = await fixture(context);
  const first = new TerminalOperations(service);
  const session = relay();
  await first.claim(session);
  const input = {
    requestId: randomUUID(),
    workerId: worker.id,
    expectedRun: { runId: worker.runId, epoch: 0 },
  };
  await first.dispatch(request('resume', input));
  const { command } = await first.claim(session);
  await first.close();
  const second = new TerminalOperations(service);
  assert.equal((await second.dispatch(request('resume', input))).state, 'interrupted');
  assert.deepEqual(await second.claim(session), { command: null });
  const ack = {
    sessionId: session.sessionId,
    requestId: input.requestId,
    claimToken: command.claimToken,
    ok: true,
  };
  await assert.rejects(second.complete({ ...ack, claimToken: randomUUID() }), /does not match/);
  await second.complete(ack);
  await assert.rejects(second.complete({ ...ack, ok: false }), /different acknowledgement/);
  assert.equal((await second.dispatch(request('resume', input))).state, 'succeeded');
  assert.equal(service.workers.size, 1);
});

test('browser restart interrupts its old claim and stale heartbeats stop new admission', async (context) => {
  const { service, root } = await fixture(context);
  let now = 100;
  const operations = new TerminalOperations(service, () => now);
  const session = relay();
  await operations.claim(session);
  const input = start(root);
  await operations.dispatch(request('start', input));
  await operations.claim(session);
  assert.deepEqual(await operations.claim(relay()), { command: null });
  assert.equal(
    (await operations.dispatch(request('operation', { requestId: input.requestId }))).state,
    'interrupted',
  );
  now = 5101;
  const before = service.workers.size;
  const refused = await operations.dispatch(request('start', start(root)));
  assert.equal(refused.state, 'failed');
  assert.equal(service.workers.size, before);
});

test('closing drains admitted creation, rejects later work, and leaves a recoverable queued receipt', async (context) => {
  const { service, root } = await fixture(context);
  const operations = new TerminalOperations(service);
  await operations.claim(relay());
  const input = start(root);
  const accepted = operations.dispatch(request('start', input));
  const closing = operations.close();
  await assert.rejects(operations.dispatch(request('list', {})), /closing or resetting/);
  const result = await accepted;
  await closing;
  assert.equal(result.state, 'queued');
  const reopened = new TerminalOperations(service);
  const { command } = await reopened.claim(relay());
  assert.equal(command.workerId, result.workerId);
});

test('terminal status JSON includes the saved reader diagnostic and omits it on earlier checkpoints', async (context) => {
  const { service, worker } = await fixture(context);
  const operations = new TerminalOperations(service);
  const save = (progress) => service.handle('worker.bridgeSave', { workerId: worker.id, progress });
  const output = async () => {
    const status = await operations.dispatch(request('status', { workerId: worker.id }));
    const lines = [];
    printStatus(status, true, { out: (value) => lines.push(value), err: (error) => assert.fail(error) });
    return JSON.parse(lines[0]).progress;
  };
  const old = await save(makeProgress(worker));
  assert.equal(Object.hasOwn(await output(), 'readerDiagnostic'), false);
  const readerDiagnostic = {
    readerRevision: 3,
    transcript: 'partial',
    receipt: 'unknown_tail',
    matches: 1,
    tail: 2,
    reason: 'unclassified_tail',
  };
  await save({ ...old, readerDiagnostic });
  assert.deepEqual((await output()).readerDiagnostic, readerDiagnostic);
});
