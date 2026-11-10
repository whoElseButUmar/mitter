import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftRewrites } from '../../src/background/draft-rewrites.ts';
import { chatViewSchema } from '../../../../packages/bridge/src/dom/types.ts';
import { deferred, settle } from './chrome-mock.mjs';

const request = { instruction: 'Keep the exact draft.', mode: 'clarity', provider: 'chatgpt' };
const view = chatViewSchema.parse({
  url: 'https://chatgpt.com',
  ready: true,
  count: 0,
  userCount: 0,
  lastRole: '',
  assistantId: '',
  assistantText: '',
  lastUserText: '',
  busy: false,
  complete: false,
  draft: false,
  draftText: '',
  stopped: false,
});

function setup(context, timerAPIs = ['setTimeout']) {
  context.mock.timers.enable({ apis: timerAPIs });
  const permissions = [];
  const creations = [];
  const pages = [];
  const liveness = [];
  const permissionGates = [];
  const creationGates = [];
  const starts = [];
  const probe = deferred();
  let pageOperation = async () => view;
  globalThis.chrome = {
    permissions: {
      contains: async (options) => {
        const gate = permissionGates[permissions.length];
        permissions.push(options);

        if (gate) {
          return gate.promise;
        }

        return true;
      },
      request: async () => assert.fail('Rewrite admission must not acquire user-gesture permissions.'),
    },
    tabs: {
      create: async (options) => {
        const gate = creationGates[creations.length];
        creations.push(options);

        if (gate) {
          return gate.promise;
        }

        return { id: 100 + creations.length, ...options };
      },
    },
  };
  const rewrites = new DraftRewrites(
    {
      request: async (tabId, action) => {
        pages.push({ tabId, action });

        if (action.op === 'probe') {
          return probe.promise;
        }

        return pageOperation(tabId, action);
      },
    },
    async () => {
      liveness.push(rewrites.activeTabIds);
    },
  );
  context.after(async () => {
    rewrites.cancelAll();

    for (const gate of permissionGates) {
      gate.resolve(true);
    }

    for (const [index, gate] of creationGates.entries()) {
      gate.resolve({ id: 200 + index, url: 'https://chatgpt.com/' });
    }

    probe.resolve({ ...view, busy: true });
    await Promise.allSettled(starts);
    rewrites.cancelAll();
    await rewrites.quiesce();
  });

  return {
    rewrites,
    permissions,
    creations,
    pages,
    liveness,
    start() {
      const starting = rewrites.start(request, true);
      starts.push(starting);
      void starting.catch(() => {});

      return starting;
    },
    releaseProbe(value = view) {
      probe.resolve(value);
    },
    page(operation) {
      pageOperation = operation;
    },
    deferPermission() {
      const gate = deferred();
      permissionGates.push(gate);

      return gate;
    },
    deferCreation() {
      const gate = deferred();
      creationGates.push(gate);

      return gate;
    },
  };
}

test('rewrite IDs are parsed without coercion and malformed reads or cancels leave the live job unchanged', async (context) => {
  const state = setup(context);
  const result = await state.start();
  let coerced = 0;
  const fakeId = {
    toString() {
      coerced++;
      return result.id;
    },
  };
  const before = { pages: state.pages.length, liveness: state.liveness.length };

  for (const id of [null, undefined, [], [result.id], fakeId]) {
    assert.throws(() => state.rewrites.read(id));
    assert.throws(() => state.rewrites.cancel(id));
  }

  assert.equal(coerced, 0);
  assert.equal(state.rewrites.read(result.id).state, 'waiting');
  assert.deepEqual(state.rewrites.activeTabIds, [result.tabId]);
  assert.equal(state.pages.length, before.pages);
  assert.equal(state.liveness.length, before.liveness);
});

for (const action of ['cancel', 'cancelAll']) {
  test(`${action} releases rewrite liveness immediately and does not resend stop for a cancelled job`, async (context) => {
    const state = setup(context);
    const result = await state.start();
    assert.deepEqual(state.liveness.at(-1), [result.tabId]);

    if (action === 'cancel') {
      state.rewrites.cancel(result.id);
    } else {
      state.rewrites.cancelAll();
    }

    await settle();
    assert.deepEqual(state.liveness.at(-1), []);
    assert.equal(state.rewrites.read(result.id).state, 'cancelled');
    const before = state.pages.length;

    if (action === 'cancel') {
      state.rewrites.cancel(result.id);
    } else {
      state.rewrites.cancelAll();
    }

    await settle();
    assert.equal(state.pages.length, before);
    assert.equal(state.pages.filter(({ action }) => action.op === 'stop').length, 1);
  });
}

