import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewConnections } from '../../src/background/view-connections.ts';
import { chromeEvent, mockPort, deferred, settle } from './chrome-mock.mjs';
import { APP_VERSION, BUILD_ID } from '../../../../packages/protocol/src/index.ts';

function connectView(connected, port) {
  connected.emit(port);

  if (port.name === 'mitter-ui' && port.onMessage.size > 0) {
    assert.equal(port.messages.shift().connected, false);
    port.onMessage.emit({ type: 'hello', id: 'version-check', version: APP_VERSION });
    assert.deepEqual(port.messages.shift(), {
      type: 'hello',
      id: 'version-check',
      version: APP_VERSION,
      buildId: BUILD_ID,
    });
  }
}

function setup(context, { connect = () => {}, initialMessages = () => [] } = {}) {
  const connected = chromeEvent();
  globalThis.chrome = {
    runtime: {
      id: 'extension',
      onConnect: connected,
      getURL: (page) => 'chrome-extension://extension/' + page,
      getContexts: async () => [],
    },
  };
  const requests = [];
  const clears = [];
  const job = deferred();
  const reset = {
    ready: Promise.resolve(),
    blocked: false,
    busy: false,
    state: { phase: 'idle' },
    clear: async (confirmation) => {
      clears.push(confirmation);
    },
  };
  const views = new ViewConnections({
    reset: () => reset,
    rpc: async () => {},
    connect,
    request(method, params) {
      requests.push({ method, params });
      return job.promise;
    },
    initialMessages,
    log: () => {},
  });
  views.start();
  context.after(() => views.dispose());

  return { views, connected, reset, job, requests, clears };
}

function viewPort(kind) {
  if (kind === 'file') {
    return mockPort(
      'miter-file-preview',
      'chrome-extension://extension/file.html?task=worker&file=index.html',
    );
  }

  if (kind === 'terminal') {
    return mockPort('miter-terminal');
  }

  if (kind === 'reset') {
    return mockPort('miter-data-view');
  }

  return mockPort('mitter-ui');
}

for (const kind of ['ui', 'reset', 'terminal', 'file']) {
  test(`${kind} view disposal detaches owned listeners even when local disconnect emits no event`, async (context) => {
    const { views, connected } = setup(context);
    const port = viewPort(kind);
    connectView(connected, port);
    await settle();
    port.disconnect = () => {
      port.disconnects++;
    };
    views.dispose();
    assert.equal(port.onMessage.size, 0);
    assert.equal(port.onDisconnect.size, 0);
    assert.equal(port.disconnects, 1);
    assert.equal(connected.size, 0);
  });

  for (const eventName of ['onMessage', 'onDisconnect']) {
    test(`${kind} view partial ${eventName} setup closes without retaining admission authority`, async (context) => {
      const { views, connected, requests, clears } = setup(context);
      const port = viewPort(kind);
      const add = port[eventName].addListener;
      port[eventName].addListener = (listener) => {
        add(listener);
        throw new Error('View listener registration failed');
      };
      assert.doesNotThrow(() => connected.emit(port));
      assert.equal(port.onMessage.size, 0);
      assert.equal(port.onDisconnect.size, 0);
      assert.equal(port.disconnects, 1);
      port.onMessage.emit({ id: 'late', method: 'worker.run', params: { workerId: 'worker' } });
      port.onMessage.emit({ type: 'reset-start', id: 'late-reset', confirmation: 'CLEAR' });
      await settle();
      assert.deepEqual(requests, []);
      assert.deepEqual(clears, []);
      views.dispose();
      assert.equal(port.disconnects, 1);
    });
  }
}

test('a rejected auxiliary sender is not retained when local disconnect emits no event', (context) => {
  const { views, connected } = setup(context);
  const port = mockPort('miter-terminal', 'https://chatgpt.com/');
  port.disconnect = () => {
    port.disconnects++;
  };
  connectView(connected, port);
  assert.equal(port.disconnects, 1);
  assert.equal(port.onMessage.size, 0);
  assert.equal(port.onDisconnect.size, 0);
  views.dispose();
  assert.equal(port.disconnects, 1);
});

