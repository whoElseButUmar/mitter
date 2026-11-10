import assert from 'node:assert/strict';
import { test } from 'node:test';
import './test-source-loader.mjs';
import { createHarness } from './fixtures.mjs';

const bridgeAPI = await import(process.env.BRIDGE_RUNNER_MODULE || '../index.ts');

const { PageBridgeError } = await import('../page-transport.ts');
const { LATE_REPLY_WATCH_MS } = await import('./late-reply-watch.ts');
const { buildExchangeMessage } = await import('./prompts.ts');

test('the public barrel preserves existing exports and adds serialized schemas and the RPC boundary', () => {
  assert.deepEqual(
    Object.keys(bridgeAPI).sort(),
    [
      'BridgeRunner',
      'ChatTabLiveness',
      'DATA_RESET_KEY',
      'DataResetCoordinator',
      'LATE_REPLY_WATCH_MS',
      'RESET_VIEW_PARAM',
      'ResetViewBarrier',
      'assertChatTabAvailable',
      'bridgeStatusSchema',
      'bridgeOptionsSchema',
      'bridgeWatchStatusSchema',
      'bridgeResendResultSchema',
      'bridgePreviousProgressSchema',
      'bridgeProgressLoadSchema',
      'bridgeRpcRegistry',
      'chatStartURL',
      'conversationURL',
      'isTaskBootstrap',
      'requestBridgeRpc',
    ].sort(),
  );
});

test('receipt and durable prepared/commit checkpoints precede page mutations', async () => {
  const harness = createHarness();
  await harness.runner.start();
  const events = harness.events;
  const prepareIndex = events.indexOf('page:prepare');
  const commitIndex = events.indexOf('page:commit');
  assert.ok(events.indexOf('save:prepared') < prepareIndex);
  assert.ok(events.indexOf('receipt') < prepareIndex);
  assert.ok(events.lastIndexOf('save:prepared') < commitIndex);
  assert.ok(events.indexOf('save:commit_intent') < commitIndex);
  assert.equal(harness.options.lastReceipt.expectsReplyTo, true);
  assert.equal(harness.runner.status.turns, 1);
  assert.equal(harness.progress().stage, 'waiting_reply');
  assert.equal(harness.commits.length, 1);
  await harness.runner.settled();
});

test('runner outputs conform to the serialized schemas without replacing caller options', async () => {
  const harness = createHarness();
  const { bridgeStatusSchema, bridgeOptionsSchema, bridgeProgressLoadSchema } = bridgeAPI;
  assert.equal(bridgeOptionsSchema.safeParse(harness.options).success, true);
  assert.equal(bridgeStatusSchema.safeParse(harness.runner.status).success, true);
  assert.equal(harness.options.lastReceipt, undefined);
  await harness.runner.start();
  assert.equal(harness.options.lastReceipt.expectsReplyTo, true);
  assert.equal(bridgeOptionsSchema.safeParse(harness.options).success, true);
  assert.equal(
    bridgeProgressLoadSchema.safeParse({
      progress: harness.progress(),
      importedCount: 0,
    }).success,
    true,
  );
  await harness.runner.stop('Cannot read reply.', 'error', 'REPLY_UNREADABLE');
  const deadline = harness.runner.status.watchUntil;
  harness.showReply();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.runner.status.watchUntil, deadline);
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, true);
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  await harness.runner.stop();
  for (const status of harness.publishedStatuses) {
    const parsedStatus = bridgeStatusSchema.safeParse(status);
    assert.equal(parsedStatus.success, true, JSON.stringify(parsedStatus.error));
  }
  await harness.runner.settled();
});

