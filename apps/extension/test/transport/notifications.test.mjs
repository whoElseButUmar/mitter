import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskNotifications } from '../../src/background/notifications.ts';
import { chromeEvent, deferred, settle } from './chrome-mock.mjs';

function notificationHarness(context, options = {}) {
  const broadcasts = [];
  const creations = [];
  const cleared = [];
  const sounds = [];
  const clicked = chromeEvent();
  const stored = options.stored ?? { 'miter.notifications.v1': { enabled: true, sound: true } };
  let blocked = false;
  globalThis.chrome = {
    runtime: { getURL: (path) => 'chrome-extension://extension/' + path },
    storage: {
      local: {
        get: async () => {
          if (options.read) {
            return options.read();
          }
          return structuredClone(stored);
        },
        set: async (changes) => Object.assign(stored, structuredClone(changes)),
      },
    },
    permissions: { contains: async () => true },
    notifications: {
      onClicked: clicked,
      create: async (id, value) => {
        creations.push({ id, ...value });
        await options.create?.(id);
        return id;
      },
      clear: async (id) => cleared.push(id),
    },
  };
  const notifications = new TaskNotifications({
    blocked: () => blocked,
    broadcast: (message) => broadcasts.push(message),
    ding: () => sounds.push('ding'),
    openTask: async (id) => options.open?.(id),
    log() {},
  });
  context.after(() => notifications.dispose());
  const worker = { id: 'worker', name: 'Cozy Desk', goal: 'Build a board', state: 'executing' };
  const bridge = { workerId: worker.id, phase: 'error', reason: 'Open chat to check sign-in.' };
  return {
    notifications,
    broadcasts,
    creations,
    cleared,
    sounds,
    clicked,
    worker,
    bridge,
    setBlocked(value) {
      blocked = value;
    },
  };
}

test('routine work stays quiet and only verified browser results say App ready', async (context) => {
  const { notifications, broadcasts, creations, worker } = notificationHarness(context);
  await notifications.read();
  for (const state of ['idle', 'planning', 'executing', 'verifying', 'review', 'executing']) {
    notifications.snapshot({ events: [], workers: [{ ...worker, state }] });
  }
  assert.deepEqual(broadcasts, []);
  notifications.snapshot({
    events: [],
    workers: [
      {
        ...worker,
        state: 'complete',
        completion: {
          verification: 'passed',
          evidence: { browser: 'passed', lighthouse: 'passed', detail: 'Checks passed.' },
        },
      },
    ],
  });
  await notifications.quiesce();
  assert.equal(broadcasts[0].data.message, 'App ready · Cozy Desk');
  assert.equal(creations[0].title, 'Miter · App ready');
  notifications.snapshot({ events: [], workers: [{ ...worker, state: 'executing' }] });
  notifications.snapshot({
    events: [],
    workers: [{ ...worker, state: 'complete', completion: { verification: 'not-run' } }],
  });
  await notifications.quiesce();
  assert.equal(creations[1].title, 'Miter · Task complete');
});

test('marks setup approvals for the workspace while keeping the Chrome notification', async (context) => {
  const { notifications, broadcasts, creations, worker } = notificationHarness(context);
  await notifications.read();
  notifications.snapshot({ events: [], workers: [worker] });
  notifications.snapshot({
    events: [],
    workers: [{ ...worker, state: 'awaiting_approval', pending: { action: { type: 'setupCommand' } } }],
  });
  await notifications.quiesce();
  assert.equal(broadcasts[0].data.setupApproval, true);
  assert.equal(creations[0].title, 'Miter · Approval needed');
});

