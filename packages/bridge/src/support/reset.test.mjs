import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';

const {
  DATA_RESET_KEY,
  DataResetCoordinator,
  resetPreparationSchema,
  resetCleanupFailureSchema,
  resetCleanupResultSchema,
  resetCompletionSchema,
} = await import('../data-reset.ts');

function resetHarness(overrides = {}) {
  const browserData = {};
  const stages = [];
  const states = [];
  const dependencies = {
    storage: {
      async get() {
        return { ...browserData };
      },
      async set(values) {
        Object.assign(browserData, values);
      },
      async remove(key) {
        delete browserData[key];
      },
    },
    async quiesceViews() {
      stages.push('views');
    },
    async stop() {
      stages.push('workers');
    },
    async hostPrepare() {
      stages.push('prepare');
      return { prepared: true };
    },
    async hostClear() {
      stages.push('native');
      return { cleared: true, failures: [], preserved: ['project files'] };
    },
    async clearBrowser() {
      stages.push('browser');
      for (const key of Object.keys(browserData)) {
        delete browserData[key];
      }
    },
    async hostComplete() {
      stages.push('commit');
      return { cleared: true };
    },
    publish(state) {
      states.push(state);
    },
    restart() {
      stages.push('restart');
    },
    ...overrides,
  };

  return { coordinator: new DataResetCoordinator(dependencies), browserData, stages, states };
}

test('native reset replies use described schemas without supplying missing cleanup fields', () => {
  for (const [schema, value] of [
    [resetPreparationSchema, { prepared: true }],
    [resetCleanupFailureSchema, { path: 'cache', error: 'Permission denied' }],
    [resetCleanupResultSchema, { cleared: true, failures: [], preserved: [] }],
    [resetCompletionSchema, { cleared: true }],
  ]) {
    assert.deepEqual(schema.parse(value), value);
    assert.equal(typeof schema.description, 'string');
    for (const field of Object.values(schema.shape)) {
      assert.equal(typeof field.description, 'string');
    }
  }

  assert.equal(resetCleanupResultSchema.safeParse({ cleared: true }).success, false);
  assert.equal(resetCleanupResultSchema.safeParse({ cleared: true, failures: [] }).success, false);
});

test('malformed preparation replies retain the original refusal and never authorize native deletion', async () => {
  for (const response of [undefined, null, {}, { prepared: false }, { prepared: 'true' }]) {
    const harness = resetHarness({
      hostPrepare: async () => response,
      async hostClear() {
        assert.fail('Unconfirmed preparation cannot authorize native deletion');
      },
    });

    await assert.rejects(harness.coordinator.clear('CLEAR'), {
      message: 'The native host did not confirm reset preparation. No native cleanup was authorized.',
    });
    assert.deepEqual(
      harness.states.map((state) => state.phase),
      ['stopping', 'failed'],
    );
    assert.equal(harness.stages.includes('browser'), false);
    assert.equal(harness.browserData[DATA_RESET_KEY], true);
    assert.equal(harness.coordinator.busy, false);
  }
});

test('malformed cleanup replies cannot advance to browser cleanup or final verification', async () => {
  for (const response of [
    undefined,
    null,
    { cleared: true },
    { cleared: 'true', failures: [], preserved: [] },
    { cleared: true, failures: 'none', preserved: [] },
    { cleared: true, failures: [], preserved: [123] },
  ]) {
    const harness = resetHarness({ hostClear: async () => response });

    await assert.rejects(harness.coordinator.clear('CLEAR'), {
      message: 'Native state could not be fully deleted.',
    });
    assert.deepEqual(harness.states, [
      { phase: 'stopping' },
      { phase: 'clearing', step: 'native' },
      { phase: 'failed', error: 'Native state could not be fully deleted.' },
    ]);
    assert.equal(harness.stages.includes('browser'), false);
    assert.equal(harness.stages.includes('commit'), false);
    assert.equal(harness.stages.includes('restart'), false);
    assert.equal(harness.browserData[DATA_RESET_KEY], true);
  }
});