test('confirmed resend outcomes conform to their schema without bypassing send or import guards', async (context) => {
  for (const outcome of ['sent', 'replyFound', 'pending']) {
    await context.test(outcome, async () => {
      const harness = createHarness();
      await harness.runner.start();
      const originalText = harness.commits[0].text;
      const originalExchange = harness.options.lastReceipt.exchangeId;
      await harness.runner.stop('Cannot read reply.', 'error', 'REPLY_UNREADABLE');
      await assert.rejects(harness.runner.resendPrompt(false, originalText), /after your confirmation/);
      assert.equal(harness.commits.length, 1);

      let expected = { sent: true };
      if (outcome === 'replyFound') {
        harness.showReply();
        expected = { sent: false, replyFound: true };
      } else if (outcome === 'pending') {
        harness.configuration.prepareOutcome = 'pending';
        expected = { sent: false, pending: true };
      }

      const result = await harness.runner.resendPrompt(true, originalText);
      assert.deepEqual(result, expected);
      assert.deepEqual(bridgeAPI.bridgeResendResultSchema.parse(result), expected);
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.options.lastReceipt.exchangeId, originalExchange);
      if (outcome === 'sent') {
        assert.equal(harness.commits.length, 2);
        assert.equal(harness.commits[1].text, originalText);
        assert.notEqual(harness.commits[1].messageId, harness.commits[0].messageId);
        assert.equal(harness.runner.status.turns, 2);
      } else {
        assert.equal(harness.commits.length, 1);
      }
      await harness.runner.stop();
      await harness.runner.settled();
    });
  }
});

test('pending prepared and commit checkpoints hold mutations and lifecycle barriers', async (context) => {
  for (const stage of ['prepared', 'commit_intent']) {
    await context.test(stage, async () => {
      let releaseSave;
      let markSaveStarted;
      const release = new Promise((resolve) => {
        releaseSave = resolve;
      });
      const saveStarted = new Promise((resolve) => {
        markSaveStarted = resolve;
      });
      const harness = createHarness({
        beforeSave: async (value) => {
          if (value.stage === stage) {
            markSaveStarted();
            await release;
          }
        },
      });
      const starting = harness.runner.start();
      await saveStarted;
      let flushed = false;
      let settled = false;
      const flushing = harness.runner.flushed().then(() => {
        flushed = true;
      });
      const settling = harness.runner.settled().then(() => {
        settled = true;
      });
      await Promise.resolve();
      assert.equal(flushed, false);
      assert.equal(settled, false);
      assert.equal(harness.commits.length, 0);
      if (stage === 'prepared') {
        assert.ok(!harness.events.includes('page:prepare'));
      }
      releaseSave();
      await Promise.all([starting, flushing, settling]);
      assert.equal(flushed, true);
      assert.equal(settled, true);
      assert.equal(harness.commits.length, 1);
    });
  }
});

test('Stop during a pending checkpoint drains writes without authorizing a later Send', async () => {
  let releaseSave;
  let markSaveStarted;
  const release = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const saveStarted = new Promise((resolve) => {
    markSaveStarted = resolve;
  });
  const harness = createHarness({
    beforeSave: async (value) => {
      if (value.stage === 'prepared') {
        markSaveStarted();
        await release;
      }
    },
  });
  const starting = harness.runner.start();
  const rejectedStart = assert.rejects(starting, {
    message: 'Session stopped.',
  });
  await saveStarted;
  const stopping = harness.runner.stop();
  assert.equal(harness.runner.status.active, false);
  releaseSave();
  await Promise.all([stopping, rejectedStart, harness.runner.settled()]);
  assert.equal(harness.commits.length, 0);
  assert.ok(!harness.events.includes('page:prepare'));
  assert.equal(harness.progress().phase, 'stopped');
});

test('failed durable preparation prevents insertion and Send', async () => {
  const harness = createHarness({ failProgressStage: 'prepared' });
  await assert.rejects(harness.runner.start(), {
    code: 'PROGRESS_SAVE_FAILED',
  });
  assert.ok(!harness.events.includes('page:prepare'));
  assert.equal(harness.commits.length, 0);
  assert.equal(harness.runner.status.turns, 0);
});

test('failed receipt storage prevents insertion and Send', async () => {
  const harness = createHarness({ failReceipt: true });
  await assert.rejects(harness.runner.start(), { code: 'RECEIPT_SAVE_FAILED' });
  assert.ok(!harness.events.includes('page:prepare'));
  assert.equal(harness.commits.length, 0);
});

test('a changed commit document is observed read-only, never blindly sent again', async () => {
  const harness = createHarness({
    commitError: new PageBridgeError('COMMIT_DOCUMENT_CHANGED', 'Document changed.'),
  });
  await harness.runner.start();
  await harness.runner.tick();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.events.filter((event) => event === 'page:prepare').length, 1);
  assert.equal(harness.progress().stage, 'waiting_reply');
  assert.equal(harness.runner.status.turns, 1);
  assert.equal(harness.imports.length, 0);
});

