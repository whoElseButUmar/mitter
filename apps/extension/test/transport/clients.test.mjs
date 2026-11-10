import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { HostClient } from '../../src/client.ts';
import { FilePreviewClient } from '../../src/file-preview-client.ts';
import { TerminalClient } from '../../src/terminal-client.ts';
import { mockPort, snapshot, assetChunk, terminalInfo, settle } from './chrome-mock.mjs';

function runtime(context, configurePort = () => {}) {
  const ports = [];
  context.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.chrome = {
    runtime: {
      connect({ name }) {
        const port = mockPort(name);
        configurePort(port, ports.length);
        ports.push(port);
        return port;
      },
    },
  };

  return ports;
}

function clientCase(kind) {
  const events = { snapshots: [], connections: [], auxiliary: [], disconnects: 0 };

  if (kind === 'host') {
    return {
      client: new HostClient(
        (value) => events.snapshots.push(value),
        (...value) => events.connections.push(value),
        (value) => events.auxiliary.push(value),
      ),
      method: 'worker.prompt',
      params: { workerId: 'worker' },
      result: 'Exact prompt',
      events,
    };
  }

  if (kind === 'file') {
    return {
      client: new FilePreviewClient(),
      method: 'worker.asset',
      params: { workerId: 'worker', path: 'index.html' },
      result: assetChunk,
      events,
    };
  }

  return {
    client: new TerminalClient(() => {
      events.disconnects++;
    }),
    method: 'terminal.list',
    params: { projectId: 'project' },
    result: [terminalInfo],
    events,
  };
}

function captureCallbacks(port) {
  const callbacks = { messages: [], disconnects: [] };
  const addMessage = port.onMessage.addListener;
  const addDisconnect = port.onDisconnect.addListener;
  port.onMessage.addListener = (listener) => {
    callbacks.messages.push(listener);
    addMessage(listener);
  };
  port.onDisconnect.addListener = (listener) => {
    callbacks.disconnects.push(listener);
    addDisconnect(listener);
  };

  return callbacks;
}

