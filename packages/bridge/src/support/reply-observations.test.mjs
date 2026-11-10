import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';
import { chatView } from './fixtures.mjs';
const { ReplyGapTracker, hasEmptyResponseTail } = await import('../reply-gap.ts');
const { isHistoricalReply, isReplyFragment } = await import('../reply-window.ts');

test('historical reply classification never hides newer transcript or fragment evidence', () => {
  const historical = chatView({ codeReply: { id: 'old_reply' } });
  assert.equal(isHistoricalReply(historical, ['old_reply']), true);
  assert.equal(
    isHistoricalReply(
      {
        ...historical,
        lastRole: 'assistant',
        assistantText: '{"id":"new_reply"}',
      },
      ['old_reply'],
    ),
    false,
  );
  assert.equal(
    isHistoricalReply(
      {
        ...historical,
        lastRole: 'assistant',
        assistantText: 'New ordinary answer',
      },
      ['old_reply'],
    ),
    false,
  );
  assert.equal(isHistoricalReply({ ...historical, codeRead: { incomplete: true } }, ['old_reply']), false);
  assert.equal(isReplyFragment({ ...historical, codeRead: { incomplete: true } }), true);
  assert.equal(
    isReplyFragment({
      ...historical,
      replyEvidence: {},
      codeRead: { incomplete: true },
    }),
    false,
  );
});

test('reply gaps retain started evidence per exchange and reset only the idle timer on busy observations', () => {
  const tracker = new ReplyGapTracker();
  const historical = chatView({ codeReply: { id: 'old_reply' } });
  assert.deepEqual(tracker.observe(historical, 'exchange-1', ['old_reply'], 0), {
    missing: true,
    elapsedMs: 0,
    started: false,
  });
  assert.deepEqual(
    tracker.observe(chatView({ codeRead: { incomplete: true } }), 'exchange-1', ['old_reply'], 10),
    { missing: false, elapsedMs: 0, started: true },
  );
  assert.deepEqual(tracker.observe(historical, 'exchange-1', ['old_reply'], 20), {
    missing: true,
    elapsedMs: 0,
    started: true,
  });
  assert.deepEqual(tracker.observe(historical, 'exchange-1', ['old_reply'], 15), {
    missing: true,
    elapsedMs: 0,
    started: true,
  });
  assert.equal(tracker.observe(historical, 'exchange-1', ['old_reply'], 40).elapsedMs, 20);
  assert.equal(tracker.observe(chatView({ busy: true }), 'exchange-1', [], 50).missing, false);
  assert.equal(tracker.observe(historical, 'exchange-1', ['old_reply'], 60).elapsedMs, 0);
  assert.equal(tracker.observe(historical, 'exchange-2', ['old_reply'], 70).started, false);
});

test('empty response tails fail closed on ambiguous receipt evidence and unreadable newer replies', () => {
  const view = chatView({
    transcript: {
      users: 1,
      state: 'ready',
      strategy: 'receipt',
      receiptDiscovery: { matches: 1, state: 'matched', tailBranches: 0 },
    },
  });
  assert.equal(hasEmptyResponseTail(view), true);
  for (const change of [{ matches: 2 }, { state: 'ambiguous' }, { tailBranches: 1 }]) {
    assert.equal(
      hasEmptyResponseTail({
        ...view,
        transcript: {
          ...view.transcript,
          receiptDiscovery: { ...view.transcript.receiptDiscovery, ...change },
        },
      }),
      false,
    );
  }
  for (const change of [
    { draft: true },
    { ready: false },
    { lastUserCollapsed: true },
    { lastUserTruncated: true },
    { codeReplyIssue: 'NEWER_REPLY_UNREADABLE' },
    { replyEvidence: {} },
  ]) {
    assert.equal(hasEmptyResponseTail({ ...view, ...change }), false);
  }
});