test('an interrupted commit retries only the same prepared bytes, ID, nonce and document ledger', async () => {
  const harness = createHarness({
    commitError: new PageBridgeError('BRIDGE_TIMEOUT', 'Acknowledgement lost.', true),
  });
  await harness.runner.start();
  assert.equal(harness.runner.status.phase, 'sending');
  await harness.runner.tick();
  assert.equal(harness.commits.length, 2);
  const [first, second] = harness.commits;
  assert.equal(first.messageId, second.messageId);
  assert.equal(first.text, second.text);
  assert.equal(first.composerSession, second.composerSession);
  assert.equal(harness.events.filter((event) => event === 'page:prepare').length, 1);
  assert.equal(harness.runner.status.turns, 1);
});

test('a legacy composer without a surviving ledger cannot retry an ambiguous commit', async () => {
  const harness = createHarness({
    legacyComposer: true,
    commitError: new PageBridgeError('BRIDGE_TIMEOUT', 'Acknowledgement lost.', true),
  });
  await harness.runner.start();
  await harness.runner.tick();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.progress().stage, 'waiting_reply');
  assert.equal(harness.imports.length, 0);
});

test('resuming a committed send retains its turn and waits without replaying preparation', async () => {
  const previous = createHarness();
  await previous.runner.start();
  const resumed = createHarness({
    progress: previous.progress(),
    options: { resumeExisting: true },
    view: { count: 1, lastRole: 'user', lastUserText: 'An older message' },
  });
  await resumed.runner.start();
  await resumed.runner.tick();
  assert.equal(resumed.runner.status.turns, 1);
  assert.equal(resumed.commits.length, 0);
  assert.ok(!resumed.events.includes('page:prepare'));
  assert.equal(resumed.imports.length, 0);
});

test('linked complete replies must remain stable before host import and durable local execution', async () => {
  const harness = createHarness();
  await harness.runner.start();
  harness.showReply();
  await harness.runner.tick();
  assert.equal(harness.imports.length, 0);
  harness.advance(1799);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 0);
  harness.advance(1);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  assert.ok(harness.events.indexOf('save:local_batch') < harness.events.indexOf('worker.run'));
  assert.equal(harness.runner.status.phase, 'running');
  assert.equal(harness.commits.length, 1);
});

test('a stale explicit nonce requests bounded correction without importing the rejected actions', async () => {
  const harness = createHarness();
  await harness.runner.start();
  const firstExchange = harness.options.lastReceipt.exchangeId;
  harness.showReply({ replyTo: 'older_exchange' });
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.commits.length, 2);
  assert.notEqual(harness.options.lastReceipt.exchangeId, firstExchange);
  assert.equal(harness.progress().formatRepairs, 1);
});

test('native acknowledgement recovery reconciles only the exact accepted envelope', async () => {
  const harness = createHarness({ importTimeout: true });
  await harness.runner.start();
  harness.showReply();
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  harness.advance(1000);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 2);
  assert.deepEqual(harness.imports[0], harness.imports[1]);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.progress().stage, 'local_batch');
});

test('active-time limits stop the task before another page mutation', async () => {
  const harness = createHarness({ options: { maxMinutes: 1 } });
  await harness.runner.start();
  harness.advance(60000);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.runner.status.monitoring, false);
  assert.equal(harness.runner.status.errorCode, 'TIME_LIMIT');
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.progress().activeMs, 60000);
});

test('late watch is read-only and resumes ordinary validation without consuming idle-watch time', async () => {
  const harness = createHarness();
  await harness.runner.start();
  harness.advance(5000);
  await harness.runner.stop('Cannot read reply.', 'error', 'REPLY_UNREADABLE');
  assert.equal(harness.runner.status.monitoring, true);
  const watchDeadline = harness.runner.status.watchUntil;
  assert.equal(watchDeadline, harness.now() + LATE_REPLY_WATCH_MS);
  const usedBeforeWatch = harness.progress().activeMs;
  harness.showReply();
  harness.advance(10000);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.runner.status.watchUntil, watchDeadline);
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, true);
  assert.equal(harness.runner.status.monitoring, false);
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.progress().activeMs, usedBeforeWatch);
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.commits.length, 1);
});