for (const kind of ['host', 'file', 'terminal']) {
  test(`${kind} client close removes listeners, rejects pending work, and clears connection timers`, async (context) => {
    const ports = runtime(context);
    const { client, method, params, events } = clientCase(kind);
    context.after(() => client.close());
    const request = client.request(method, params);
    const rejected = assert.rejects(request, /closed/);
    const port = ports[0];
    assert.equal(port.onMessage.size, 1);
    assert.equal(port.onDisconnect.size, 1);
    client.close();
    client.close();
    await rejected;
    assert.equal(port.onMessage.size, 0);
    assert.equal(port.onDisconnect.size, 0);
    assert.equal(port.disconnects, 1);
    assert.equal(events.disconnects, 0);
    await assert.rejects(client.request(method, params), /closed/);
    context.mock.timers.tick(180000);
    assert.equal(ports.length, 1);
    assert.equal(port.messages.length, 1);
  });

  test(`${kind} client disconnect detaches old listeners and queued callbacks cannot affect a replacement`, async (context) => {
    const queued = new Map();
    const ports = runtime(context, (port) => queued.set(port, captureCallbacks(port)));
    const { client, method, params, result, events } = clientCase(kind);
    context.after(() => client.close());
    const previous = client.request(method, params);
    const rejected = assert.rejects(previous, /disconnected|connection closed/i);
    const old = ports[0];
    old.disconnect();
    await rejected;
    assert.equal(old.onMessage.size, 0);
    assert.equal(old.onDisconnect.size, 0);
    const current = client.request(method, params);
    const next = ports[1];
    const callbacks = queued.get(old);
    assert.ok(callbacks);
    const [receive] = callbacks.messages;
    const [disconnect] = callbacks.disconnects;
    assert.equal(typeof receive, 'function');
    assert.equal(typeof disconnect, 'function');
    const before = structuredClone(events);
    // These callbacks were queued before the retired port's listeners were removed.
    receive({ id: next.messages[0].id, ok: false, error: 'Stale port result' });
    receive({ event: 'snapshot', data: snapshot });
    receive({ event: 'ding' });
    disconnect();
    assert.deepEqual(events, before);
    next.onMessage.emit({ id: next.messages[0].id, ok: true, result });
    assert.deepEqual(await current, result);
    assert.equal(old.messages.length, 1);
    assert.equal(next.messages.length, 1);
    client.close();
    context.mock.timers.tick(180000);
    assert.equal(ports.length, 2);
  });

  for (const event of ['onMessage', 'onDisconnect']) {
    test(`${kind} client cleans up partial ${event} registration and allows a fresh manual connection`, async (context) => {
      const failure = { message: 'Listener registration failed' };
      const ports = runtime(context, (port, index) => {
        if (index !== 0) {
          return;
        }

        const add = port[event].addListener;
        port[event].addListener = (listener) => {
          add(listener);
          throw failure;
        };
      });
      const { client, method, params, result, events } = clientCase(kind);
      context.after(() => client.close());
      const failed = await client.request(method, params).catch((error) => error);
      const old = ports[0];
      assert.equal(old.onMessage.size, 0);
      assert.equal(old.onDisconnect.size, 0);
      assert.equal(old.disconnects, 1);
      assert.equal(old.messages.length, 0);

      if (kind === 'host') {
        assert.match(failed.message, /reconnecting.*No operation was sent/);
        assert.equal(JSON.stringify(events.connections).includes(failure.message), true);
      } else {
        assert.equal(failed, failure);
        assert.equal(events.disconnects, 0);
      }

      const current = client.request(method, params);
      const next = ports[1];
      assert.equal(next.onMessage.size, 1);
      assert.equal(next.onDisconnect.size, 1);
      next.onMessage.emit({ id: next.messages[0].id, ok: true, result });
      assert.deepEqual(await current, result);
      client.close();
      context.mock.timers.tick(180000);
      assert.equal(ports.length, 2);
      assert.equal(old.messages.length, 0);
      assert.equal(next.messages.length, 1);
    });
  }

  test(`${kind} client teardown still closes and rejects work if listener removal throws`, async (context) => {
    context.mock.method(console, 'warn', () => {});
    const ports = runtime(context, (port) => {
      port.onMessage.removeListener = () => {
        throw new Error('Chrome event context is unavailable');
      };
    });
    const { client, method, params } = clientCase(kind);
    context.after(() => client.close());
    const pending = client.request(method, params);
    const rejected = assert.rejects(pending, /closed/);
    const port = ports[0];
    assert.doesNotThrow(() => client.close());
    await rejected;
    assert.equal(port.onDisconnect.size, 0);
    assert.equal(port.disconnects, 1);
    context.mock.timers.tick(180000);
    assert.equal(ports.length, 1);
    assert.equal(port.messages.length, 1);
  });
}

for (const kind of ['file', 'terminal']) {
  test(`${kind} client send failure retires the port and rejects every request without waiting for timeouts`, async (context) => {
    const ports = runtime(context);
    const { client, method, params, result, events } = clientCase(kind);
    context.after(() => client.close());
    const previous = client.request(method, params);
    const old = ports[0];
    old.postMessage = () => {
      throw new Error('Attempting to use a disconnected port');
    };
    const failed = client.request(method, params);
    let previousError;
    let failedError;
    void previous.catch((error) => {
      previousError = error;
    });
    void failed.catch((error) => {
      failedError = error;
    });
    await settle();
    assert.ok(previousError instanceof Error);
    assert.ok(failedError instanceof Error);
    assert.match(previousError.message, /closed|disconnected/);
    assert.match(failedError.message, /closed|disconnected/);
    assert.equal(old.onMessage.size, 0);
    assert.equal(old.onDisconnect.size, 0);
    assert.equal(old.disconnects, 1);

    if (kind === 'terminal') {
      assert.equal(events.disconnects, 1);
      assert.match(failedError.message, /not replayed/);
    }

    const current = client.request(method, params);
    const next = ports[1];
    next.onMessage.emit({ id: next.messages[0].id, ok: true, result });
    assert.deepEqual(await current, result);
    client.close();
    context.mock.timers.tick(180000);
    assert.equal(ports.length, 2);
    assert.equal(old.messages.length, 1);
    assert.equal(next.messages.length, 1);
  });
}