test('cleanup failures keep their original file details even when unrelated response fields are missing', async () => {
  const failures = [
    { path: 'cache', error: 'Permission denied' },
    { path: 'database', error: 'Still in use' },
  ];
  for (const response of [
    { cleared: false, failures, preserved: [] },
    { cleared: false, failures },
  ]) {
    const harness = resetHarness({ hostClear: async () => response });
    const message = 'cache: Permission denied\ndatabase: Still in use';

    await assert.rejects(harness.coordinator.clear('CLEAR'), { message });
    assert.equal(harness.coordinator.state.error, message);
    assert.equal(harness.stages.includes('browser'), false);
    assert.equal(harness.browserData[DATA_RESET_KEY], true);
  }
});

test('malformed final replies recreate the browser lock without restarting or publishing completion', async () => {
  for (const response of [undefined, null, {}, { cleared: false }, { cleared: 'true' }]) {
    const harness = resetHarness({ hostComplete: async () => response });

    await assert.rejects(harness.coordinator.clear('CLEAR'), {
      message: 'The native host did not confirm final reset verification. Reset remains locked.',
    });
    assert.equal(harness.stages.includes('browser'), true);
    assert.equal(harness.stages.includes('restart'), false);
    assert.equal(
      harness.states.some((state) => state.phase === 'complete'),
      false,
    );
    assert.equal(harness.browserData[DATA_RESET_KEY], true);
  }
});

test('loading the reset lock still blocks every reset stage until readiness settles', async () => {
  const savedState = Promise.withResolvers();
  const harness = resetHarness({
    storage: {
      get: () => savedState.promise,
      async set(values) {
        Object.assign(harness.browserData, values);
      },
      async remove(key) {
        delete harness.browserData[key];
      },
    },
  });
  const clearing = harness.coordinator.clear('CLEAR');

  await setImmediate();
  assert.deepEqual(harness.stages, []);
  assert.deepEqual(harness.states, []);
  assert.equal(harness.coordinator.busy, false);

  savedState.resolve({});
  await clearing;
  assert.deepEqual(harness.stages, ['views', 'workers', 'prepare', 'native', 'browser', 'commit', 'restart']);
  assert.equal(harness.browserData[DATA_RESET_KEY], undefined);
});

test('saved reset locks and read failures retain their recovery messages', async () => {
  const pendingReset = resetHarness({
    storage: { get: async () => ({ [DATA_RESET_KEY]: true }) },
  });
  await pendingReset.coordinator.ready;
  assert.deepEqual(pendingReset.coordinator.state, {
    phase: 'failed',
    error: 'A previous data reset did not finish. Type CLEAR to retry.',
  });

  const unreadableLock = resetHarness({
    storage: {
      async get() {
        throw new Error('Storage unavailable');
      },
    },
  });
  await unreadableLock.coordinator.ready;
  assert.deepEqual(unreadableLock.coordinator.state, {
    phase: 'failed',
    error: 'Could not check the reset lock: Error: Storage unavailable',
  });
  assert.equal(unreadableLock.coordinator.blocked, true);
  assert.deepEqual(unreadableLock.stages, []);
});

test('non-Error cleanup failures retain their message and leave the reset locked', async () => {
  const harness = resetHarness({
    async hostClear() {
      throw 'Cleanup unavailable';
    },
  });

  await assert.rejects(harness.coordinator.clear('CLEAR'), { message: 'Cleanup unavailable' });
  assert.deepEqual(harness.coordinator.state, { phase: 'failed', error: 'Cleanup unavailable' });
  assert.equal(harness.browserData[DATA_RESET_KEY], true);
});

test('a rejected cleanup acknowledgement remains retryable without skipping the writer barriers', async () => {
  let response = { cleared: true };
  const harness = resetHarness({ hostClear: async () => response });
  await assert.rejects(harness.coordinator.clear('CLEAR'), /Native state could not be fully deleted/);

  response = { cleared: true, failures: [], preserved: ['project files'] };
  await harness.coordinator.clear('CLEAR');
  assert.deepEqual(harness.stages, [
    'views',
    'workers',
    'prepare',
    'views',
    'workers',
    'prepare',
    'browser',
    'commit',
    'restart',
  ]);
  assert.deepEqual(harness.coordinator.state, { phase: 'complete', preserved: ['project files'] });
  assert.equal(harness.browserData[DATA_RESET_KEY], undefined);
});