test('UI ports authenticate documents; ping is exact and cannot invoke task work', async (context) => {
  const { connected, requests } = setup(context);
  const foreign = mockPort('mitter-ui', 'https://chatgpt.com/');
  connected.emit(foreign);
  assert.equal(foreign.disconnects, 1);
  const nested = mockPort('mitter-ui');
  nested.sender.frameId = 2;
  connected.emit(nested);
  assert.equal(nested.disconnects, 1);
  const port = mockPort('mitter-ui');
  connectView(connected, port);
  port.onMessage.emit({ type: 'ping', id: 'exact-nonce' });
  assert.deepEqual(port.messages, [{ type: 'pong', id: 'exact-nonce' }]);
  assert.equal(requests.length, 0);
  port.onMessage.emit({ id: 'array-params', method: 'worker.run', params: [] });
  assert.equal(requests.length, 0);
});

test('UI requests and host connects wait for a matching view version on each port', async (context) => {
  let connections = 0;
  const initial = { event: 'debug', data: [] };
  const { connected, views, requests, job } = setup(context, {
    connect: () => {
      connections++;
    },
    initialMessages: () => [initial],
  });
  const port = viewPort('ui');
  connected.emit(port);
  views.broadcast(initial);
  assert.equal(port.messages.length, 1);
  assert.equal(port.messages[0].event, 'connection');
  assert.equal(port.messages[0].connected, false);
  assert.match(port.messages[0].error, /Reload on Miter/);
  port.onMessage.emit({ id: 'too-early', method: 'worker.run', params: { workerId: 'worker' } });
  assert.equal(requests.length, 0);
  assert.equal(connections, 0);
  assert.match(port.messages.at(-1).error, /version.*Reload on Miter.*No operation was sent/);
  port.onMessage.emit({ type: 'reconnect' });
  assert.equal(connections, 0);
  port.onMessage.emit({ type: 'hello', id: 'exact-id', version: 'older-view' });
  assert.deepEqual(port.messages.at(-2), {
    type: 'hello',
    id: 'exact-id',
    version: APP_VERSION,
    buildId: BUILD_ID,
  });
  assert.equal(port.messages.at(-1).connected, false);
  assert.equal(connections, 0);
  port.onMessage.emit({ type: 'hello', id: 'matching', version: APP_VERSION });
  assert.deepEqual(port.messages.at(-2), {
    type: 'hello',
    id: 'matching',
    version: APP_VERSION,
    buildId: BUILD_ID,
  });
  assert.deepEqual(port.messages.at(-1), initial);
  assert.equal(connections, 1);
  port.onMessage.emit({ type: 'reconnect' });
  assert.equal(connections, 2);
  port.onMessage.emit({ id: 'run', method: 'worker.run', params: { workerId: 'worker' } });
  assert.equal(requests.length, 1);
  job.resolve({ started: true });
  await views.settled();
  await settle();
  assert.deepEqual(port.messages.at(-1), { id: 'run', ok: true, result: { started: true } });

  port.disconnect();
  const replacement = viewPort('ui');
  connected.emit(replacement);
  replacement.onMessage.emit({ id: 'no-handshake', method: 'worker.run', params: { workerId: 'worker' } });
  assert.equal(requests.length, 1);
  assert.equal(replacement.messages.at(-1).ok, false);
});

test('UI matching handshake reports native connection failure and permits an ordinary reconnect', (context) => {
  let failing = true;
  const { connected } = setup(context, {
    connect: () => {
      if (failing) {
        throw new Error('Native helper unavailable');
      }
    },
  });
  const port = viewPort('ui');
  connected.emit(port);
  port.onMessage.emit({ type: 'hello', id: 'hello', version: APP_VERSION });
  assert.deepEqual(port.messages.at(-1), {
    event: 'connection',
    connected: false,
    error: 'Native helper unavailable',
  });
  failing = false;
  assert.doesNotThrow(() => port.onMessage.emit({ type: 'reconnect' }));
});