test('HostClient setup failure reports the error and retries only the connection', (context) => {
  const ports = runtime(context, (port, index) => {
    if (index !== 0) {
      return;
    }

    const add = port.onDisconnect.addListener;
    port.onDisconnect.addListener = (listener) => {
      add(listener);
      throw new Error('Listener registration failed');
    };
  });
  const { client, events } = clientCase('host');
  context.after(() => client.close());
  assert.doesNotThrow(() => client.connect());
  const old = ports[0];
  assert.equal(old.onMessage.size, 0);
  assert.equal(old.onDisconnect.size, 0);
  assert.equal(old.disconnects, 1);
  assert.equal(old.messages.length, 0);
  assert.equal(events.connections.length, 1);
  assert.match(events.connections[0][1], /Listener registration failed.*Pending actions are not retried/);
  context.mock.timers.tick(250);
  const next = ports[1];
  assert.equal(ports.length, 2);
  assert.equal(next.onMessage.size, 1);
  assert.equal(next.onDisconnect.size, 1);
  assert.equal(next.messages.length, 0);
  context.mock.timers.tick(15000);
  assert.equal(next.messages.length, 1);
  assert.equal(next.messages[0].type, 'ping');
  client.close();
  context.mock.timers.tick(180000);
  assert.equal(ports.length, 2);
  assert.equal(old.messages.length, 0);
  assert.equal(next.onMessage.size, 0);
  assert.equal(next.onDisconnect.size, 0);
});

test('HostClient can explicitly reopen after close without reviving the retired connection', async (context) => {
  const ports = runtime(context);
  const { client, method, params, result } = clientCase('host');
  context.after(() => client.close());
  client.connect();
  const old = ports[0];
  client.close();
  assert.equal(old.onMessage.size, 0);
  assert.equal(old.onDisconnect.size, 0);
  client.reconnect();
  assert.equal(ports.length, 1);
  client.connect();
  const current = client.request(method, params);
  const next = ports[1];
  next.onMessage.emit({ id: next.messages[0].id, ok: true, result });
  assert.equal(await current, result);
  assert.equal(old.messages.length, 0);
  assert.equal(next.messages.length, 1);
});

test('HostClient validates typed results and ignores malformed event bodies', async (context) => {
  const ports = runtime(context);
  const snapshots = [];
  const auxiliary = [];
  const client = new HostClient(
    (value) => snapshots.push(value),
    () => {},
    (value) => auxiliary.push(value),
  );
  context.after(() => client.close());
  client.connect();
  const port = ports[0];
  port.onMessage.emit({ event: 'snapshot', data: { protocol: 'mitter/1' } });
  port.onMessage.emit({ event: 'snapshot', data: snapshot });
  port.onMessage.emit({ event: 'bridges', data: [false] });
  assert.equal(snapshots.length, 1);
  assert.equal(auxiliary.length, 0);

  const result = client.request('notifications.get', {}, z.object({ enabled: z.boolean() }));
  port.onMessage.emit({ id: port.messages[0].id, ok: true, result: { enabled: 'not boolean' } });
  await assert.rejects(result, (error) => {
    assert.equal(error.code, 'RPC_RESULT_INVALID');
    assert.equal(error.retryable, false);
    assert.ok(error.cause instanceof z.ZodError);
    return true;
  });
  assert.equal(port.messages.length, 1);
});

test('HostClient reconnect never replays mutations, and late old-port responses are ignored', async (context) => {
  const ports = runtime(context);
  const client = new HostClient(
    () => {},
    () => {},
  );
  context.after(() => client.close());
  client.connect();
  const old = ports[0];
  const before = client.request('worker.run', { workerId: 'worker' });
  client.connect();
  await assert.rejects(before, /not replayed/);
  assert.equal(old.onMessage.size, 0);
  assert.equal(old.onDisconnect.size, 0);
  const current = client.request('worker.prompt', { workerId: 'worker' }, z.string());
  const next = ports[1];
  old.onMessage.emit({ id: next.messages[0].id, ok: true, result: 'stale' });
  old.onDisconnect.emit();
  next.onMessage.emit({ id: next.messages[0].id, ok: true, result: 'fresh' });
  assert.equal(await current, 'fresh');
  assert.equal(next.messages.length, 1);
});

