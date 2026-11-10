import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { NativeHost } from '../../src/transport/native-host.ts';
import { NativeRequestTimeout } from '../../../../packages/bridge/src/native-request.ts';
import { mockPort, snapshot, settle } from './chrome-mock.mjs';

function setup(context, configurePort = () => {}) {
  const ports = [];
  const snapshots = [];
  const disconnects = [];
  const logs = [];
  let allowed = true;

  globalThis.chrome = {
    runtime: {
      connectNative() {
        const port = mockPort('native');
        configurePort(port, ports.length);
        ports.push(port);
        return port;
      },
    },
  };
  const host = new NativeHost({
    allow: () => allowed,
    snapshot: (value) => snapshots.push(value),
    resetRequired: () => {},
    disconnected: (error) => disconnects.push(error),
    log: (...entry) => logs.push(entry),
  });
  context.after(() => host.dispose());

  return {
    host,
    ports,
    snapshots,
    disconnects,
    logs,
    block() {
      allowed = false;
    },
  };
}

for (const eventName of ['onMessage', 'onDisconnect']) {
  test(`native partial ${eventName} registration releases the port and fences queued callbacks`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const failure = new Error('Native listener registration failed');
    const callbacks = new Map();
    const { host, ports, snapshots, disconnects } = setup(context, (port, index) => {
      const queued = {};
      callbacks.set(port, queued);

      for (const name of ['onMessage', 'onDisconnect']) {
        const add = port[name].addListener;
        port[name].addListener = (listener) => {
          queued[name] = listener;
          add(listener);

          if (index === 0 && name === eventName) {
            throw failure;
          }
        };
      }
    });
    assert.throws(
      () => host.connect(),
      (error) => error === failure,
    );
    const old = ports[0];
    assert.equal(old.onMessage.size, 0);
    assert.equal(old.onDisconnect.size, 0);
    assert.equal(old.disconnects, 1);
    assert.equal(old.messages.length, 0);
    assert.equal(disconnects.length, 1);
    const current = host.request('worker.prompt', { workerId: 'worker' }, z.string());
    const next = ports[1];
    const queued = callbacks.get(old);
    queued.onMessage({ event: 'snapshot', data: snapshot });
    queued.onMessage({ id: next.messages[0].id, ok: true, result: 'stale' });
    queued.onDisconnect?.();
    assert.deepEqual(snapshots, []);
    assert.equal(disconnects.length, 1);
    next.onMessage.emit({ id: next.messages[0].id, ok: true, result: 'fresh' });
    assert.equal(await current, 'fresh');
    host.dispose();
    context.mock.timers.tick(180000);
    assert.equal(ports.length, 2);
    assert.equal(next.messages.length, 1);
    assert.equal(old.messages.length, 0);
  });
}

test('native request setup failure rejects promptly and never caches or replays the failed port', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, ports } = setup(context, (port, index) => {
    if (index !== 0) {
      return;
    }

    const add = port.onDisconnect.addListener;
    port.onDisconnect.addListener = (listener) => {
      add(listener);
      throw new Error('Native listener registration failed');
    };
  });
  await assert.rejects(
    host.request('worker.run', { workerId: 'worker' }),
    /Native listener registration failed/,
  );
  const old = ports[0];
  assert.equal(old.onMessage.size, 0);
  assert.equal(old.onDisconnect.size, 0);
  assert.equal(old.disconnects, 1);
  assert.equal(old.messages.length, 0);
  const current = host.request('worker.prompt', { workerId: 'worker' });
  const next = ports[1];
  next.onMessage.emit({ id: next.messages[0].id, ok: true, result: 'fresh' });
  assert.equal(await current, 'fresh');
  host.dispose();
  context.mock.timers.tick(180000);
  assert.equal(ports.length, 2);
  assert.equal(old.messages.length, 0);
});

