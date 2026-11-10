import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

function mixedTranscript(changes = {}) {
  return {
    version: 'message-discovery/2',
    state: 'partial',
    strategy: 'receipt',
    roleAttributes: 1,
    alternativeRoles: 0,
    semanticRoles: 0,
    turnContainers: 2,
    users: 1,
    assistants: 0,
    unknownTurns: 1,
    unclassifiedTail: true,
    codeBlocks: 0,
    openShadowRoots: 0,
    frames: 0,
    scanLimited: false,
    receiptDiscovery: {
      state: 'waiting_reply',
      candidates: 1,
      matches: 1,
      tailBranches: 1,
      responseControls: 0,
    },
    ...changes,
  };
}

function generatingView(changes = {}) {
  return {
    count: 2,
    lastRole: 'unknown',
    assistantId: '',
    assistantText: '',
    busy: true,
    complete: false,
    transcript: mixedTranscript(),
    ...changes,
  };
}

function assertNoReplyEffects(harness) {
  assert.equal(harness.commits.length, 1, 'Never replay the original Send.');
  assert.equal(harness.imports.length, 0, 'Waiting evidence cannot authorize a reply.');
  assert.equal(harness.events.includes('worker.run'), false);
  assert.equal(harness.events.includes('worker.report'), false);
  assert.equal(harness.events.filter((event) => event === 'page:prepare').length, 1);
}

test('a verified mixed-role generation stays read-only beyond the layout and idle-reply deadlines', async () => {
  const harness = createHarness();
  await harness.runner.start();
  await harness.runner.tick();
  const receipt = structuredClone(harness.options.lastReceipt);
  const originalText = harness.commits[0].text;
  harness.setView(generatingView());

  for (const elapsed of [0, 13000, 60000, 240000]) {
    harness.advance(elapsed);
    await harness.runner.tick();
    assert.equal(harness.runner.status.active, true);
    assert.equal(harness.runner.status.phase, 'waiting_reply');
    assert.equal(harness.progress().stage, 'waiting_reply');
    assert.equal(harness.runner.status.errorCode, undefined);
    assert.deepEqual(harness.options.lastReceipt, receipt);
    assert.equal(harness.commits[0].text, originalText);
    assertNoReplyEffects(harness);
  }

  const envelope = harness.showReply({ summary: '  Keep `ticks`, \\escapes,\n\tand 😀 exactly.  ' });
  const completedTranscript = mixedTranscript({
    state: 'ready',
    assistants: 1,
    unknownTurns: 0,
    unclassifiedTail: false,
    codeBlocks: 1,
    receiptDiscovery: {
      state: 'matched',
      candidates: 1,
      matches: 1,
      tailBranches: 1,
      responseControls: 2,
    },
  });
  harness.setView({ busy: false, transcript: completedTranscript });
  await harness.runner.tick();
  harness.advance(1700);
  harness.setView(generatingView());
  await harness.runner.tick();
  assertNoReplyEffects(harness);

  harness.showReply(envelope);
  harness.setView({ busy: false, transcript: completedTranscript });
  await harness.runner.tick();
  harness.advance(1799);
  await harness.runner.tick();
  assertNoReplyEffects(harness);
  harness.advance(1);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  assert.deepEqual(JSON.parse(harness.imports[0].text), envelope);
  assert.equal(JSON.parse(harness.imports[0].text).summary, envelope.summary);
  assert.equal(harness.commits.length, 1);
  assert.deepEqual(harness.options.lastReceipt, receipt);
  await harness.runner.stop();
  await harness.runner.settled();
});

test('idle unreadable content gets a fresh bounded layout grace after verified generation ends', async () => {
  const harness = createHarness();
  await harness.runner.start();
  harness.setView(generatingView());
  await harness.runner.tick();
  harness.advance(60000);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, true);

  harness.setView({ busy: false });
  await harness.runner.tick();
  harness.advance(11999);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, true);
  assertNoReplyEffects(harness);
  harness.advance(1);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.runner.status.errorCode, 'TRANSCRIPT_UNSUPPORTED');
  assert.equal(harness.runner.status.monitoring, true);
  assert.match(harness.runner.status.reason, /Use reply/);
  assertNoReplyEffects(harness);
  await harness.runner.stop();
  await harness.runner.settled();
});

