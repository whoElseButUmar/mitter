import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadWorkspace } from '../../src/workspace-reload.ts';
import { startBackground } from '../../src/background-controller.ts';
import { chromeEvent, mockPort, deferred, settle, snapshot } from './chrome-mock.mjs';
import { APP_VERSION, BUILD_ID } from '../../../../packages/protocol/src/index.ts';

function runtime(context) {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const events = {
    connections: chromeEvent(),
    installed: chromeEvent(),
    startup: chromeEvent(),
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
      onInstalled: events.installed,
      onStartup: events.startup,
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

test('background opens the native terminal relay without a workspace view', async (context) => {
  const { native } = runtime(context);
  const background = startBackground();
  context.after(() => background.dispose());
  await settle();
  assert.equal(native.length, 0);
  context.mock.timers.tick(1000);
  await settle();
  assert.equal(native.length, 1);
  assert.equal(native[0].messages.length, 0);
  native[0].onMessage.emit({ event: 'snapshot', data: snapshot });
  context.mock.timers.tick(1000);
  await settle();
  const claim = native[0].messages[0];
  assert.equal(claim.method, 'terminal.claim');
  assert.equal(claim.params.version, APP_VERSION);
  assert.equal(claim.params.buildId, BUILD_ID);
  assert.equal(claim.params.available, true);
  native[0].onMessage.emit({ id: claim.id, ok: true, result: { command: null } });
  await settle();
  background.dispose();
  context.mock.timers.tick(180000);
  assert.equal(native.length, 1);
  assert.equal(native[0].messages.length, 1);
});

for (const eventName of [
  'connections',
  'installed',
  'startup',
  'clicks',
  'commands',
  'removed',
  'updated',
  'notificationClicks',
]) {
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
  view.onMessage.emit({ type: 'hello', id: 'version-check', version: APP_VERSION });
  native[0].onMessage.emit({ event: 'snapshot', data: snapshot });
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
  view.onMessage.emit({ type: 'hello', id: 'version-check', version: APP_VERSION });
  native[0].onMessage.emit({ event: 'snapshot', data: snapshot });
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

test('a requested extension update returns to its window once and reuses a surviving workspace', async (context) => {
  const { events } = runtime(context);
  const background = startBackground();
  context.after(() => background.dispose());

  const windowId = 8;
  const url = chrome.runtime.getURL('workspace.html');
  const records = {};
  const created = [];
  const activated = [];
  let contexts = [];
  let reloads = 0;
  chrome.windows = { getCurrent: async () => ({ id: windowId }) };
  chrome.storage.local.get = async (key) => ({ [key]: records[key] });
  chrome.storage.local.set = async (record) => Object.assign(records, record);
  chrome.storage.local.remove = async (key) => {
    delete records[key];
  };
  chrome.runtime.reload = () => {
    reloads++;
  };
  chrome.runtime.getContexts = async (filter) => {
    assert.deepEqual(filter, { windowIds: [windowId] });
    return contexts;
  };
  chrome.tabs.create = async (data) => created.push(data);
  chrome.tabs.update = async (id, data) => activated.push({ id, data });

  events.installed.emit({ reason: 'update' });
  await settle();
  assert.deepEqual(created, []);
  await reloadWorkspace();
  assert.equal(reloads, 1);
  events.installed.emit({ reason: 'update' });
  await settle();
  assert.deepEqual(created, [{ windowId, url, active: true }]);
  events.installed.emit({ reason: 'update' });
  await settle();
  assert.equal(created.length, 1);

  contexts = [{ contextType: 'TAB', tabId: 32, documentUrl: url + '?task=test' }];
  await reloadWorkspace();
  events.installed.emit({ reason: 'update' });
  await settle();
  assert.deepEqual(activated, [{ id: 32, data: { active: true } }]);
  assert.equal(created.length, 1);

  await reloadWorkspace();
  Object.values(records)[0].requestedAt -= 60001;
  events.installed.emit({ reason: 'update' });
  await settle();
  assert.deepEqual(records, {});
  assert.equal(activated.length, 1);
});

test('a same-release helper mismatch blocks new work, reset and terminal polling until a matching snapshot', async (context) => {
  const { events, native } = runtime(context);
  const background = startBackground();
  context.after(() => background.dispose());
  const view = mockPort('mitter-ui');
  events.connections.emit(view);
  view.onMessage.emit({ type: 'hello', id: 'hello', version: APP_VERSION, buildId: BUILD_ID });
  const create = {
    id: 'create',
    method: 'project.create',
    params: { parentRoot: '/projects', folderName: 'notes', name: 'Notes' },
  };
  view.onMessage.emit(create);
  await settle();
  assert.equal(native[0].messages.length, 0);
  assert.match(view.messages.find((message) => message.id === 'create').error, /Checking the local helper/);
  const stale = { ...snapshot, runtime: { ...snapshot.runtime, buildId: 'a'.repeat(16) } };
  native[0].onMessage.emit({ event: 'snapshot', data: stale });
  view.onMessage.emit({ ...create, id: 'old-create' });
  view.onMessage.emit({ id: 'debug', method: 'debug.read', params: {} });
  const reset = mockPort('miter-data-view');
  events.connections.emit(reset);
  reset.onMessage.emit({ type: 'reset-start', id: 'old-reset', confirmation: 'CLEAR' });
  context.mock.timers.tick(6000);
  await settle();
  assert.equal(native[0].messages.length, 0);
  assert.match(view.messages.find((message) => message.id === 'old-create').error, /aaaaaaaaaaaaaaaa/);
  assert.equal(view.messages.find((message) => message.id === 'debug').ok, true);
  assert.match(reset.messages.find((message) => message.id === 'old-reset').error, /aaaaaaaaaaaaaaaa/);
  const peer = view.messages.find((message) => message.event === 'connection' && message.helper);
  assert.equal(peer.helper.buildId, stale.runtime.buildId);
  native[0].onMessage.emit({
    event: 'snapshot',
    data: { ...snapshot, runtime: { ...snapshot.runtime, buildId: BUILD_ID } },
  });
  await settle();
  assert.equal(native[0].messages.length, 0);
  context.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(
    native[0].messages.map((message) => message.method),
    ['terminal.claim'],
  );
});