test('native results are schema-proven, not caller-asserted', async (context) => {
  const { host, ports } = setup(context);
  const request = host.request(
    'worker.handoffSeen',
    { workerId: 'worker', envelopeId: 'batch' },
    z.object({ seen: z.boolean() }),
  );
  const port = ports[0];
  port.onMessage.emit({
    id: port.messages[0].id,
    ok: true,
    result: { seen: true },
  });
  assert.deepEqual(await request, { seen: true });

  const invalid = host.request('worker.handoffSeen', { workerId: 'worker', envelopeId: 'batch' });
  port.onMessage.emit({
    id: port.messages[1].id,
    ok: true,
    result: { seen: 'yes' },
  });
  await assert.rejects(invalid, (error) => {
    assert.equal(error.code, 'RPC_RESULT_INVALID');
    assert.equal(error.retryable, false);
    assert.ok(error.cause instanceof z.ZodError);
    return true;
  });
  assert.equal(port.messages.length, 2);
});

test('native disconnect rejects work and old callbacks cannot complete the next connection', async (context) => {
  const { host, ports, snapshots } = setup(context);
  const previous = host.request('worker.prompt', { workerId: 'worker' });
  const old = ports[0];
  old.disconnect();
  await assert.rejects(previous, /disconnected.*not replayed/);
  assert.equal(old.onMessage.size, 0);
  assert.equal(old.onDisconnect.size, 0);
  const current = host.request('worker.prompt', { workerId: 'worker' });
  const next = ports[1];
  const id = next.messages[0].id;
  old.onMessage.emit({ id, ok: true, result: 'wrong connection' });
  old.onMessage.emit({ event: 'snapshot', data: snapshot });
  old.onDisconnect.emit();
  assert.equal(snapshots.length, 0);
  next.onMessage.emit({ id, ok: true, result: 'current connection' });
  assert.equal(await current, 'current connection');
  assert.equal(next.messages.length, 1);
});

test('invalid native snapshots fail closed and reject pending work', async (context) => {
  const { host, ports, snapshots, disconnects } = setup(context);
  const request = host.request('worker.prompt', { workerId: 'worker' });
  ports[0].onMessage.emit({
    event: 'snapshot',
    data: { protocol: 'mitter/1' },
  });
  await assert.rejects(request, /Invalid native host message[\s\S]*not replayed/);
  assert.equal(snapshots.length, 0);
  assert.equal(disconnects.length, 1);
  assert.equal(ports[0].onMessage.size, 0);
  assert.equal(ports[0].onDisconnect.size, 0);
});

test('native disposal detaches listeners, rejects work, and cannot create another connection', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, ports, logs } = setup(context);
  const request = host.request('worker.run', { workerId: 'worker' });
  const port = ports[0];
  assert.equal(port.onMessage.size, 1);
  assert.equal(port.onDisconnect.size, 1);
  host.dispose();
  host.dispose();
  await assert.rejects(request, /not replayed/);
  assert.equal(port.onMessage.size, 0);
  assert.equal(port.onDisconnect.size, 0);
  assert.equal(port.disconnects, 1);
  const before = logs.length;
  await assert.rejects(host.request('worker.run', { workerId: 'worker' }), /disposed/);
  assert.equal(logs.length, before);
  context.mock.timers.tick(180000);
  assert.equal(ports.length, 1);
  assert.equal(port.messages.length, 1);
});

test('a native send failure retires the port and rejects every pending RPC without replay', async (context) => {
  const { host, ports, disconnects } = setup(context);
  const previous = host.request('worker.prompt', { workerId: 'worker' }).catch((error) => error);
  const old = ports[0];
  old.postMessage = () => {
    throw new Error('Attempting to use a disconnected port');
  };
  const failed = host.request('worker.run', { workerId: 'worker' }).catch((error) => error);
  await settle();
  assert.equal(disconnects.length, 1);
  assert.match((await previous).message, /may already have reached Miter.*not replayed/);
  assert.match((await failed).message, /not replayed/);
  assert.equal(old.onMessage.size, 0);
  assert.equal(old.onDisconnect.size, 0);
  assert.equal(old.messages.length, 1);
  const current = host.request('worker.prompt', { workerId: 'worker' });
  const next = ports[1];
  next.onMessage.emit({ id: next.messages[0].id, ok: true, result: 'fresh read' });
  assert.equal(await current, 'fresh read');
  assert.equal(next.messages.length, 1);
});