test('busy alone cannot bypass missing, ambiguous, mismatched, or intervening receipt proof', async (context) => {
  for (const [label, receiptDiscovery] of [
    ['no fallback proof', undefined],
    ['missing receipt', { state: 'missing', matches: 0 }],
    ['mismatched receipt', { state: 'mismatch', matches: 0 }],
    ['duplicate receipt', { state: 'ambiguous', matches: 2 }],
    ['intervening content', { state: 'unknown_tail', matches: 1 }],
    ['nonunique waiting proof', { state: 'waiting_reply', matches: 2 }],
  ]) {
    await context.test(label, async () => {
      const harness = createHarness();
      await harness.runner.start();
      let proof;
      if (receiptDiscovery) {
        proof = {
          candidates: 2,
          tailBranches: 1,
          responseControls: 0,
          ...receiptDiscovery,
        };
      }
      harness.setView(generatingView({ transcript: mixedTranscript({ receiptDiscovery: proof }) }));
      await harness.runner.tick();
      harness.advance(13000);
      await harness.runner.tick();
      assert.equal(harness.runner.status.errorCode, 'TRANSCRIPT_UNSUPPORTED');
      assert.equal(harness.runner.status.active, false);
      assertNoReplyEffects(harness);
      await harness.runner.stop();
      await harness.runner.settled();
    });
  }
});

test('a scan limit is a hard barrier even with busy and otherwise valid waiting proof', async () => {
  const harness = createHarness();
  await harness.runner.start();
  harness.setView(generatingView({ transcript: mixedTranscript({ scanLimited: true }) }));
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.runner.status.errorCode, 'TRANSCRIPT_LIMIT');
  assertNoReplyEffects(harness);
  await harness.runner.stop();
  await harness.runner.settled();
});

test('verified generation does not renew or bypass the task active-time budget', async () => {
  const harness = createHarness({ options: { maxMinutes: 1 } });
  await harness.runner.start();
  harness.setView(generatingView());
  await harness.runner.tick();
  harness.advance(60001);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.runner.status.errorCode, 'TIME_LIMIT');
  assertNoReplyEffects(harness);
  await harness.runner.settled();
});

test('a later known user remains an intervention barrier after generation ends', async () => {
  const harness = createHarness();
  await harness.runner.start();
  await harness.runner.tick();
  harness.setView(generatingView());
  await harness.runner.tick();
  harness.advance(13000);
  await harness.runner.tick();
  harness.showReply();
  harness.setView({
    count: 3,
    userCount: 2,
    lastUserText: 'A different human instruction.',
    lastUserId: 'later_user',
    userIds: ['sent_user', 'later_user'],
    busy: false,
    transcript: mixedTranscript({
      state: 'ready',
      users: 2,
      assistants: 1,
      unknownTurns: 0,
      unclassifiedTail: false,
      receiptDiscovery: {
        state: 'unknown_tail',
        candidates: 1,
        matches: 1,
        tailBranches: 2,
        responseControls: 0,
      },
    }),
  });
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.runner.status.errorCode, 'CHAT_INTERVENED');
  assert.equal(harness.runner.status.active, false);
  assertNoReplyEffects(harness);
  await harness.runner.stop();
  await harness.runner.settled();
});

test('a rejected or failed inspection restarts completion stability without renewing the send', async (context) => {
  for (const interruption of ['unknown transcript branch', 'failed page read']) {
    await context.test(interruption, async () => {
      const harness = createHarness();
      await harness.runner.start();
      const envelope = harness.showReply();
      await harness.runner.tick();
      harness.advance(1700);
      if (interruption === 'failed page read') {
        harness.configuration.readError = true;
      } else {
        harness.setView({
          complete: false,
          transcript: mixedTranscript({
            receiptDiscovery: {
              state: 'unknown_tail',
              candidates: 1,
              matches: 1,
              tailBranches: 2,
              responseControls: 0,
            },
          }),
        });
      }
      await harness.runner.tick();
      assert.equal(harness.runner.status.active, true);
      assert.equal(harness.runner.status.phase, 'reconnecting');
      assertNoReplyEffects(harness);

      harness.configuration.readError = false;
      harness.showReply(envelope);
      harness.setView({ transcript: undefined });
      harness.advance(300);
      await harness.runner.tick();
      assertNoReplyEffects(harness);
      harness.advance(1799);
      await harness.runner.tick();
      assertNoReplyEffects(harness);
      harness.advance(1);
      await harness.runner.tick();
      assert.equal(harness.imports.length, 1);
      assert.deepEqual(JSON.parse(harness.imports[0].text), envelope);
      assert.equal(harness.commits.length, 1);
      await harness.runner.stop();
      await harness.runner.settled();
    });
  }
});