test('null or malformed view envelopes and reset confirmations have no receiver-side effects', async (context) => {
  const { connected, requests, clears } = setup(context);
  const view = mockPort('mitter-ui');
  const reset = mockPort('miter-data-view');
  connectView(connected, view);
  connected.emit(reset);
  await settle();

  for (const raw of [
    null,
    [],
    false,
    { id: 'bad', method: 'worker.run', params: null },
    { id: 'bad', method: 'worker.run' },
  ]) {
    view.onMessage.emit(raw);
  }

  for (const confirmation of [null, undefined, true, ['CLEAR']]) {
    reset.onMessage.emit({ type: 'reset-start', id: 'bad', confirmation });
  }

  await settle();
  assert.deepEqual(requests, []);
  assert.deepEqual(clears, []);
});

test('known malformed and native-only UI methods fail before task dependencies can run', async (context) => {
  const { connected, requests } = setup(context);
  const port = mockPort('mitter-ui');
  connectView(connected, port);
  const rejected = [
    ['worker.run', {}],
    ['worker.import', { workerId: 'worker', text: null }],
    ['project.context', { projectId: 'project', save: 'true' }],
    ['worker.teamMessage', { workerId: 'worker', id: 'message', message: 'Context', to: null }],
    ['worker.bridgeLoad', { workerId: 'worker' }],
    ['unknown.method', {}],
  ];
  for (const [index, [method, params]] of rejected.entries()) {
    port.onMessage.emit({ id: 'rejected-' + index, method, params });
  }
  await settle();
  assert.deepEqual(requests, []);
  assert.equal(port.messages.length, rejected.length);
  assert.ok(port.messages.every((message) => message.ok === false));
});

test('malformed known UI acknowledgements cannot be published as success or trigger replay', async (context) => {
  const { views, connected, job, requests } = setup(context);
  const port = mockPort('mitter-ui');
  connectView(connected, port);
  const message = { id: 'run', method: 'worker.run', params: { workerId: 'worker' } };
  port.onMessage.emit(message);
  port.onMessage.emit(message);
  assert.equal(requests.length, 1);
  job.resolve({ started: true, acknowledged: true });
  await views.settled();
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(port.messages.length, 1);
  assert.equal(port.messages[0].ok, false);
  assert.match(port.messages[0].error, /invalid result.*operation may already have completed/);
  assert.equal(port.messages[0].error.includes('"code"'), false);
});

test('UI duplicate in-flight requests do not replay mutations and disposal removes listeners', async (context) => {
  const { views, connected, job, requests } = setup(context);
  const port = mockPort('mitter-ui');
  connectView(connected, port);
  const message = { id: 'run', method: 'worker.run', params: { workerId: 'worker' } };
  port.onMessage.emit(message);
  port.onMessage.emit(message);
  assert.equal(requests.length, 1);
  port.disconnect();
  port.onMessage.emit(message);
  assert.equal(requests.length, 1);
  job.resolve({ started: true });
  await views.settled();
  await settle();
  views.dispose();
  assert.equal(connected.size, 0);
});

test('file reset views can acknowledge barriers but cannot request destructive resets', async (context) => {
  const { connected, clears } = setup(context);
  const file = mockPort(
    'miter-data-view',
    'chrome-extension://extension/file.html?task=worker&file=index.html',
  );
  connected.emit(file);
  await settle();
  file.onMessage.emit({ type: 'reset-start', id: 'reset', confirmation: 'CLEAR' });
  assert.equal(clears.length, 0);
  const workspace = mockPort('miter-data-view');
  connected.emit(workspace);
  await settle();
  workspace.onMessage.emit({ type: 'reset-start', id: 'reset', confirmation: 'CLEAR' });
  await settle();
  assert.deepEqual(clears, ['CLEAR']);
  workspace.disconnect();
  workspace.onMessage.emit({ type: 'reset-start', id: 'stale-reset', confirmation: 'CLEAR' });
  assert.deepEqual(clears, ['CLEAR']);
});