for (const lifecycle of ['dispose', 'disconnect']) {
  for (const eventName of ['onMessage', 'onDisconnect']) {
    test('native ' + lifecycle + ' completes when ' + eventName + ' removal throws', async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const warnings = [];
      context.mock.method(console, 'warn', (...arguments_) => warnings.push(arguments_));
      const { host, ports } = setup(context);
      const pending = host.request('worker.run', { workerId: 'worker' }).catch((error) => error);
      const port = ports[0];
      const event = port[eventName];
      const removeListener = event.removeListener;
      const failure = new Error('Extension context was retired');

      event.removeListener = (listener) => {
        removeListener(listener);
        throw failure;
      };

      if (lifecycle === 'dispose') {
        assert.doesNotThrow(() => host.dispose());
      } else {
        assert.doesNotThrow(() => port.disconnect());
      }

      const error = await pending;
      assert.ok(error instanceof Error);
      assert.match(error.message, /not replayed/);
      assert.equal(port.onMessage.size, 0);
      assert.equal(port.onDisconnect.size, 0);
      assert.ok(port.disconnects > 0);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][1], failure);
      assert.doesNotThrow(() => host.dispose());
      context.mock.timers.tick(180000);
      assert.equal(ports.length, 1);
      assert.equal(port.messages.length, 1);
    });
  }
}

test('native timeouts retain their typed identity and never replay an ambiguous mutation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, ports } = setup(context);
  const request = host.request('worker.import', { workerId: 'worker', text: 'literal handoff' });
  const timedOut = assert.rejects(request, (error) => {
    assert.ok(error instanceof NativeRequestTimeout);
    assert.equal(error.code, 'NATIVE_REQUEST_TIMEOUT');
    assert.equal(error.method, 'worker.import');
    return true;
  });
  context.mock.timers.tick(30000);
  await timedOut;
  const port = ports[0];
  port.onMessage.emit({ id: port.messages[0].id, ok: true, result: { queued: true } });
  context.mock.timers.tick(180000);
  assert.equal(port.messages.length, 1);
  assert.equal(ports.length, 1);
  assert.equal(port.disconnects, 0);
});

test('terminal send failures cannot leak their exception text into connection diagnostics', async (context) => {
  const { host, ports, logs, disconnects } = setup(context);
  const port = host.connect();
  port.postMessage = () => {
    throw new Error('private shell input');
  };
  await assert.rejects(
    host.request('terminal.write', { clientId: 'view', sessionId: 'session', data: 'private shell input' }),
    /not replayed/,
  );
  assert.equal(disconnects.length, 1);
  assert.equal(JSON.stringify([logs, disconnects]).includes('private shell input'), false);
  assert.equal(ports.length, 1);
});

test('reset gates and disposal prevent sends', async (context) => {
  const { host, ports, block } = setup(context);
  block();
  await assert.rejects(host.request('worker.run', { workerId: 'worker' }), /No task operation was executed/);
  assert.equal(ports.length, 0);
  host.dispose();
  assert.throws(() => host.connect(), /disposed/);
});

test('terminal data never enters native diagnostics', async (context) => {
  const { host, ports, logs } = setup(context);
  const request = host.request('terminal.write', {
    clientId: 'view',
    sessionId: 'session',
    data: 'private shell input',
  });
  const port = ports[0];
  port.onMessage.emit({
    id: port.messages[0].id,
    ok: false,
    error: 'private shell error',
  });
  await assert.rejects(request, /private shell error/);
  assert.equal(JSON.stringify(logs).includes('private shell'), false);
});