test('clearing a registered rewrite cancels it before a late probe can prepare or send the draft', async (context) => {
  const state = setup(context);
  const result = await state.start();
  state.rewrites.clear();
  assert.throws(() => state.rewrites.read(result.id), /expired/);
  assert.equal(state.pages.filter(({ action }) => action.op === 'stop').length, 1);
  let settled = false;
  const quiescing = state.rewrites.quiesce().then(() => {
    settled = true;
  });
  await settle();
  assert.equal(settled, false);
  state.releaseProbe();
  await quiescing;
  assert.equal(settled, true);
  assert.deepEqual(state.rewrites.activeTabIds, []);
  assert.deepEqual(state.liveness.at(-1), []);
  assert.equal(
    state.pages.some(({ action }) => ['prepare', 'commit', 'send'].includes(action.op)),
    false,
  );
  const stops = state.pages.filter(({ action }) => action.op === 'stop');
  assert.equal(stops.length, 2);
  assert.equal(stops[0].action.token, stops[1].action.token);
});

test('failed rewrite results cannot be overwritten or stopped again during later cancellation', async (context) => {
  const state = setup(context);
  const result = await state.start();
  state.releaseProbe({ ...view, busy: true });
  await settle();
  const failed = state.rewrites.read(result.id);
  assert.equal(failed.state, 'error');
  const before = state.pages.length;
  assert.deepEqual(state.rewrites.cancel(result.id), failed);
  state.rewrites.cancelAll();
  await settle();
  assert.deepEqual(state.rewrites.read(result.id), failed);
  assert.equal(state.pages.length, before);
});

test('completed rewrite text survives cancellation without sending stop into a reusable tab', async (context) => {
  const state = setup(context, ['Date', 'setTimeout']);
  const result = await state.start();
  const text = 'Exact completed rewrite.';
  state.page(async (_tabId, action) => {
    if (action.op === 'prepare') {
      return { ...view, outcome: 'already_sent' };
    }

    if (action.op === 'inspect') {
      return {
        ...view,
        url: 'https://chatgpt.com/c/completed',
        complete: true,
        assistantText: JSON.stringify({ protocol: 'miter-rewrite/1', requestId: result.id, text }),
      };
    }

    return view;
  });
  state.releaseProbe();
  await settle();

  for (let step = 0; step < 3; step++) {
    context.mock.timers.tick(1200);
    await settle();
  }

  const completed = state.rewrites.read(result.id);
  assert.equal(completed.state, 'done');
  assert.equal(completed.text, text);
  const before = state.pages.length;
  assert.deepEqual(state.rewrites.cancel(result.id), completed);
  state.rewrites.cancelAll();
  await settle();
  assert.deepEqual(state.rewrites.read(result.id), completed);
  assert.equal(state.pages.length, before);
});

test('pending tab creation reserves the two rewrite slots before runners are registered', async (context) => {
  const state = setup(context);
  const firstTab = state.deferCreation();
  const secondTab = state.deferCreation();
  const first = state.start();
  const second = state.start();
  await settle();
  assert.equal(state.creations.length, 2);
  assert.deepEqual(state.rewrites.activeTabIds, []);
  await assert.rejects(state.start(), /Finish or cancel/);
  assert.equal(state.creations.length, 2);
  firstTab.resolve({ id: 7 });
  assert.equal((await first).state, 'waiting');
  await assert.rejects(state.start(), /Finish or cancel/);
  secondTab.resolve({ id: 8 });
  assert.equal((await second).state, 'waiting');
  assert.deepEqual(state.rewrites.activeTabIds, [7, 8]);
});

test('tab creation errors and missing tab IDs release admission slots for later starts', async (context) => {
  const state = setup(context);
  const failedTab = state.deferCreation();
  const missingTab = state.deferCreation();
  const first = state.start();
  const second = state.start();
  await settle();
  const failed = assert.rejects(first, /Chrome creation failed/);
  failedTab.reject(new Error('Chrome creation failed'));
  await failed;
  const replacement = await state.start();
  assert.equal(replacement.state, 'waiting');
  assert.equal(state.creations.length, 3);
  const missing = assert.rejects(second, /could not open a rewrite chat/);
  missingTab.resolve({ url: 'https://chatgpt.com/' });
  await missing;
  const next = await state.start();
  assert.equal(next.state, 'waiting');
  assert.equal(state.creations.length, 4);
  assert.equal(state.rewrites.activeTabIds.length, 2);
});

