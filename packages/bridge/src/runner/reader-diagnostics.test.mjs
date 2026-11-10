import assert from 'node:assert/strict';
import { test } from 'node:test';
import './test-source-loader.mjs';

const { codeReplyReadShape, transcriptAncestryShape, userReceiptComparison } =
  await import('./reader-diagnostics.ts');
const { messageDigest, wrapMessage } = await import('../message-wire.ts');

const exchangeId = '11111111-1111-4111-8111-111111111111';
const privateText = 'DO_NOT_LOG_PRIVATE_SOURCE';

test('code observations retain their diagnostic defaults without serializing reply bodies', () => {
  const view = { busy: false, draft: false, assistantText: privateText };
  assert.deepEqual(JSON.parse(codeReplyReadShape(view, false)), {
    pendingExchange: false,
    issue: 'none',
    total: 0,
    matches: 0,
    busy: false,
    draft: false,
    selected: false,
    unlinked: false,
  });
  const diagnostic = codeReplyReadShape(
    {
      ...view,
      codeReplyIssue: 'NEWER_USER_MESSAGE',
      codeReplyTotal: 4,
      codeReplyCount: 1,
      replyEvidence: 'exchange',
      unlinkedReply: { text: privateText },
    },
    true,
  );
  assert.deepEqual(JSON.parse(diagnostic), {
    pendingExchange: true,
    issue: 'NEWER_USER_MESSAGE',
    total: 4,
    matches: 1,
    busy: false,
    draft: false,
    selected: true,
    unlinked: true,
  });
  assert.equal(diagnostic.includes(privateText), false);
});

test('ancestry diagnostics omit absent observations and include only structural node fields', () => {
  assert.equal(transcriptAncestryShape({}), undefined);
  assert.equal(transcriptAncestryShape({ codeAncestry: [] }), undefined);
  const diagnostic = transcriptAncestryShape({
    strategy: 'receipt',
    codeAncestry: [[{ tag: 'PRE', attributes: ['data-testid'], text: privateText }]],
    lastUserText: privateText,
  });
  assert.deepEqual(JSON.parse(diagnostic), {
    strategy: 'receipt',
    codeAncestry: [[{ tag: 'PRE', attributes: ['data-testid'] }]],
  });
  assert.equal(diagnostic.includes(privateText), false);
});

test('receipt comparisons preserve exact full-message and payload evidence without exposing source or hashes', async () => {
  const text = wrapMessage(privateText, exchangeId);
  const hash = await messageDigest(text);
  const receipt = {
    workerId: 'worker_1',
    projectId: 'project_1',
    goalHash: 'a'.repeat(64),
    textHash: hash,
    renderedHash: hash,
    acknowledgedHash: hash,
    payloadHash: await messageDigest(privateText),
    exchangeId,
    at: 100,
  };
  const view = {
    lastUserText: text,
    lastUserCandidates: [text],
    lastUserReadStats: { roleElements: 1, preElements: 2, codeElements: 3, framedCandidates: 1 },
  };
  const diagnostic = await userReceiptComparison(view, receipt, true, 'waiting_reply');
  assert.deepEqual(JSON.parse(diagnostic), {
    restoring: true,
    stage: 'waiting_reply',
    receiptAvailable: true,
    observedMatchesText: true,
    observedMatchesRendered: true,
    observedMatchesAcknowledged: true,
    framed: true,
    sameExchange: true,
    payloadMatches: true,
    candidates: 1,
    structure: { roles: 1, pres: 2, codes: 3, frames: 1 },
  });
  assert.equal(diagnostic.includes(privateText), false);
  assert.equal(diagnostic.includes(hash), false);
  const stale = JSON.parse(
    await userReceiptComparison(
      view,
      { ...receipt, exchangeId: '22222222-2222-4222-8222-222222222222' },
      false,
      'waiting_reply',
    ),
  );
  assert.equal(stale.sameExchange, false);
  assert.equal(stale.payloadMatches, true);
});

test('missing receipts and reader statistics stay absent instead of inventing matching evidence', async () => {
  const diagnostic = await userReceiptComparison({ lastUserText: privateText }, undefined, false, 'legacy');
  assert.deepEqual(JSON.parse(diagnostic), {
    restoring: false,
    stage: 'legacy',
    receiptAvailable: false,
    observedMatchesText: false,
    observedMatchesRendered: false,
    observedMatchesAcknowledged: false,
    framed: false,
    sameExchange: false,
    payloadMatches: false,
    candidates: 0,
  });
  assert.equal(diagnostic.includes(privateText), false);
});
