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
  assert.equal(harness.runner.status.phase, 'waiting_reply');
  assert.match(harness.runner.status.reason, /continue automatically/i);
  assert.doesNotMatch(harness.runner.status.reason, /Use reply/);
  assertNoReplyEffects(harness);
  await harness.runner.stop();
  await harness.runner.settled();
});

test('a briefly unreadable first reply cannot spend the next exchange’s layout grace', async () => {
  const harness = createHarness();
  await harness.runner.start();
  harness.setView(generatingView({ busy: false }));
  await harness.runner.tick();
  assert.equal(harness.runner.status.phase, 'reconnecting');
  harness.advance(10500);

  harness.showReply();
  harness.setView({ transcript: undefined });
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  harness.worker.state = 'review';
  await harness.runner.tick();
  assert.equal(harness.commits.length, 2);

  harness.setView(generatingView({ busy: false }));
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, true);
  assert.equal(harness.runner.status.phase, 'reconnecting');
  harness.advance(11999);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, true);
  harness.advance(1);
  await harness.runner.tick();
  assert.equal(harness.runner.status.monitoring, true);
  assert.equal(harness.runner.status.phase, 'waiting_reply');
  assert.equal(harness.commits.length, 2);
  assert.equal(harness.imports.length, 1);
  await harness.runner.stop();
});

test('a roleless growing JSON reply waits without a layout alarm or permission to import', async () => {
  const harness = createHarness();
  await harness.runner.start();
  await harness.runner.tick();
  const transcript = mixedTranscript({
    roleAttributes: 0,
    turnContainers: 0,
    receiptDiscovery: {
      state: 'unknown_tail',
      candidates: 40,
      matches: 1,
      tailBranches: 2,
      responseControls: 0,
    },
  });
  harness.setView(generatingView({ busy: false, transcript, codeReplyIssue: 'REPLY_IN_PROGRESS' }));
  for (const size of [1000, 4000, 18000]) {
    harness.advance(15000);
    harness.setView({
      codeRead: { characters: size, fingerprint: String(size), issue: 'INVALID_JSON', incomplete: true },
    });
    await harness.runner.tick();
    assert.equal(harness.runner.status.active, true);
    assert.equal(harness.runner.status.phase, 'waiting_reply');
    assert.equal(harness.runner.status.errorCode, undefined);
    assertNoReplyEffects(harness);
  }

  harness.advance(120000);
  await harness.runner.tick();
  assert.equal(harness.runner.status.errorCode, 'REPLY_UNREADABLE');
  assert.equal(harness.runner.status.monitoring, true);
  assertNoReplyEffects(harness);
  await harness.runner.stop();
});

test('a fragment cannot hide ambiguous receipts or recognized unknown transcript barriers', async (context) => {
  for (const [label, roleAttributes, matches] of [
    ['ambiguous roleless receipt', 0, 2],
    ['unknown branch after a recognized user', 1, 1],
  ]) {
    await context.test(label, async () => {
      const harness = createHarness();
      await harness.runner.start();
      harness.setView(
        generatingView({
          busy: false,
          codeReplyIssue: 'REPLY_IN_PROGRESS',
          codeRead: { characters: 1000, fingerprint: 'a123', issue: 'INVALID_JSON', incomplete: true },
          transcript: mixedTranscript({
            roleAttributes,
            receiptDiscovery: {
              state: 'unknown_tail',
              candidates: 2,
              matches,
              tailBranches: 2,
              responseControls: 0,
            },
          }),
        }),
      );
      await harness.runner.tick();
      harness.advance(13000);
      await harness.runner.tick();
      assert.equal(harness.runner.status.errorCode, 'TRANSCRIPT_UNSUPPORTED');
      assertNoReplyEffects(harness);
      await harness.runner.stop();
    });
  }
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

test('a reformatted sent report waits for exact source recovery instead of rejecting a slow reply', async () => {
  const harness = createHarness();
  const page = harness.dependencies.page;
  harness.dependencies.page = async (tabId, request) => {
    const view = await page(tabId, request);
    if (request.op === 'prepare') {
      return { ...view, draftText: request.text };
    }
    return view;
  };
  await harness.runner.start();
  const prior = harness.showReply();
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  harness.worker.state = 'review';
  await harness.runner.tick();
  assert.equal(harness.commits.length, 2);

  const sent = harness.commits[1].text;
  assert.ok(harness.progress().lastReceipt.composerHash);
  const reformatted = sent.replace('CURRENT REPLY CONTRACT', 'CURRENT  REPLY CONTRACT');
  assert.notEqual(reformatted, sent);
  harness.setView({
    lastUserText: reformatted,
    lastUserId: 'report_user',
    userIds: ['sent_user', 'report_user'],
    lastRole: 'assistant',
    busy: true,
    complete: false,
    codeReplyIssue: 'NEWER_USER_MESSAGE',
    codeReplyCount: 0,
    codeReplyIds: [prior.id],
    transcript: mixedTranscript({
      state: 'ready',
      unknownTurns: 0,
      unclassifiedTail: false,
      receiptDiscovery: {
        state: 'mismatch',
        candidates: 1,
        matches: 0,
        tailBranches: 0,
        responseControls: 0,
      },
    }),
  });
  await harness.runner.tick();
  harness.advance(45_000);
  await harness.runner.tick();
  assert.equal(harness.runner.status.phase, 'waiting_reply');
  assert.equal(harness.commits.length, 2);
  assert.equal(harness.imports.length, 1);

  const reply = harness.showReply({ id: 'after_report' });
  harness.setView({ lastUserText: sent, busy: false, transcript: undefined, codeReplyIssue: undefined });
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 2);
  assert.deepEqual(JSON.parse(harness.imports[1].text), reply);
  assert.equal(harness.commits.length, 2);
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

test('a late watch checkpoints changed reader states without saving chat text or resetting its deadline', async () => {
  const harness = createHarness();
  await harness.runner.start();
  await harness.runner.stop('Reader could not classify the response.', 'error', 'TRANSCRIPT_UNSUPPORTED');
  const first = structuredClone(harness.progress());
  const transcript = mixedTranscript({
    receiptDiscovery: {
      state: 'unknown_tail',
      candidates: 8,
      matches: 1,
      tailBranches: 2,
      responseControls: 0,
    },
  });
  harness.setView({ readerRevision: 3, transcript, lastUserText: 'private message contents' });
  await harness.runner.tick();
  const observation = {
    readerRevision: 3,
    transcript: 'partial',
    receipt: 'unknown_tail',
    matches: 1,
    tail: 2,
    reason: 'unclassified_tail',
  };
  assert.deepEqual(harness.progress().readerDiagnostic, observation);
  const revision = harness.progress().revision;
  harness.advance(2000);
  await harness.runner.tick();
  assert.equal(
    harness.progress().revision,
    revision,
    'An identical observation does not write a checkpoint.',
  );
  harness.setView({ transcript: { ...transcript, unclassifiedTail: false } });
  harness.advance(2000);
  await harness.runner.tick();
  assert.deepEqual(harness.progress().readerDiagnostic, { ...observation, reason: 'receipt_mismatch' });
  assert.equal(harness.progress().revision, revision + 1);
  assert.equal(harness.progress().watchUntil, first.watchUntil);
  assert.equal(harness.progress().stage, first.stage);
  assert.equal(harness.progress().activeMs, first.activeMs);
  assert.equal(harness.progress().monitoring, true);
  assert.deepEqual(harness.progress().lastReceipt, first.lastReceipt);
  assertNoReplyEffects(harness);
  await harness.runner.stop();
});
