import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';

const primitives = await import('./primitives.ts');
const wire = await import('../message-wire.ts');
const { taskProgressSchema, parseTaskProgress, progressSummary, taskProgressSummarySchema } =
  await import('../progress.ts');
const { bridgeProgressSummarySchema } = await import('../../../protocol/src/index.ts');

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
  assert.equal(Object.hasOwn(restored, 'monitoring'), false);
  assert.equal(Object.hasOwn(restored, 'watchUntil'), false);
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
  const summary = progressSummary(progressRecord({ revision: 19 }));
  assert.equal(taskProgressSummarySchema.safeParse(summary).success, true);
  assert.equal(summary.revision, 19);
  assert.equal(Object.hasOwn(summary, 'lastReceipt'), false);
  assert.equal(Object.hasOwn(summary, 'goalHash'), false);
});

test('progress summary revisions distinguish saved checkpoints without changing the display phase', () => {
  const first = progressSummary(taskProgressSchema.parse(progressRecord({ revision: 19, phase: 'error' })));
  const next = progressSummary(taskProgressSchema.parse(progressRecord({ revision: 20, phase: 'error' })));
  assert.equal(first.phase, next.phase);
  assert.equal(bridgeProgressSummarySchema.parse(first).revision, 19);
  assert.equal(bridgeProgressSummarySchema.parse(next).revision, 20);
  const legacy = { ...first };
  delete legacy.revision;
  assert.equal(Object.hasOwn(taskProgressSummarySchema.parse(legacy), 'revision'), false);
});

test('late-reply monitoring survives progress and summary boundaries as optional display metadata', () => {
  const progress = progressRecord({ phase: 'error', monitoring: true, watchUntil: 1_000_000 });
  const restored = parseTaskProgress(progress);
  assert.equal(restored.monitoring, true);
  assert.equal(restored.watchUntil, 1_000_000);
  const summary = progressSummary(taskProgressSchema.parse(restored));
  assert.deepEqual(bridgeProgressSummarySchema.parse(summary), taskProgressSummarySchema.parse(summary));
  assert.equal(summary.monitoring, true);
  assert.equal(summary.watchUntil, 1_000_000);
  assert.equal(Object.hasOwn(summary, 'lastReceipt'), false);

  for (const changes of [
    { monitoring: 'true' },
    { watchUntil: -1 },
    { watchUntil: 1.5 },
    { watchUntil: NaN },
    { watchUntil: Infinity },
    { watchUntil: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.equal(taskProgressSchema.safeParse({ ...progress, ...changes }).success, false);
    assert.equal(parseTaskProgress({ ...progress, ...changes }), undefined);
    assert.equal(bridgeProgressSummarySchema.safeParse({ ...summary, ...changes }).success, false);
  }
});

test('reader diagnostics are optional, immutable and confined to bounded structural evidence', () => {
  const diagnostic = {
    readerRevision: 2 ** 31 - 1,
    transcript: 'partial',
    receipt: 'unknown_tail',
    matches: 0,
    tail: 24000,
    reason: 'unclassified_tail',
  };
  const record = progressRecord({ readerDiagnostic: diagnostic });
  const progress = parseTaskProgress(record);
  assert.deepEqual(progress.readerDiagnostic, diagnostic);
  assert.equal(Object.isFrozen(progress.readerDiagnostic), true);
  const summary = progressSummary(progress);
  assert.deepEqual(bridgeProgressSummarySchema.parse(summary).readerDiagnostic, diagnostic);
  assert.equal(
    Object.hasOwn(progressSummary(parseTaskProgress(progressRecord())), 'readerDiagnostic'),
    false,
  );
  for (const shape of [
    { readerRevision: 0 },
    { readerRevision: 2 ** 31 },
    { readerRevision: 1.5 },
    { readerRevision: Infinity },
    { tail: 24001 },
    { matches: -1 },
    { matches: 0.5 },
    { transcript: 'invalid' },
    { receipt: 'invalid' },
    { reason: 'Free form message' },
    { rawText: 'private' },
    { url: 'https://example.invalid/private' },
  ]) {
    const invalid = { ...diagnostic, ...shape };
    assert.equal(parseTaskProgress({ ...record, readerDiagnostic: invalid }), undefined);
    assert.equal(
      bridgeProgressSummarySchema.safeParse({ ...summary, readerDiagnostic: invalid }).success,
      false,
    );
  }
});
