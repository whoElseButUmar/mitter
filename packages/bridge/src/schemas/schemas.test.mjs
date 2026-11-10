import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';

const primitives = await import('./primitives.ts');
const wire = await import('../message-wire.ts');
const { taskProgressSchema, parseTaskProgress, progressSummary, taskProgressSummarySchema } =
  await import('../progress.ts');

const exchangeId = '12345678-1234-1234-1234-123456789abc';
const receipt = {
  workerId: 'worker-1',
  projectId: 'project-1',
  goalHash: 'a'.repeat(64),
  textHash: 'b'.repeat(64),
  renderedHash: 'b'.repeat(64),
  at: 100,
};

function progressRecord(overrides = {}) {
  return {
    version: 1,
    revision: 0,
    workerId: receipt.workerId,
    projectId: receipt.projectId,
    goalHash: receipt.goalHash,
    turns: 1,
    maxTurns: 15,
    lowerBound: false,
    activeMs: 0,
    maxMinutes: 30,
    startedAt: 100,
    updatedAt: 100,
    stage: 'waiting_reply',
    lastReceipt: receipt,
    repeats: 0,
    formatRepairs: 0,
    phase: 'waiting_reply',
    reason: 'Waiting for the current reply.',
    ...overrides,
  };
}

test('shared schemas explain their values and reject malformed identifiers and hashes', () => {
  for (const schema of [
    primitives.identifierSchema,
    primitives.sha256Schema,
    primitives.exchangeIdSchema,
    primitives.nonNegativeIntegerSchema,
    primitives.conversationUrlSchema,
  ]) {
    assert.equal(typeof schema.description, 'string');
    assert.ok(schema.description.length > 20);
  }

  assert.equal(primitives.identifierSchema.safeParse('worker_1').success, true);
  assert.equal(primitives.identifierSchema.safeParse('worker 1').success, false);
  assert.equal(primitives.sha256Schema.safeParse('A'.repeat(64)).success, false);
  assert.equal(primitives.exchangeIdSchema.safeParse(exchangeId.toUpperCase()).success, true);
  assert.equal(primitives.nonNegativeIntegerSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success, false);
});

test('saved conversation addresses fail closed on other origins, query strings and route shapes', () => {
  assert.equal(
    primitives.conversationUrlSchema.safeParse('https://chatgpt.com/g/custom/c/chat-1').success,
    true,
  );

  for (const address of [
    'https://chatgpt.com',
    'https://example.com/c/chat-1',
    'https://chatgpt.com/c/chat-1/',
    'https://chatgpt.com/c/chat-1?task=other',
    'https://chatgpt.com/c/chat-1#reply',
  ]) {
    assert.equal(primitives.conversationUrlSchema.safeParse(address).success, false);
  }
});

test('literal message wrappers preserve nested fences, backslashes, spaces and line endings', () => {
  const payload = '  source\\path\n```json\n{"content":"`text`\\n\\\\"}\n```\n``````\n';
  const wrapped = wire.wrapMessage(payload, exchangeId);
  assert.deepEqual(wire.unwrapMessage(wrapped), { exchangeId, payload });
  assert.equal(wire.messagePayload(wrapped), payload);
  assert.equal(wire.unwrapMessage(wrapped + '\nExtra instructions'), undefined);
  assert.equal(wire.unwrapMessage(wrapped.replace('END MITTER EXCHANGE', 'END OTHER EXCHANGE')), undefined);
  assert.throws(() => wire.wrapMessage(payload, 'bad-id'), /Invalid message exchange ID/);
});

test('receipt migration keeps valid required hashes but discards invalid legacy optional hints', () => {
  const restored = wire.parseReceipt({
    ...receipt,
    exchangeId: 'invalid',
    expectsReplyTo: true,
    turn: '1',
    payloadHash: 'bad',
    priorUserId: 'invalid user',
    priorReplyIds: ['reply-1', 'reply-1'],
  });
  assert.deepEqual(restored, { ...receipt, priorReplyIds: ['reply-1'] });
  assert.equal(wire.parseReceipt({ ...receipt, textHash: 'bad' }), undefined);
  assert.equal(wire.parseReceipt({ ...receipt, priorReplyIds: ['invalid reply'] }), undefined);
  assert.equal(wire.parseReceipt({ ...receipt, at: Infinity }), undefined);
  assert.deepEqual(wire.outboundReceiptSchema.parse(receipt), receipt);
});

test('receipt matching requires the complete message even when an exchange marker is shared', async () => {
  const payload = 'A task with exact source text.';
  const message = wire.wrapMessage(payload, exchangeId);
  const saved = {
    ...receipt,
    exchangeId,
    expectsReplyTo: true,
    textHash: await wire.messageDigest(message),
    renderedHash: await wire.messageDigest(message),
    payloadHash: await wire.messageDigest(payload),
  };

  assert.equal(await wire.matchesReceipt(message, saved), true);
  assert.equal(await wire.matchesReceipt(wire.wrapMessage('A different task.', exchangeId), saved), false);
  assert.equal(await wire.matchesReceipt('MITTER EXCHANGE ' + exchangeId, saved), false);
});

test('progress migration retains legacy status normalization without inventing optional fields', () => {
  const saved = progressRecord({ phase: 'x'.repeat(80), reason: 'y'.repeat(800), errorCode: 'bad code' });
  const restored = parseTaskProgress(saved);
  assert.equal(restored.phase, 'x'.repeat(40));
  assert.equal(restored.reason, 'y'.repeat(500));
  assert.equal(Object.hasOwn(restored, 'errorCode'), false);
  assert.equal(Object.hasOwn(restored, 'approvedReply'), false);
  assert.equal(taskProgressSchema.safeParse(restored).success, true);

  const legacy = parseTaskProgress(progressRecord({ phase: null, reason: null }));
  assert.equal(legacy.phase, 'stopped');
  assert.equal(legacy.reason, 'Progress saved.');
});

test('progress never accepts another task receipt or an invalid approved reply', () => {
  for (const lastReceipt of [
    { ...receipt, workerId: 'other-worker' },
    { ...receipt, projectId: 'other-project' },
    { ...receipt, goalHash: 'c'.repeat(64) },
    { ...receipt, textHash: 'invalid' },
  ]) {
    assert.equal(parseTaskProgress(progressRecord({ lastReceipt })), undefined);
  }

  assert.equal(
    parseTaskProgress(
      progressRecord({
        approvedReply: {
          id: 'reply-1',
          hash: 'd'.repeat(64),
          at: 100,
          url: 'https://chatgpt.com/c/chat-1?other=task',
        },
      }),
    ),
    undefined,
  );
  assert.equal(parseTaskProgress(progressRecord({ revision: -1 })), undefined);
  assert.equal(parseTaskProgress(progressRecord({ version: 2 })), undefined);
});

test('progress summaries conform to their schema without exposing message receipts', () => {
  const summary = progressSummary(progressRecord());
  assert.equal(taskProgressSummarySchema.safeParse(summary).success, true);
  assert.equal(Object.hasOwn(summary, 'lastReceipt'), false);
  assert.equal(Object.hasOwn(summary, 'goalHash'), false);
});