test('HostClient heartbeat requires its exact nonce and disposal clears retry/liveness timers', async (context) => {
  const ports = runtime(context);
  const client = new HostClient(
    () => {},
    () => {},
  );
  client.connect();
  const port = ports[0];
  context.mock.timers.tick(15000);
  const ping = port.messages[0];
  assert.equal(ping.type, 'ping');
  port.onMessage.emit({ type: 'pong', id: 'wrong-nonce' });
  context.mock.timers.tick(5000);
  assert.equal(port.disconnects, 1);
  assert.equal(port.onMessage.size, 0);
  assert.equal(port.onDisconnect.size, 0);
  client.close();
  context.mock.timers.tick(60000);
  assert.equal(ports.length, 1);
});

test('HostClient routes validated messages once, preserving heartbeat and event precedence over RPC', async (context) => {
  const ports = runtime(context);
  const snapshots = [];
  const connections = [];
  const auxiliary = [];
  const client = new HostClient(
    (value) => snapshots.push(value),
    (...value) => connections.push(value),
    (value) => auxiliary.push(value),
  );
  context.after(() => client.close());
  client.connect();
  const port = ports[0];
  port.onMessage.emit({ event: 'connection', connected: false, error: 'Unavailable' });
  port.onMessage.emit({ event: 'workspaceError', error: 'Not saved' });
  assert.deepEqual(connections, [[false, 'Unavailable']]);
  assert.deepEqual(auxiliary, [{ event: 'workspaceError', error: 'Not saved' }]);

  const pending = client.request('worker.prompt', { workerId: 'worker' }, z.string());
  const requestId = port.messages[0].id;
  context.mock.timers.tick(15000);
  const ping = port.messages[1];
  port.onMessage.emit({ type: 'pong', id: ping.id, ok: true, result: 'not an RPC response' });
  context.mock.timers.tick(5000);
  assert.equal(port.disconnects, 0);
  port.onMessage.emit({
    event: 'snapshot',
    data: snapshot,
    id: requestId,
    ok: true,
    result: 'not a response',
  });
  assert.equal(snapshots.length, 1);
  assert.equal(connections.length, 2);
  port.onMessage.emit({ id: requestId, ok: true, result: 'exact response' });
  assert.equal(await pending, 'exact response');
});

test('file previews validate exact path, offset, stamp, chunk size, and EOF', async (context) => {
  const ports = runtime(context);
  const client = new FilePreviewClient();
  context.after(() => client.close());
  const first = client.request('worker.asset', { workerId: 'worker', path: 'index.html' });
  const port = ports[0];
  assert.deepEqual(port.messages[0].params, { workerId: 'worker', path: 'index.html' });
  port.onMessage.emit({ id: port.messages[0].id, ok: true, result: assetChunk });
  assert.deepEqual(await first, assetChunk);

  const second = client.request('worker.asset', {
    workerId: 'worker',
    path: 'index.html',
    stamp: 'b'.repeat(64),
  });
  port.onMessage.emit({ id: port.messages[1].id, ok: true, result: assetChunk });
  await assert.rejects(second, /exact version/);
  await assert.rejects(client.request('worker.run', {}));
  assert.equal(port.messages.length, 2);
  client.close();
  await assert.rejects(client.request('worker.asset', { workerId: 'worker', path: 'index.html' }), /closed/);
});

test('terminal methods narrow and validate results; closed clients never reconnect', async (context) => {
  const ports = runtime(context);
  let disconnected = 0;
  const client = new TerminalClient(() => {
    disconnected++;
  });
  const list = client.request('terminal.list', { projectId: 'project' });
  const port = ports[0];
  port.onMessage.emit({ id: port.messages[0].id, ok: true, result: [terminalInfo] });
  assert.deepEqual(await list, [terminalInfo]);

  const write = client.request('terminal.write', { sessionId: 'session', data: 'input' });
  port.disconnect();
  await assert.rejects(write, /Input was not replayed/);
  assert.equal(disconnected, 1);
  client.close();
  await assert.rejects(client.request('terminal.list'), /closed/);
  await settle();
  assert.equal(ports.length, 1);
});