test('permission failures release reserved starts without opening or touching a chat', async (context) => {
  const state = setup(context);
  const deniedPermission = state.deferPermission();
  const failedPermission = state.deferPermission();
  const deniedStart = state.start();
  const failedStart = state.start();
  await settle();
  await assert.rejects(state.start(), /Finish or cancel/);
  const denied = assert.rejects(deniedStart, /Allow ChatGPT/);
  const failed = assert.rejects(failedStart, /Chrome permission failed/);
  deniedPermission.resolve(false);
  failedPermission.reject(new Error('Chrome permission failed'));
  await Promise.all([denied, failed]);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
  const results = await Promise.all([state.start(), state.start()]);
  assert.equal(results.length, 2);
  assert.equal(state.rewrites.activeTabIds.length, 2);
});

test('cancellation before the admission microtask skips permission and tab APIs entirely', async (context) => {
  const state = setup(context);
  const starting = state.start();
  state.rewrites.cancelAll();
  await assert.rejects(starting, /cancelled/);
  assert.deepEqual(state.permissions, []);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
  assert.equal((await state.start()).state, 'waiting');
});

test('reset clearing retains retired tab admissions until quiescence drains them', async (context) => {
  const state = setup(context);
  const tab = state.deferCreation();
  const starting = state.start();
  await settle();
  state.rewrites.clear();
  let settled = false;
  const quiescing = state.rewrites.quiesce().then(() => {
    settled = true;
  });
  await settle();
  assert.equal(settled, false);
  const cancelled = assert.rejects(starting, /cancelled/);
  tab.resolve({ id: 7 });
  await Promise.all([cancelled, quiescing]);
  assert.equal(settled, true);
  assert.deepEqual(state.rewrites.tabIds, []);
  assert.deepEqual(state.pages, []);
  assert.deepEqual(state.liveness, []);
});

test('quiescence keeps the existing bounded timeout for an unresponsive admission', async (context) => {
  const state = setup(context);
  const permission = state.deferPermission();
  const starting = state.start();
  await settle();
  const timedOut = assert.rejects(state.rewrites.quiesce(), /Rewrite jobs did not stop/);
  context.mock.timers.tick(45000);
  await timedOut;
  const cancelled = assert.rejects(starting, /cancelled/);
  permission.resolve(true);
  await cancelled;
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.pages, []);
});

for (const action of ['cancelAll', 'clear']) {
  for (const phase of ['permission', 'tab creation']) {
    test(`${action} fences rewrite starts waiting for ${phase}`, async (context) => {
      const state = setup(context);
      let pending;

      if (phase === 'permission') {
        pending = state.deferPermission();
      } else {
        pending = state.deferCreation();
      }

      const starting = state.start();
      await settle();
      assert.equal(state.permissions.length, 1);

      if (phase === 'tab creation') {
        assert.equal(state.creations.length, 1);
      }

      state.rewrites[action]();
      const cancelled = assert.rejects(starting, /cancelled/);

      if (phase === 'permission') {
        pending.resolve(true);
      } else {
        pending.resolve({ id: 7 });
      }

      await cancelled;
      assert.deepEqual(state.rewrites.tabIds, []);
      assert.deepEqual(state.pages, []);
      assert.deepEqual(state.liveness, []);

      if (phase === 'permission') {
        assert.deepEqual(state.creations, []);
      }

      const fresh = await state.start();
      assert.equal(fresh.state, 'waiting');
    });
  }
}

for (const phase of ['permission', 'tab creation']) {
  test(`quiescence fences and drains starts waiting for ${phase} before admitting new work`, async (context) => {
    const state = setup(context);
    let pending;

    if (phase === 'permission') {
      pending = state.deferPermission();
    } else {
      pending = state.deferCreation();
    }

    const starting = state.start();
    await settle();
    let settled = false;
    const quiescing = state.rewrites.quiesce().then(() => {
      settled = true;
    });
    await settle();
    assert.equal(settled, false);
    await assert.rejects(state.start(), /cancelled|stopping/);
    const cancelled = assert.rejects(starting, /cancelled/);

    if (phase === 'permission') {
      pending.resolve(true);
    } else {
      pending.resolve({ id: 7 });
    }

    await Promise.all([cancelled, quiescing]);
    assert.equal(settled, true);
    assert.deepEqual(state.rewrites.tabIds, []);
    assert.deepEqual(state.pages, []);
    assert.deepEqual(state.liveness, []);
    state.rewrites.clear();
    assert.equal((await state.start()).state, 'waiting');
  });
}
