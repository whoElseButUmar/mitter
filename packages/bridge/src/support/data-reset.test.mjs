import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';
import { setImmediate } from 'node:timers/promises';
const { DATA_RESET_KEY, DataResetCoordinator } = await import('../data-reset.ts');

function resetHarness(overrides = {}) {
  const data = {};
  const events = [];
  const deps = {
    storage: {
      async get() {
        return { ...data };
      },
      async set(values) {
        Object.assign(data, values);
        events.push('lock');
      },
      async remove(key) {
        delete data[key];
        events.push('unlock');
      },
    },
    async quiesceViews() {
      events.push('views');
    },
    async stop() {
      events.push('workers');
    },
    async hostPrepare() {
      events.push('prepare');
      return { prepared: true };
    },
    async hostClear() {
      events.push('native');
      return { cleared: true, failures: [], preserved: ['project files'] };
    },
    async clearBrowser() {
      events.push('browser');
      for (const key of Object.keys(data)) {
        delete data[key];
      }
    },
    async hostComplete() {
      events.push('commit');
      return { cleared: true };
    },
    publish(state) {
      if (state.phase === 'clearing') {
        events.push(state.step);
      } else {
        events.push(state.phase);
      }
    },
    restart: () => events.push('restart'),
    ...overrides,
  };
  return { coordinator: new DataResetCoordinator(deps), data, events };
}

test('reset refuses native deletion until every writer barrier settles successfully', async () => {
  const views = Promise.withResolvers();
  const preparation = Promise.withResolvers();
  const harness = resetHarness({
    quiesceViews: () => views.promise,
    hostPrepare: () => preparation.promise,
  });
  const clearing = harness.coordinator.clear('CLEAR');
  const rejected = assert.rejects(clearing, /Open views: Error: Refused/);
  await setImmediate();
  await assert.rejects(harness.coordinator.clear('CLEAR'), /already running/);
  views.reject(new Error('Refused'));
  await setImmediate();
  assert.equal(harness.coordinator.busy, true);
  assert.equal(harness.events.includes('native'), false);
  preparation.resolve({ prepared: true });
  await rejected;
  assert.equal(harness.coordinator.busy, false);
  assert.equal(harness.coordinator.blocked, true);
  assert.equal(harness.coordinator.state.phase, 'failed');
  assert.equal(harness.data[DATA_RESET_KEY], true);
  assert.equal(harness.events.includes('native'), false);
});

test('reset requires explicit preparation and re-establishes its lock after browser cleanup fails verification', async () => {
  const unprepared = resetHarness({
    hostPrepare: async () => ({ prepared: false }),
  });
  await assert.rejects(unprepared.coordinator.clear('CLEAR'), /did not confirm reset preparation/);
  assert.equal(unprepared.events.includes('native'), false);
  const unverified = resetHarness({
    hostComplete: async () => ({ cleared: false }),
  });
  await assert.rejects(unverified.coordinator.clear('CLEAR'), /final reset verification/);
  assert.equal(unverified.events.includes('browser'), true);
  assert.equal(unverified.data[DATA_RESET_KEY], true);
  assert.equal(unverified.events.includes('restart'), false);
});

test('malformed browser reset locks fail closed during recovery and final verification', async (context) => {
  for (const stored of [null, [], { [DATA_RESET_KEY]: false }, { [DATA_RESET_KEY]: 'false' }]) {
    await context.test(JSON.stringify(stored), async () => {
      let reads = 0;
      const harness = resetHarness({
        storage: {
          async get() {
            reads++;
            return stored;
          },
          async set() {},
          async remove() {},
        },
      });
      await harness.coordinator.ready;
      assert.equal(harness.coordinator.blocked, true);
      assert.match(harness.coordinator.state.error, /reset lock/i);
      await assert.rejects(harness.coordinator.clear('CLEAR'), /reset lock/i);
      assert.equal(reads, 2);
      assert.equal(harness.events.includes('restart'), false);
      assert.equal(harness.coordinator.blocked, true);
    });
  }
});

test('malformed native reset replies cannot cross the next cleanup barrier', async (context) => {
  for (const [method, result, forbidden] of [
    ['hostPrepare', { prepared: 'true' }, 'native'],
    ['hostClear', { cleared: true, failures: [], preserved: [1] }, 'browser'],
    [
      'hostClear',
      { cleared: true, failures: [{ path: 'database', error: 'Still in use' }], preserved: [] },
      'browser',
    ],
    ['hostComplete', { cleared: 'true' }, 'restart'],
  ]) {
    await context.test(method, async () => {
      const harness = resetHarness({ [method]: async () => result });
      await assert.rejects(harness.coordinator.clear('CLEAR'), (error) => {
        assert.ok(error.cause);
        assert.equal(error.message.includes('"preserved"'), false);
        return true;
      });
      assert.equal(harness.events.includes(forbidden), false);
      assert.equal(harness.data[DATA_RESET_KEY], true);
      assert.equal(harness.coordinator.blocked, true);
    });
  }
});

test('a successful reset retains phase ordering and only restarts after lock removal is verified', async () => {
  const harness = resetHarness();
  await assert.rejects(harness.coordinator.clear('clear'), /Type exactly CLEAR/);
  await harness.coordinator.clear('CLEAR');
  assert.deepEqual(harness.events, [
    'stopping',
    'lock',
    'views',
    'workers',
    'prepare',
    'native',
    'native',
    'browser',
    'browser',
    'commit',
    'commit',
    'unlock',
    'complete',
    'restart',
  ]);
  assert.deepEqual(harness.coordinator.state, {
    phase: 'complete',
    preserved: ['project files'],
  });
  assert.equal(harness.data[DATA_RESET_KEY], undefined);
  assert.equal(harness.coordinator.blocked, true);
});
