import assert from 'node:assert/strict';
import { test } from 'node:test';
import './test-source-loader.mjs';

const {
  bridgeStatusSchema,
  bridgeOptionsSchema,
  bridgeWatchStatusSchema,
  bridgeResendResultSchema,
  bridgePreviousProgressSchema,
} = await import('./types.ts');

const identity = { workerId: 'worker_1', projectId: 'project_1' };
const receipt = {
  ...identity,
  goalHash: 'a'.repeat(64),
  textHash: 'b'.repeat(64),
  renderedHash: 'b'.repeat(64),
  at: 100,
};
const options = {
  ...identity,
  tabId: 12,
  url: 'https://chatgpt.com/c/task-1',
  maxTurns: 5,
  maxMinutes: 10,
  token: 'transport-token',
};
const status = {
  workerId: identity.workerId,
  tabId: options.tabId,
  url: options.url,
  active: true,
  phase: 'connecting',
  reason: 'Connecting.',
  turns: 0,
  maxTurns: 5,
  startedAt: 100,
};
const previousProgress = {
  turns: 25,
  maxTurns: 30,
  lowerBound: true,
  startedAt: 10,
  activeMs: 5000,
  maxMinutes: 90,
};

function progress(overrides = {}) {
  return {
    version: 1,
    revision: 0,
    ...identity,
    goalHash: receipt.goalHash,
    turns: 1,
    maxTurns: 5,
    lowerBound: false,
    activeMs: 100,
    maxMinutes: 10,
    startedAt: 10,
    updatedAt: 100,
    stage: 'waiting_reply',
    lastReceipt: receipt,
    repeats: 0,
    formatRepairs: 0,
    phase: 'waiting_reply',
    reason: 'Waiting.',
    ...overrides,
  };
}

function assertInvalid(schema, value) {
  assert.equal(schema.safeParse(value).success, false);
}

test('status accepts legacy observations without inventing missing fields', () => {
  assert.deepEqual(bridgeStatusSchema.parse(status), status);
  assert.deepEqual(bridgeWatchStatusSchema.parse({}), {});
  assert.deepEqual(bridgePreviousProgressSchema.parse(previousProgress), previousProgress);
  assert.deepEqual(bridgeOptionsSchema.parse({ ...options, previousProgress }), {
    ...options,
    previousProgress,
  });
});

test('watch status keeps its absolute deadline and optional receiving observation', () => {
  const watching = { receiving: true, monitoring: true, watchUntil: 1_000_000 };
  assert.deepEqual(bridgeWatchStatusSchema.parse(watching), watching);
  assert.deepEqual(bridgeStatusSchema.parse({ ...status, active: false, ...watching }), {
    ...status,
    active: false,
    ...watching,
  });
  for (const watchUntil of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assertInvalid(bridgeWatchStatusSchema, { watchUntil });
  }
});

test('resend outcomes preserve optional observations without adding defaults', () => {
  for (const outcome of [{ sent: true }, { sent: false, replyFound: true }, { sent: false, pending: true }]) {
    assert.deepEqual(bridgeResendResultSchema.parse(outcome), outcome);
  }
  for (const outcome of [{}, { sent: 'true' }, { sent: false, pending: 1 }]) {
    assertInvalid(bridgeResendResultSchema, outcome);
  }
});

test('serialized options support existing routes and require explicit new-chat permission', () => {
  for (const url of [
    'https://chatgpt.com/c/task-1/?mode=test#reply',
    'https://chat.openai.com/g/custom/c/task-1/',
  ]) {
    assert.equal(bridgeOptionsSchema.parse({ ...options, url }).url, url);
  }
  for (const url of ['https://chatgpt.com/', 'https://chat.openai.com/?temporary=true']) {
    assertInvalid(bridgeOptionsSchema, { ...options, url });
    assertInvalid(bridgeOptionsSchema, { ...options, url, newChat: false });
    assert.equal(bridgeOptionsSchema.parse({ ...options, url, newChat: true }).url, url);
  }
  for (const url of [
    'http://chatgpt.com/c/task-1',
    'https://example.com/c/task-1',
    'https://chatgpt.com/settings',
    'not a URL',
  ]) {
    assertInvalid(bridgeOptionsSchema, { ...options, url, newChat: true });
    assertInvalid(bridgeStatusSchema, { ...status, url });
  }
});

test('startup options preserve exact reviewed run boundaries and queued batch IDs', () => {
  for (const runId of ['', '  literal run\\id\r\n😀  ']) {
    for (const epoch of [0, 7]) {
      const expectedRun = { runId, epoch };
      const bound = { ...options, expectedRun, expectedBatchId: 'batch_1' };
      assert.deepEqual(bridgeOptionsSchema.parse(bound), bound);
    }
  }

  for (const expectedRun of [
    null,
    {},
    { runId: null, epoch: 7 },
    { runId: 1, epoch: 7 },
    { runId: 'run', epoch: -1 },
    { runId: 'run', epoch: '7' },
    { runId: 'run', epoch: 1.5 },
  ]) {
    assertInvalid(bridgeOptionsSchema, { ...options, expectedRun });
  }

  for (const expectedBatchId of [null, '', 'unreviewed batch', 7, {}]) {
    assertInvalid(bridgeOptionsSchema, { ...options, expectedBatchId });
  }
});