for (const first of ['bridge', 'host']) {
  test(`one attention event stays quiet across changing reasons and ${first}-first host/bridge delivery`, async (context) => {
    const { notifications, broadcasts, creations, worker, bridge } = notificationHarness(context);
    await notifications.read();
    notifications.snapshot({ events: [], workers: [worker] });
    if (first === 'host') {
      notifications.snapshot({ events: [], workers: [{ ...worker, state: 'blocked' }] });
    }
    notifications.bridge(bridge, worker);
    notifications.snapshot({ events: [], workers: [{ ...worker, state: 'blocked' }] });
    notifications.bridge({ ...bridge, reason: 'Still waiting for the same page.' }, worker);
    await notifications.quiesce();
    assert.equal(broadcasts.length, 1);
    assert.equal(creations.length, 1);
    assert.match(creations[0].message, /Cozy Desk/);
    notifications.snapshot({ events: [], workers: [worker] });
    notifications.bridge({ ...bridge, phase: 'connecting' }, worker);
    notifications.bridge(bridge, worker);
    await notifications.quiesce();
    assert.equal(creations.length, 2, 'A new failed attempt may notify after work resumed.');
  });
}

test('terminal tasks and replies already being received do not raise stale chat warnings', async (context) => {
  const { notifications, broadcasts, creations, worker, bridge } = notificationHarness(context);
  await notifications.read();
  const states = [
    { state: 'complete' },
    { state: 'cancelled' },
    { control: { mode: 'stopped' } },
    { pending: { token: 'reviewed-command' } },
    { humanAcceptanceReady: true },
  ];
  for (const [index, change] of states.entries()) {
    const id = 'worker-' + index;
    notifications.bridge({ ...bridge, workerId: id }, { ...worker, ...change, id });
  }
  notifications.bridge({ ...bridge, monitoring: true, receiving: true }, worker);
  await notifications.quiesce();
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(creations, []);
});

test('notifications wait for saved preferences and retire pending delivery when work resumes', async (context) => {
  const read = deferred();
  const { notifications, creations, worker, bridge } = notificationHarness(context, {
    read: () => read.promise,
  });
  notifications.snapshot({ events: [], workers: [worker] });
  notifications.bridge(bridge, worker);
  assert.deepEqual(creations, []);
  read.resolve({ 'miter.notifications.v1': { enabled: true, sound: false } });
  await notifications.quiesce();
  assert.equal(creations.length, 1);
  notifications.snapshot({ events: [], workers: [{ ...worker, state: 'complete' }] });
  notifications.snapshot({ events: [], workers: [worker] });
  await notifications.quiesce();
  assert.equal(creations.length, 1, 'A superseded completion cannot notify after work resumed.');
});

for (const retirement of ['newer notice', 'mute', 'reset', 'dispose', 'blocked']) {
  test(`an in-flight desktop notification does not chime after ${retirement}`, async (context) => {
    const first = deferred();
    let creations = 0;
    const state = notificationHarness(context, {
      create: () => {
        creations++;
        if (creations === 1) {
          return first.promise;
        }
      },
    });
    const { notifications, sounds, worker, bridge } = state;
    await notifications.read();
    notifications.snapshot({ events: [], workers: [worker] });
    notifications.bridge(bridge, worker);
    await settle();
    assert.equal(creations, 1);
    if (retirement === 'newer notice') {
      notifications.snapshot({ events: [], workers: [{ ...worker, state: 'complete' }] });
      await settle();
      assert.deepEqual(sounds, ['ding']);
    } else if (retirement === 'mute') {
      await notifications.set({ sound: false });
    } else if (retirement === 'reset') {
      notifications.clear();
    } else if (retirement === 'dispose') {
      notifications.dispose();
    } else {
      state.setBlocked(true);
    }
    const priorSounds = [...sounds];
    first.resolve();
    await notifications.quiesce();
    assert.deepEqual(sounds, priorSounds);
  });
}

