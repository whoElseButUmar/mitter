import './reset-module-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearPageState } from '../../src/background/storage-reset.ts';
import { mockPort, deferred, settle } from './chrome-mock.mjs';

function webStorage() {
  let length = 1;

  return {
    clear() {
      length = 0;
    },
    get length() {
      return length;
    },
  };
}

function resetRuntime(context, write = Promise.resolve(), configurePort = () => {}) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const ports = [];
  globalThis.location = {
    href: 'chrome-extension://extension/workspace.html',
    reload() {},
  };
  globalThis.history = {
    state: null,
    replaceState(_state, _title, url) {
      location.href = url;
    },
  };
  globalThis.localStorage = webStorage();
  globalThis.sessionStorage = webStorage();
  globalThis.chrome = {
    runtime: {
      connect() {
        const port = mockPort('miter-data-view');
        configurePort(port, ports.length);
        ports.push(port);
        return port;
      },
    },
    storage: { local: { set: () => write } },
  };

  return ports;
}

test('view reset acknowledgement waits for writes, proves the exact document nonce, and never reopens writes', async (context) => {
  const write = deferred();
  const ports = resetRuntime(context, write.promise);
  const { persistLocal, connectResetView } = await import('../../src/data-view.ts?barrier-test');
  const states = [];
  let stopped = 0;
  const view = connectResetView(
    (state) => states.push(state),
    () => {
      stopped++;
    },
  );
  context.after(() => view.close());
  const pendingWrite = persistLocal({ preference: 'old' });
  const port = ports[0];
  port.onMessage.emit({
    type: 'reset-quiesce',
    id: 'document-nonce',
    identify: true,
  });
  await settle();
  assert.equal(stopped, 1);
  assert.equal(port.messages.length, 0);
  await assert.rejects(persistLocal({ preference: 'late' }), /No preferences were saved/);
  write.resolve();
  await pendingWrite;
  await settle();
  assert.deepEqual(port.messages[0], {
    type: 'reset-ack',
    id: 'document-nonce',
    ok: true,
  });
  assert.equal(new URL(location.href).searchParams.get('__miter_reset_view'), 'document-nonce');
  port.onMessage.emit({ type: 'reset-identified', id: 'wrong-nonce' });
  assert.equal(new URL(location.href).searchParams.get('__miter_reset_view'), 'document-nonce');
  port.onMessage.emit({ type: 'reset-identified', id: 'document-nonce' });
  assert.equal(new URL(location.href).searchParams.has('__miter_reset_view'), false);
  port.onMessage.emit({ type: 'reset-state', state: { phase: 'idle' } });
  assert.equal(states.at(-1).phase, 'failed');
  await assert.rejects(persistLocal({ preference: 'still locked' }));
});

test('lost destructive reset requests are rejected, never replayed on status reconnect', async (context) => {
  const ports = resetRuntime(context);
  const { connectResetView } = await import('../../src/data-view.ts?reconnect-test');
  const states = [];
  const view = connectResetView(
    (state) => states.push(state),
    () => {},
  );
  context.after(() => view.close());
  const old = ports[0];
  const request = view.clear('CLEAR');
  const id = old.messages[0].id;
  old.disconnect();
  await assert.rejects(request, /disconnected/);
  assert.equal(old.onMessage.size, 0);
  assert.equal(old.onDisconnect.size, 0);
  context.mock.timers.tick(250);
  const next = ports[1];
  assert.equal(next.messages.length, 0);
  old.onMessage.emit({ type: 'reset-state', state: { phase: 'complete' } });
  next.onMessage.emit({ type: 'reset-state', state: { phase: 'idle' } });
  assert.equal(states.at(-1).phase, 'idle');
  old.onMessage.emit({ id, ok: true });
  assert.equal(next.messages.length, 0);
  view.close();
  assert.equal(next.onMessage.size, 0);
  assert.equal(next.onDisconnect.size, 0);
  context.mock.timers.tick(600000);
  assert.equal(ports.length, 2);
});