test('a matching nonce does not authorize a reply following a changed user message', async () => {
  const harness = createHarness();
  await harness.runner.start();
  harness.showReply();
  harness.setView({
    lastUserText: harness.commits[0].text.replace('BOOTSTRAP', 'A different goal'),
  });
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.runner.status.errorCode, 'CHAT_INTERVENED');
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.commits.length, 1);
});

test('duplicate current user IDs remain a barrier even when both messages match exactly', async () => {
  const harness = createHarness();
  await harness.runner.start();
  await harness.runner.tick();
  harness.showReply();
  harness.setView({
    lastUserId: 'second_user',
    userIds: ['sent_user', 'second_user'],
  });
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.runner.status.errorCode, 'CHAT_INTERVENED');
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.commits.length, 1);
});

test('an explicitly selected reply uses the same host gates without spending another send turn', async () => {
  const harness = createHarness();
  const selected = {
    protocol: 'mitter/1',
    id: 'selected_reply',
    workerId: harness.worker.id,
    projectId: harness.worker.projectId,
    summary: 'Selected inspection',
    actions: [{ type: 'list', path: '.' }],
  };
  await harness.runner.startWithReply(
    JSON.stringify(selected),
    'https://chatgpt.com/c/selected-task/?view=reply',
  );
  assert.equal(harness.runner.status.url, 'https://chatgpt.com/c/selected-task');
  assert.equal(harness.runner.status.turns, 0);
  assert.equal(harness.progress().approvedReply.id, selected.id);
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.commits.length, 0);
});

test('a prepared resume retains the exact saved message bytes, ID and exchange link', async () => {
  const previous = createHarness({ failReceipt: true });
  await assert.rejects(previous.runner.start(), {
    code: 'RECEIPT_SAVE_FAILED',
  });
  const savedReceipt = previous.options.lastReceipt;
  const preparedText = buildExchangeMessage('BOOTSTRAP', savedReceipt.exchangeId, previous.worker);
  const resumed = createHarness({
    progress: previous.progress(),
    options: { resumeExisting: true },
    view: { draft: true, draftText: preparedText },
  });
  await resumed.runner.start();
  assert.equal(resumed.commits.length, 1);
  assert.equal(resumed.commits[0].text, preparedText);
  assert.equal(resumed.commits[0].messageId, savedReceipt.messageId);
  assert.equal(resumed.options.lastReceipt.exchangeId, savedReceipt.exchangeId);
  assert.equal(resumed.options.lastReceipt.expectsReplyTo, true);
  assert.equal(resumed.runner.status.turns, 1);
});

test('a lost import acknowledgement resumes the exact host-accepted queue instead of importing or sending', async () => {
  const previous = createHarness();
  await previous.runner.start();
  const accepted = previous.showReply();
  const resumed = createHarness({
    alreadyImported: true,
    progress: previous.progress(),
    options: { resumeExisting: true },
    worker: { state: 'review', queue: [accepted] },
  });
  await resumed.runner.start();
  assert.equal(resumed.progress().stage, 'local_batch');
  assert.equal(resumed.progress().lastImportedId, accepted.id);
  assert.equal(resumed.runner.status.turns, 1);
  assert.ok(resumed.events.includes('worker.resume'));
  assert.equal(resumed.imports.length, 0);
  assert.equal(resumed.commits.length, 0);
});

test('watch retry failures never renew the saved absolute watch deadline', async () => {
  const harness = createHarness();
  await harness.runner.start();
  await harness.runner.stop('Cannot read reply.', 'error', 'REPLY_UNREADABLE');
  const deadline = harness.runner.status.watchUntil;
  harness.configuration.readError = true;
  harness.advance(1500);
  await harness.runner.tick();
  assert.equal(harness.runner.status.watchUntil, deadline);
  harness.advance(deadline - harness.now());
  await harness.runner.tick();
  assert.equal(harness.runner.status.monitoring, false);
  assert.equal(harness.runner.status.watchUntil, undefined);
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.commits.length, 1);
});
