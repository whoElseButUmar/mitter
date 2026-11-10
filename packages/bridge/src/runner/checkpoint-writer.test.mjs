import assert from 'node:assert/strict';
import { test } from 'node:test';
import './test-source-loader.mjs';

const { CheckpointWriter } = await import('./checkpoint-writer.ts');
const { ZodError } = await import('zod');

function progress(overrides = {}) {
  return {
    version: 1,
    revision: 0,
    workerId: 'worker_1',
    projectId: 'project_1',
    goalHash: 'a'.repeat(64),
    turns: 1,
    maxTurns: 5,
    lowerBound: false,
    activeMs: 100,
    maxMinutes: 10,
    startedAt: 1,
    updatedAt: 100,
    stage: 'waiting_reply',
    repeats: 0,
    formatRepairs: 0,
    phase: 'waiting_reply',
    reason: 'Waiting.',
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('queued snapshots and result application follow the preceding host revision', async () => {
  const firstSave = deferred();
  const enteredFirstSave = deferred();
  const events = [];
  let current = progress();
  const writer = new CheckpointWriter(
    async (value, epoch) => {
      events.push(['save', value.revision, epoch]);
      if (value.revision === 0) {
        enteredFirstSave.resolve();
        await firstSave.promise;
      }
      return { ...value, revision: value.revision + 1 };
    },
    () => 100,
  );
  const build = () => {
    events.push(['build', current.revision]);
    return { ...current };
  };
  const apply = (value, durable) => {
    events.push(['apply', value.revision, durable]);
    if (durable) {
      current = value;
    }
  };
  const first = writer.write(build, apply, 7);
  const second = writer.write(build, apply, 7);
  await enteredFirstSave.promise;
  assert.deepEqual(events, [
    ['build', 0],
    ['save', 0, 7],
  ]);
  let flushed = false;
  const draining = writer.flushed().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  assert.equal(flushed, false);
  firstSave.resolve();
  await Promise.all([first, second, draining]);
  assert.deepEqual(events, [
    ['build', 0],
    ['save', 0, 7],
    ['apply', 1, true],
    ['build', 1],
    ['save', 1, 7],
    ['apply', 2, true],
  ]);
  assert.equal(current.revision, 2);
  assert.equal(flushed, true);
});

test('unchanged heartbeat skips persistence but still updates displayed active time', async () => {
  let time = 100;
  const saves = [];
  const applied = [];
  const writer = new CheckpointWriter(
    async (value) => {
      saves.push(value);
      return { ...value, revision: value.revision + 1 };
    },
    () => time,
  );
  const apply = (value, durable) => applied.push([value.activeMs, value.revision, durable]);
  await writer.write(() => progress(), apply, 0, false);
  time += 4999;
  await writer.write(() => progress({ revision: 1, activeMs: time, updatedAt: time }), apply, 0, false);
  assert.equal(saves.length, 1);
  assert.deepEqual(applied, [
    [100, 1, true],
    [5099, 1, false],
  ]);
  time += 1;
  await writer.write(() => progress({ revision: 1, activeMs: time, updatedAt: time }), apply, 0, false);
  assert.equal(saves.length, 2);
  assert.deepEqual(applied[2], [5100, 2, true]);
});

test('forced mutation boundaries and meaningful changes are never throttled', async () => {
  const saves = [];
  const writer = new CheckpointWriter(
    async (value) => {
      saves.push(value);
      return value;
    },
    () => 100,
  );
  const apply = () => {};
  await writer.write(() => progress(), apply, 4);
  await writer.write(() => progress(), apply, 4);
  await writer.write(() => progress({ stage: 'commit_intent' }), apply, 4, false);
  await writer.write(() => progress({ stage: 'commit_intent', turns: 2 }), apply, 4, false);
  assert.equal(saves.length, 4);
});

test('heartbeat timing starts after acknowledgement rather than when the save begins', async () => {
  let time = 100;
  let saves = 0;
  const pending = deferred();
  const entered = deferred();
  const writer = new CheckpointWriter(
    async (value) => {
      saves++;
      entered.resolve();
      await pending.promise;
      return value;
    },
    () => time,
  );
  const first = writer.write(
    () => progress(),
    () => {},
    0,
  );
  await entered.promise;
  time = 10000;
  pending.resolve();
  await first;
  time = 14999;
  await writer.write(
    () => progress({ activeMs: time }),
    () => {},
    0,
    false,
  );
  assert.equal(saves, 1);
  time = 15000;
  await writer.write(
    () => progress({ activeMs: time }),
    () => {},
    0,
    false,
  );
  assert.equal(saves, 2);
});

test('failed persistence is actionable and drainable without applying the failed record', async () => {
  let applied = false;
  const writer = new CheckpointWriter(
    async () => {
      throw Error('Disk unavailable');
    },
    () => 100,
  );
  await assert.rejects(
    writer.write(
      () => progress(),
      () => {
        applied = true;
      },
      0,
    ),
    {
      code: 'PROGRESS_SAVE_FAILED',
      message: 'Task progress could not be saved. No further action will run. Disk unavailable',
    },
  );
  assert.equal(applied, false);
  await writer.flushed();
});

test('Error messages are reported without evaluating an unrelated string conversion', async () => {
  const failure = Error('Disk unavailable');
  failure.toString = () => {
    throw Error('Unexpected string conversion');
  };
  const writer = new CheckpointWriter(
    async () => {
      throw failure;
    },
    () => 100,
  );
  await assert.rejects(
    writer.write(
      () => progress(),
      () => {},
      0,
    ),
    {
      code: 'PROGRESS_SAVE_FAILED',
      message: 'Task progress could not be saved. No further action will run. Disk unavailable',
    },
  );
  await writer.flushed();
});

test('a skipped heartbeat cannot clear a prior save error, but a successful forced save can', async () => {
  let fail = false;
  let saves = 0;
  const applied = [];
  const writer = new CheckpointWriter(
    async (value) => {
      saves++;
      if (fail) {
        throw Error('Disk unavailable');
      }
      return value;
    },
    () => 100,
  );
  const apply = (value, durable) => applied.push(durable);
  await writer.write(() => progress(), apply, 0);
  fail = true;
  await assert.rejects(
    writer.write(() => progress(), apply, 0),
    { code: 'PROGRESS_SAVE_FAILED' },
  );
  await assert.rejects(
    writer.write(() => progress({ activeMs: 200 }), apply, 0, false),
    {
      code: 'PROGRESS_SAVE_FAILED',
    },
  );
  assert.equal(saves, 2);
  assert.deepEqual(applied, [true, false]);
  fail = false;
  await writer.write(() => progress(), apply, 0);
  assert.equal(saves, 3);
  assert.deepEqual(applied, [true, false, true]);
});

test('snapshot failures also leave a drainable queue and allow a later durable recovery', async () => {
  let saves = 0;
  const writer = new CheckpointWriter(
    async (value) => {
      saves++;
      return value;
    },
    () => 100,
  );
  await assert.rejects(
    writer.write(
      () => {
        throw Error('Cannot read progress');
      },
      () => {},
      0,
    ),
    {
      code: 'PROGRESS_SAVE_FAILED',
    },
  );
  assert.equal(saves, 0);
  await writer.flushed();
  await writer.write(
    () => progress(),
    () => {},
    0,
  );
  assert.equal(saves, 1);
});

test('without a storage dependency the queued record still applies before the next snapshot', async () => {
  const events = [];
  const writer = new CheckpointWriter(
    () => undefined,
    () => 100,
  );
  const first = writer.write(
    () => {
      events.push('build:first');
      return progress();
    },
    () => {
      events.push('apply:first');
    },
    0,
  );
  const second = writer.write(
    () => {
      events.push('build:second');
      return progress();
    },
    () => {
      events.push('apply:second');
    },
    0,
  );
  await Promise.all([first, second]);
  assert.deepEqual(events, ['build:first', 'apply:first', 'build:second', 'apply:second']);
});

test('malformed save acknowledgements never apply a durable record or clear the save barrier', async (context) => {
  for (const result of [undefined, null, {}, progress({ revision: '1' }), progress({ lastReceipt: {} })]) {
    await context.test(String(result), async () => {
      let invalid = true;
      const applied = [];
      const writer = new CheckpointWriter(
        async (value) => {
          if (invalid) {
            return result;
          }
          return { ...value, revision: value.revision + 1 };
        },
        () => 100,
      );
      await assert.rejects(
        writer.write(
          () => progress(),
          (value) => applied.push(value),
          7,
        ),
        (error) => {
          assert.equal(error.code, 'PROGRESS_SAVE_FAILED');
          assert.ok(error.cause.cause instanceof ZodError);
          assert.equal(error.message.includes('"lastReceipt"'), false);
          return true;
        },
      );
      assert.deepEqual(applied, []);
      await writer.flushed();
      invalid = false;
      await writer.write(
        () => progress(),
        (value) => applied.push(value),
        7,
      );
      assert.equal(applied.length, 1);
      assert.equal(applied[0].revision, 1);
    });
  }
});

test('save acknowledgements cannot substitute a different task, receipt, stage, or older revision', async (context) => {
  for (const changes of [
    { workerId: 'other_worker' },
    { projectId: 'other_project' },
    { goalHash: 'b'.repeat(64) },
    { stage: 'commit_intent' },
    { turns: 0 },
    { activeMs: 0 },
    { revision: 0 },
    { approvedReply: { id: 'other_reply', hash: 'b'.repeat(64), url: 'https://chatgpt.com/c/other', at: 1 } },
  ]) {
    await context.test(JSON.stringify(changes), async () => {
      const applied = [];
      const writer = new CheckpointWriter(
        async (value) => ({ ...value, ...changes }),
        () => 100,
      );
      await assert.rejects(
        writer.write(
          () => progress({ revision: 1 }),
          (value) => applied.push(value),
          7,
        ),
        { code: 'PROGRESS_SAVE_FAILED' },
      );
      assert.deepEqual(applied, []);
    });
  }
});

test('outgoing progress validation inspects owner migrations without rewriting the wire record', async () => {
  const outgoing = progress({ reason: 'x'.repeat(501) });
  const original = structuredClone(outgoing);
  let calls = 0;
  const applied = [];
  const writer = new CheckpointWriter(
    async (value, epoch) => {
      calls++;
      assert.equal(value, outgoing);
      assert.equal(value.reason.length, 501);
      assert.equal(epoch, 7);
      return { ...value, reason: value.reason.slice(0, 500), revision: value.revision + 1 };
    },
    () => 100,
  );
  await writer.write(
    () => outgoing,
    (value) => applied.push(value),
    7,
  );
  assert.equal(calls, 1);
  assert.deepEqual(outgoing, original);
  assert.equal(applied[0].reason.length, 500);
  assert.equal(applied[0].revision, 1);
});

test('invalid outgoing epochs cannot cross the checkpoint persistence boundary', async () => {
  for (const epoch of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '7']) {
    let calls = 0;
    const writer = new CheckpointWriter(
      async (value) => {
        calls++;
        return value;
      },
      () => 100,
    );
    await assert.rejects(
      writer.write(
        () => progress(),
        () => {},
        epoch,
      ),
      { code: 'PROGRESS_SAVE_FAILED' },
    );
    assert.equal(calls, 0);
  }
});

test('failed result application remains an error until a later successful checkpoint', async () => {
  const writer = new CheckpointWriter(
    async (value) => value,
    () => 100,
  );
  await assert.rejects(
    writer.write(
      () => progress(),
      () => {
        throw Error('Cannot apply revision');
      },
      0,
    ),
    {
      code: 'PROGRESS_SAVE_FAILED',
    },
  );
  await writer.flushed();
  await writer.write(
    () => progress(),
    () => {},
    0,
  );
});