test('opening an older notification cannot dismiss a newer result for the same task', async (context) => {
  const open = deferred();
  const { notifications, clicked, cleared, worker, bridge } = notificationHarness(context, {
    open: () => open.promise,
  });
  await notifications.read();
  notifications.snapshot({ events: [], workers: [worker] });
  notifications.bridge(bridge, worker);
  await notifications.quiesce();
  clicked.emit('miter-task-worker');
  notifications.snapshot({ events: [], workers: [{ ...worker, state: 'complete' }] });
  await notifications.quiesce();
  open.resolve();
  await settle();
  assert.deepEqual(cleared, []);
});

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
    notifications.snapshot({ events: [], workers: [worker] });
    notifications.snapshot({ events: [], workers: [{ ...worker, state: 'complete' }] });
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
    [{}, { enabled: false, sound: true }],
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
    assert.deepEqual(await notifications.read(), { enabled: false, sound: lifecycle === 'reset' });
  });
}

test('history survives replacement and the default sound does not require desktop alerts', async (context) => {
  const stored = {};
  const { notifications, creations, sounds, worker } = notificationHarness(context, { stored });
  notifications.snapshot({ events: [], workers: [worker] });
  notifications.snapshot({ events: [], workers: [{ ...worker, state: 'complete' }] });
  const first = await notifications.readHistory();
  await notifications.quiesce();
  assert.equal(first.length, 1);
  assert.equal(first[0].workerId, worker.id);
  assert.equal(first[0].message, 'Task complete · Cozy Desk');
  assert.deepEqual(creations, []);
  assert.deepEqual(sounds, ['ding']);
  notifications.dispose();

  const restarted = notificationHarness(context, { stored });
  assert.deepEqual(await restarted.notifications.readHistory(), first);
  restarted.notifications.snapshot({ events: [], workers: [{ ...worker, state: 'complete' }] });
  await restarted.notifications.quiesce();
  assert.deepEqual(restarted.sounds, []);
  await restarted.notifications.set({ sound: false });
  restarted.notifications.publish(
    { workerId: worker.id, kind: 'warning', message: 'Approval needed' },
    'Approval needed',
    worker.name,
  );
  assert.deepEqual(
    (await restarted.notifications.readHistory()).map((notice) => notice.message),
    ['Approval needed', 'Task complete · Cozy Desk'],
  );
  await restarted.notifications.quiesce();
  assert.deepEqual(restarted.sounds, []);
});

test('rapid completions are recorded once without replaying old goal events on startup', async (context) => {
  const { notifications, worker, sounds } = notificationHarness(context);
  const completed = { ...worker, state: 'complete' };
  notifications.snapshot({ workers: [completed], events: [{ id: 1, kind: 'goal', workerId: worker.id }] });
  assert.deepEqual(await notifications.readHistory(), []);

  const next = { ...completed, id: 'fast-task' };
  const snapshot = { workers: [completed, next], events: [{ id: 2, kind: 'goal', workerId: next.id }] };
  notifications.snapshot(snapshot);
  notifications.snapshot(snapshot);
  await notifications.quiesce();
  assert.deepEqual(
    (await notifications.readHistory()).map((notice) => notice.workerId),
    [next.id],
  );
  assert.deepEqual(sounds, ['ding']);
});

test('a damaged history does not overwrite it or change the saved sound preference', async (context) => {
  const stored = {
    'miter.notifications.v1': { enabled: false, sound: true },
    'miter.notificationHistory.v1': 'invalid saved history',
  };
  const { notifications, sounds, worker } = notificationHarness(context, { stored });
  await assert.rejects(notifications.readHistory(), /history is unavailable/);
  assert.deepEqual(await notifications.read(), { enabled: false, sound: true });
  notifications.publish(
    { workerId: worker.id, kind: 'success', message: 'Task complete' },
    'Task complete',
    worker.name,
  );
  await notifications.quiesce();
  assert.equal(stored['miter.notificationHistory.v1'], 'invalid saved history');
  assert.deepEqual(sounds, ['ding']);
});

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
  notifications.snapshot({ events: [], workers: [worker] });
  notifications.snapshot({ events: [], workers: [{ ...worker, state: 'complete' }] });
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
