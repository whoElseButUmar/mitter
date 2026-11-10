import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskNotifications } from '../../src/background/notifications.ts';
import { chromeEvent, deferred, settle } from './chrome-mock.mjs';

test('malformed notification storage envelopes cannot enable notifications or cause effects', async (context) => {
  const misleadingArray = Object.assign([], {
    'miter.notifications.v1': { enabled: true, sound: true },
  });

  for (const stored of [null, [], misleadingArray, 'stored settings']) {
    const writes = [];
    const broadcasts = [];
    const creations = [];
    const sounds = [];
    const logs = [];
    globalThis.chrome = {
      storage: {
        local: {
          get: async () => stored,
          set: async (value) => writes.push(value),
        },
      },
      permissions: { contains: async () => assert.fail('A rejected storage read cannot check permissions.') },
      notifications: {
        onClicked: chromeEvent(),
        create: async (id, value) => creations.push({ id, value }),
      },
    };
    const notifications = new TaskNotifications({
      blocked: () => false,
      broadcast: (value) => broadcasts.push(value),
      ding: () => sounds.push('ding'),
      openTask: async () => assert.fail('A rejected storage read cannot open a task.'),
      log: (kind, message) => logs.push({ kind, message }),
    });
    context.after(() => notifications.dispose());
    assert.deepEqual(await notifications.read(), { enabled: false, sound: false });
    assert.deepEqual(broadcasts, []);
    const worker = { id: 'worker', name: 'Task', goal: 'Goal', state: 'idle' };
    notifications.snapshot({ workers: [worker] });
    notifications.snapshot({ workers: [{ ...worker, state: 'complete' }] });
    await settle();
    assert.deepEqual(writes, []);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].event, 'taskNotification');
    assert.deepEqual(creations, []);
    assert.deepEqual(sounds, []);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].kind, 'notification.settings.error');
    assert.equal(logs[0].message.includes('Cannot read properties'), false);
    notifications.dispose();
  }
});

test('notification storage migration retains valid fields and independently disables corrupt preferences', async (context) => {
  const cases = [
    [{}, { enabled: false, sound: false }],
    [{ 'miter.notifications.v1': null }, { enabled: false, sound: false }],
    [{ 'miter.notifications.v1': { enabled: 'yes', sound: true } }, { enabled: false, sound: true }],
    [{ 'miter.notifications.v1': { enabled: true, sound: null } }, { enabled: true, sound: false }],
  ];

  for (const [stored, expected] of cases) {
    globalThis.chrome = { storage: { local: { get: async () => stored } } };
    const notifications = new TaskNotifications({
      blocked: () => false,
      broadcast: () => assert.fail('Restoring preferences cannot broadcast an unsaved update.'),
      ding: () => assert.fail('Restoring preferences cannot play a sound.'),
      openTask: async () => {},
      log: () => assert.fail('A valid storage envelope must use migration defaults without an error.'),
    });
    context.after(() => notifications.dispose());
    assert.deepEqual(await notifications.read(), expected);
    notifications.dispose();
  }
});

for (const lifecycle of ['reset', 'dispose']) {
  test(`notification permission results cannot save preferences after ${lifecycle}`, async (context) => {
    const permission = deferred();
    const clicked = chromeEvent();
    const writes = [];
    const broadcasts = [];
    let blocked = false;
    globalThis.chrome = {
      storage: {
        local: {
          get: async () => ({}),
          set: async (values) => writes.push(values),
        },
      },
      permissions: { contains: () => permission.promise },
      notifications: { onClicked: clicked },
    };
    const notifications = new TaskNotifications({
      blocked: () => blocked,
      broadcast: (message) => broadcasts.push(message),
      ding() {},
      openTask: async () => {},
      log() {},
    });
    context.after(() => notifications.dispose());
    const setting = notifications.set({ enabled: true });
    await settle();

    if (lifecycle === 'reset') {
      blocked = true;
    } else {
      notifications.dispose();
    }

    const rejected = assert.rejects(setting, /not saved/);
    permission.resolve(true);
    await rejected;
    assert.deepEqual(writes, []);
    assert.deepEqual(broadcasts, []);
    assert.deepEqual(await notifications.read(), { enabled: false, sound: false });
  });
}

test('clearing notifications fences an in-flight settings read and permission check', async (context) => {
  const read = deferred();
  const permission = deferred();
  const writes = [];
  globalThis.chrome = {
    storage: { local: { get: () => read.promise, set: async (values) => writes.push(values) } },
    permissions: { contains: () => permission.promise },
  };
  const notifications = new TaskNotifications({
    blocked: () => false,
    broadcast() {},
    ding() {},
    openTask: async () => {},
    log() {},
  });
  context.after(() => notifications.dispose());
  notifications.clear();
  read.resolve({ 'miter.notifications.v1': { enabled: true, sound: true } });
  assert.deepEqual(await notifications.read(), { enabled: false, sound: false });
  const setting = notifications.set({ enabled: true });
  await settle();
  notifications.clear();
  const rejected = assert.rejects(setting, /not saved/);
  permission.resolve(true);
  await rejected;
  assert.deepEqual(writes, []);
});

test('notification IDs route to exactly one task across reloads, retries, and reset clearing', async (context) => {
  const clicked = chromeEvent();
  const opened = [];
  const cleared = [];
  const creations = [];
  let opening = deferred();
  globalThis.chrome = {
    runtime: { getURL: (path) => 'chrome-extension://extension/' + path },
    storage: { local: { get: async () => ({ 'miter.notifications.v1': { enabled: true, sound: false } }) } },
    notifications: {
      onClicked: clicked,
      create: async (id, notification) => creations.push({ id, notification }),
      clear: async (id) => cleared.push(id),
    },
  };
  const notifications = new TaskNotifications({
    blocked: () => false,
    broadcast() {},
    ding() {},
    openTask: async (id) => {
      opened.push(id);
      await opening.promise;
    },
    log() {},
  });
  context.after(() => notifications.dispose());
  await notifications.read();
  const worker = { id: 'worker-with-dashes', name: 'Task', goal: 'Goal', state: 'idle' };
  notifications.snapshot({ workers: [worker] });
  notifications.snapshot({ workers: [{ ...worker, state: 'complete' }] });
  await settle();
  const id = 'miter-task-worker-with-dashes';
  assert.equal(creations[0].id, id);
  clicked.emit('unrelated-notification');
  clicked.emit('miter-task-');
  clicked.emit(id);
  clicked.emit(id);
  assert.deepEqual(opened, [worker.id]);
  opening.reject(new Error('Keep the notification available for retry.'));
  await settle();
  assert.deepEqual(cleared, []);
  opening = deferred();
  notifications.clear();
  clicked.emit(id);
  opening.resolve();
  await settle();
  assert.deepEqual(opened, [worker.id, worker.id]);
  assert.deepEqual(cleared, [id]);
  notifications.dispose();
  assert.equal(clicked.size, 0);
});