for (const eventName of ['onMessage', 'onDisconnect']) {
  test(`reset view cleans up partial ${eventName} registration and reconnects for status only`, async (context) => {
    const connections = [];
    const ports = resetRuntime(context, Promise.resolve(), (port, index) => {
      if (index !== 0) {
        return;
      }

      const add = port[eventName].addListener;
      port[eventName].addListener = (listener) => {
        add(listener);
        throw new Error('Reset listener registration failed');
      };
    });
    const { connectResetView } = await import('../../src/data-view.ts?registration-' + eventName);
    const view = connectResetView(
      () => {},
      () => {},
      (...event) => connections.push(event),
    );
    context.after(() => view.close());
    const old = ports[0];
    assert.equal(old.onMessage.size, 0);
    assert.equal(old.onDisconnect.size, 0);
    assert.equal(old.disconnects, 1);
    assert.match(connections[0][1], /Reset listener registration failed/);
    await assert.rejects(view.clear('CLEAR'), /reconnecting/);
    context.mock.timers.tick(250);
    assert.equal(ports.length, 2);
    const next = ports[1];
    next.onMessage.emit({ type: 'reset-state', state: { phase: 'idle' } });
    assert.deepEqual(connections.at(-1), [true]);
    assert.equal(next.messages.length, 0);
    view.close();
    assert.equal(next.onMessage.size, 0);
    assert.equal(next.onDisconnect.size, 0);
    context.mock.timers.tick(600000);
    assert.equal(ports.length, 2);
  });
}

test('reset readiness timeout retires listeners and queued old messages cannot complete the new reset', async (context) => {
  const queued = [];
  const ports = resetRuntime(context, Promise.resolve(), (port) => {
    const callbacks = {};
    queued.push(callbacks);

    for (const eventName of ['onMessage', 'onDisconnect']) {
      const add = port[eventName].addListener;
      port[eventName].addListener = (listener) => {
        callbacks[eventName] = listener;
        add(listener);
      };
    }
  });
  const { connectResetView } = await import('../../src/data-view.ts?readiness-timeout');
  const states = [];
  const view = connectResetView(
    (state) => states.push(state),
    () => {},
  );
  context.after(() => view.close());
  context.mock.timers.tick(10000);
  const old = ports[0];
  assert.equal(old.onMessage.size, 0);
  assert.equal(old.onDisconnect.size, 0);
  assert.equal(old.disconnects, 1);
  context.mock.timers.tick(250);
  const next = ports[1];
  next.onMessage.emit({ type: 'reset-state', state: { phase: 'idle' } });
  const request = view.clear('CLEAR');
  const id = next.messages[0].id;
  const before = states.length;
  queued[0].onMessage({ type: 'reset-state', state: { phase: 'complete' } });
  queued[0].onMessage({ id, ok: true });
  queued[0].onDisconnect();
  assert.equal(states.length, before);
  next.onMessage.emit({ id, ok: true });
  await request;
  view.close();
  assert.equal(next.onMessage.size, 0);
  assert.equal(next.onDisconnect.size, 0);
  context.mock.timers.tick(600000);
  assert.equal(ports.length, 2);
});

test('page resets require the exact request nonce and a validated clear receipt', async () => {
  globalThis.chrome = {
    permissions: { getAll: async () => ({ origins: [] }) },
    tabs: {
      sendMessage: async (_tabId, message) => ({
        channel: 'mitter-page/4',
        instanceId: 'endpoint',
        id: 'another-request',
        ok: true,
        value: { cleared: true },
      }),
    },
  };
  let forgotten = 0;
  await assert.rejects(
    clearPageState(new Set([7]), () => {
      forgotten++;
    }),
    /another request/,
  );
  assert.equal(forgotten, 0);
  chrome.tabs.sendMessage = async (_tabId, message) => ({
    channel: 'mitter-page/4',
    instanceId: 'endpoint',
    id: message.id,
    ok: true,
    value: { cleared: true },
  });
  await clearPageState(new Set([7]), () => {
    forgotten++;
  });
  assert.equal(forgotten, 1);
});

test('old endpoint refresh cannot inject into a lookalike provider origin', async () => {
  let injected = false;
  globalThis.chrome = {
    permissions: {
      getAll: async () => ({ origins: [] }),
      contains: async () => true,
    },
    tabs: {
      sendMessage: async (_tabId, message) => ({
        channel: 'mitter-page/4',
        instanceId: 'endpoint',
        id: message.id,
        ok: false,
        error: { code: 'BAD_REQUEST' },
      }),
      get: async () => ({ url: 'https://chatgpt.com.attacker.example/' }),
    },
    scripting: {
      executeScript: async () => {
        injected = true;
      },
    },
  };
  await assert.rejects(
    clearPageState(new Set([7]), () => {}),
    /different document/,
  );
  assert.equal(injected, false);
});
