import test from 'node:test';
import assert from 'node:assert/strict';
import { startBackground } from '../../src/background-controller.ts';
import { chromeEvent, mockPort, deferred, settle } from './chrome-mock.mjs';

function runtime(context) {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const events = {
    connections: chromeEvent(),
    clicks: chromeEvent(),
    commands: chromeEvent(),
    removed: chromeEvent(),
    updated: chromeEvent(),
    notificationClicks: chromeEvent(),
  };
  const native = [];
  const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  globalThis.chrome = {
    runtime: {
      id: 'extension',
      onConnect: events.connections,
      getURL: (page) => 'chrome-extension://extension/' + page,
      getContexts: async () => [],
      connectNative() {
        const port = mockPort('native');
        native.push(port);
        return port;
      },
    },
    storage: { local: storage, session: storage },
    tabs: { onRemoved: events.removed, onUpdated: events.updated },
    action: { onClicked: events.clicks },
    commands: { onCommand: events.commands },
    notifications: { onClicked: events.notificationClicks },
  };

  return { events, native };
}

for (const eventName of ['connections', 'clicks', 'commands', 'removed', 'updated', 'notificationClicks']) {
  test(`background initialization rolls back partial ${eventName} registration`, async (context) => {
    const { events, native } = runtime(context);
    const event = events[eventName];
    const add = event.addListener;
    const failure = new Error('Background listener registration failed');
    event.addListener = (listener) => {
      add(listener);
      throw failure;
    };
    assert.throws(
      () => startBackground(),
      (error) => error === failure,
    );
    await settle();

    for (const resource of Object.values(events)) {
      assert.equal(resource.size, 0);
    }

    context.mock.timers.tick(180000);
    assert.equal(native.length, 0);
  });
}

test('one failed background listener removal does not prevent remaining teardown', async (context) => {
  context.mock.method(console, 'warn', () => {});
  const { events, native } = runtime(context);
  const background = startBackground();
  context.after(() => background.dispose());
  await settle();
  const view = mockPort('mitter-ui');
  events.connections.emit(view);
  view.onMessage.emit({ id: 'prompt', method: 'worker.prompt', params: { workerId: 'worker' } });
  await settle();
  const remove = events.clicks.removeListener;
  events.clicks.removeListener = (listener) => {
    remove(listener);
    throw new Error('Extension event context is unavailable');
  };
  assert.doesNotThrow(() => background.dispose());
  await settle();

  for (const resource of Object.values(events)) {
    assert.equal(resource.size, 0);
  }

  assert.equal(native[0].onMessage.size, 0);
  assert.equal(native[0].onDisconnect.size, 0);
  assert.equal(native[0].disconnects, 1);
  assert.equal(view.onMessage.size, 0);
  assert.equal(view.onDisconnect.size, 0);
  context.mock.timers.tick(180000);
  assert.equal(native.length, 1);
  assert.equal(native[0].messages.length, 1);
});

test('a late command window lookup cannot open a panel after background disposal', async (context) => {
  const { events } = runtime(context);
  const window = deferred();
  const opened = [];
  chrome.windows = { getCurrent: () => window.promise };
  chrome.sidePanel = { open: async (options) => opened.push(options) };
  const background = startBackground();
  context.after(() => background.dispose());
  events.commands.emit('open-mitter');
  background.dispose();
  window.resolve({ id: 7 });
  await settle();
  assert.deepEqual(opened, []);
});

test('background disposal removes all owned Chrome listeners and liveness timers without replay', async (context) => {
  const { events, native } = runtime(context);
  const background = startBackground();
  context.after(() => background.dispose());
  await settle();
  const view = mockPort('mitter-ui');
  events.connections.emit(view);
  view.onMessage.emit({ id: 'prompt', method: 'worker.prompt', params: { workerId: 'worker' } });
  await settle();
  assert.equal(native.length, 1);
  assert.equal(native[0].messages.length, 1);
  background.dispose();
  background.dispose();
  await settle();

  for (const event of Object.values(events)) {
    assert.equal(event.size, 0);
  }

  context.mock.timers.tick(180000);
  assert.equal(native.length, 1);
  assert.equal(native[0].messages.length, 1);
  assert.equal(native[0].disconnects, 1);
});