test('new-run budgets are bounded while saved legacy limits remain readable', () => {
  for (const maxTurns of [0, 21, 1.5, NaN, Infinity]) {
    assertInvalid(bridgeOptionsSchema, { ...options, maxTurns });
  }
  for (const maxMinutes of [0, 61, 1.5, NaN, Infinity]) {
    assertInvalid(bridgeOptionsSchema, { ...options, maxMinutes });
  }
  for (const limits of [
    { maxTurns: 1, maxMinutes: 1 },
    { maxTurns: 20, maxMinutes: 60 },
  ]) {
    assert.equal(bridgeOptionsSchema.safeParse({ ...options, ...limits }).success, true);
  }
  assert.equal(bridgeStatusSchema.safeParse({ ...status, maxTurns: 30, maxMinutes: 90 }).success, true);
});

test('legacy and nonce-protected receipts retain the same serialized values', () => {
  assert.deepEqual(bridgeOptionsSchema.parse({ ...options, lastReceipt: receipt }).lastReceipt, receipt);
  const linked = {
    ...receipt,
    exchangeId: '11111111-1111-4111-8111-111111111111',
    expectsReplyTo: true,
    messageId: 'message_1',
    payloadHash: 'c'.repeat(64),
    turn: 1,
    priorReplyIds: [],
  };
  assert.deepEqual(bridgeOptionsSchema.parse({ ...options, lastReceipt: linked }).lastReceipt, linked);
  assertInvalid(bridgeOptionsSchema, {
    ...options,
    lastReceipt: { ...receipt, goalHash: 'wrong' },
  });
});

test('progress loads require explicit null or valid progress and a nonnegative safe import count', async () => {
  const { bridgeProgressLoadSchema } = await import('./progress-load.ts');
  const { recoverTaskProgress } = await import('./progress-recovery.ts');
  assert.deepEqual(bridgeProgressLoadSchema.parse({ progress: null, importedCount: 0 }), {
    progress: null,
    importedCount: 0,
  });
  assert.deepEqual(bridgeProgressLoadSchema.parse({ progress: progress(), importedCount: 4 }), {
    progress: progress(),
    importedCount: 4,
  });
  assertInvalid(bridgeProgressLoadSchema, { importedCount: 0 });
  assertInvalid(bridgeProgressLoadSchema, {
    progress: progress({ version: 2 }),
    importedCount: 0,
  });
  for (const importedCount of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assertInvalid(bridgeProgressLoadSchema, { progress: null, importedCount });
    assert.throws(
      () =>
        recoverTaskProgress(
          { progress: null, importedCount },
          { id: identity.workerId, projectId: identity.projectId },
          options,
          receipt.goalHash,
          () => 200,
        ),
      { code: 'PROGRESS_VERSION' },
    );
  }
});

test('saved progress still rejects foreign receipts instead of resetting task identity', async () => {
  const { bridgeProgressLoadSchema } = await import('./progress-load.ts');
  const { recoverTaskProgress } = await import('./progress-recovery.ts');
  assertInvalid(bridgeProgressLoadSchema, {
    progress: progress({
      lastReceipt: { ...receipt, workerId: 'other_worker' },
    }),
    importedCount: 0,
  });
  assert.throws(
    () =>
      recoverTaskProgress(
        {
          progress: progress({
            workerId: 'other_worker',
            lastReceipt: undefined,
          }),
          importedCount: 0,
        },
        { id: identity.workerId, projectId: identity.projectId },
        options,
        receipt.goalHash,
        () => 200,
      ),
    { code: 'PROGRESS_BINDING' },
  );
});

function assertDescribed(schema) {
  assert.equal(typeof schema.description, 'string');
  assert.ok(schema.description.length > 10);
  for (const [fieldName, field] of Object.entries(schema.shape)) {
    assert.equal(typeof field.description, 'string', fieldName);
    assert.ok(field.description.length > 10, fieldName);
  }
}

test('each status and options schema and field has a simple English description', () => {
  for (const schema of [
    bridgeStatusSchema,
    bridgeOptionsSchema,
    bridgeWatchStatusSchema,
    bridgeResendResultSchema,
    bridgePreviousProgressSchema,
  ]) {
    assertDescribed(schema);
  }
});

test('the progress-load schema and fields have simple English descriptions', async () => {
  const { bridgeProgressLoadSchema } = await import('./progress-load.ts');
  assertDescribed(bridgeProgressLoadSchema);
});
