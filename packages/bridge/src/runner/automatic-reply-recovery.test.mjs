import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

function showRecovery(harness, kind = 'unreadable_reply', changes = {}) {
  let count = 2;
  let state = 'unknown_tail';
  let matches = 1;
  if (kind === 'duplicate_send') {
    count = 4;
    state = 'ambiguous';
    matches = 2;
  }
  const observation = {
    kind,
    exchangeId: harness.options.lastReceipt.exchangeId,
    userText: harness.commits.at(-1)?.text,
    responseText: '{"protocol":"mitter/1", "actions": [broken]}',
    format: 'plain',
    ...changes,
  };
  harness.setView({
    count,
    lastRole: 'unknown',
    assistantId: '',
    assistantText: '',
    complete: false,
    busy: false,
    codeReply: undefined,
    codeReplyIssue: undefined,
    codeRead: undefined,
    replyRecovery: observation,
    transcript: {
      version: 'message-discovery/2',
      state: 'partial',
      strategy: 'receipt',
      roleAttributes: 0,
      alternativeRoles: 0,
      semanticRoles: 0,
      turnContainers: 0,
      users: 1,
      assistants: 0,
      unknownTurns: 1,
      unclassifiedTail: true,
      codeBlocks: 0,
      openShadowRoots: 0,
      frames: 0,
      scanLimited: false,
      receiptDiscovery: {
        state,
        candidates: 2,
        matches,
        tailBranches: 1,
        responseControls: 0,
      },
    },
  });
  return observation;
}

async function settleRecovery(harness) {
  await harness.runner.tick();
  harness.advance(15000);
  await harness.runner.tick();
}

const project = '56d31d39-0666-4687-8de1-23ebb9b7d585';
const typo = '56d31d39-0666-4686-8de1-23ebb9b7d585';
function singleReceiptReply(harness, changes = {}) {
  const reply = harness.showReply({ id: 'rejected', projectId: typo, ...changes });
  harness.setView({
    codeReplyCount: 0,
    codeReplyIssue: 'NEWER_REPLY_UNREADABLE',
    codeRead: { issue: 'candidate', characters: 280, fingerprint: 'abcd', incomplete: false },
    transcript: {
      version: 'message-discovery/2',
      state: 'ready',
      strategy: 'receipt',
      roleAttributes: 0,
      alternativeRoles: 0,
      semanticRoles: 2,
      turnContainers: 2,
      unknownTurns: 0,
      unclassifiedTail: false,
      users: 1,
      assistants: 1,
      codeBlocks: 1,
      openShadowRoots: 0,
      frames: 0,
      scanLimited: false,
      receiptDiscovery: { state: 'matched', matches: 1, candidates: 1, tailBranches: 1, responseControls: 2 },
    },
  });
  return reply;
}
test('a single project-ID transcription error can request one fresh reply without importing the rejected batch', async () => {
  const harness = createHarness({ worker: { projectId: project } });
  await harness.runner.start();
  const retired = harness.options.lastReceipt.exchangeId;
  singleReceiptReply(harness);
  await settleRecovery(harness);
  assert.equal(harness.commits.length, 2);
  assert.equal(harness.progress().formatRepairs, 1);
  assert.match(harness.commits[1].text, /previous projectId did not match/);
  assert.notEqual(harness.options.lastReceipt.exchangeId, retired);
  assert.deepEqual(harness.imports, []);
  assert.ok(!harness.events.includes('worker.run'));
  harness.setView({
    transcript: undefined,
    codeReplyIssue: undefined,
    codeReplyCount: 0,
    codeRead: undefined,
  });
  const good = harness.showReply({ id: 'corrected' });
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.deepEqual(
    harness.imports.map((row) => JSON.parse(row.text)),
    [good],
  );
  await harness.runner.stop();
});

test('wrong project recovery needs sole exact receipt, fresh ID, same worker/exchange and an unknown one-digit difference', async (context) => {
  for (const name of [
    'draft',
    'changed user',
    'unknown tail',
    'wrong worker',
    'wrong exchange',
    'two digits',
    'known project',
    'already imported',
    'second typo',
  ]) {
    await context.test(name, async () => {
      const harness = createHarness({
        worker: { projectId: project },
        alreadyImported: name === 'already imported',
      });
      if (name === 'known project') {
        const original = harness.dependencies.snapshot;
        harness.dependencies.snapshot = () => ({
          ...original(),
          projects: [{ id: typo, name: 'Other project', root: '/tmp/other', profiles: [], revision: 0 }],
        });
      }
      await harness.runner.start();
      if (name === 'second typo') {
        singleReceiptReply(harness);
        await settleRecovery(harness);
      }
      const sends = harness.commits.length;
      const changes = {};
      if (name === 'wrong worker') {
        changes.workerId = 'other_worker';
      }
      if (name === 'wrong exchange') {
        changes.replyTo = 'retired_exchange';
      }
      if (name === 'two digits') {
        changes.projectId = '56d31d39-0666-4666-8de1-23ebb9b7d585';
      }
      singleReceiptReply(harness, changes);
      if (name === 'draft') {
        harness.setView({ draft: true, draftText: 'My draft' });
      }
      if (name === 'changed user') {
        harness.setView({ lastUserText: 'Different user message' });
      }
      if (name === 'unknown tail') {
        harness.setView({ transcript: undefined });
      }
      await settleRecovery(harness);
      assert.equal(harness.commits.length, sends);
      assert.deepEqual(harness.imports, []);
      await harness.runner.stop();
    });
  }
});

test('the observed escaped literal fence imports without rewriting quoted source', async () => {
  const harness = createHarness();
  await harness.runner.start();
  const envelope = harness.showReply({ summary: 'Keep `ticks`, \\path, &#x20;,\n\tand 😀.' });
  const marker = '\\`\\`\\`';
  const raw = JSON.stringify(envelope, null, 2)
    .split('\n')
    .map((line) => line.replace(/^ +/, (space) => '&#x20;'.repeat(space.length)) + '\\')
    .join('\n');
  harness.setView({ assistantText: marker + 'json\\\n' + raw + '\n' + marker });
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 1);
  assert.deepEqual(JSON.parse(harness.imports[0].text), envelope);
  await harness.runner.stop();
});

test('unreadable and duplicate exchanges recover with fresh nonces and never execute rejected text', async (context) => {
  for (const kind of ['unreadable_reply', 'duplicate_send']) {
    await context.test(kind, async () => {
      const harness = createHarness();
      await harness.runner.start();
      await harness.runner.tick();
      const oldNonce = harness.options.lastReceipt.exchangeId;
      showRecovery(harness, kind);
      await settleRecovery(harness);
      assert.equal(harness.runner.status.active, true);
      assert.equal(harness.commits.length, 2);
      assert.notEqual(harness.options.lastReceipt.exchangeId, oldNonce);
      assert.notEqual(harness.commits[0].text, harness.commits[1].text);
      assert.match(harness.commits[1].text, /REPLY RECOVERY/);
      assert.match(harness.commits[1].text, /No successful changes yet\./);
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.events.includes('worker.run'), false);
      assert.equal(harness.progress().formatRepairs, 1);
      harness.setView({ replyRecovery: undefined, transcript: undefined });
      const envelope = harness.showReply();
      await harness.runner.tick();
      harness.advance(1800);
      await harness.runner.tick();
      await harness.runner.tick();
      assert.equal(harness.imports.length, 1);
      assert.deepEqual(JSON.parse(harness.imports[0].text), envelope);
      assert.equal(harness.events.filter((event) => event === 'worker.run').length, 1);
      assert.equal(harness.progress().formatRepairs, 0);
      await harness.runner.stop();
    });
  }
});

test('a duplicate observation cannot promote a correlated code reply to import authority', async () => {
  const harness = createHarness();
  await harness.runner.start();
  const reply = harness.showReply();
  showRecovery(harness, 'duplicate_send', { responseText: JSON.stringify(reply), format: 'code' });
  harness.setView({
    codeReply: { ...reply, text: JSON.stringify(reply), hasCopyControl: true },
  });
  await settleRecovery(harness);
  assert.equal(harness.commits.length, 2);
  assert.equal(harness.imports.length, 0);
  await harness.runner.stop();
});

test('a provider stream error requests one fresh response and imports only its linked reply', async () => {
  const harness = createHarness();
  await harness.runner.start();
  const failed = harness.options.lastReceipt.exchangeId;
  showRecovery(harness, 'unreadable_reply', {
    issue: 'PROVIDER_STREAM_ERROR',
    responseText: 'Error in message stream',
  });
  await settleRecovery(harness);
  assert.equal(harness.commits.length, 2);
  assert.notEqual(harness.options.lastReceipt.exchangeId, failed);
  assert.equal(harness.imports.length, 0);
  harness.setView({ replyRecovery: undefined, transcript: undefined });
  const reply = harness.showReply();
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.deepEqual(
    harness.imports.map((entry) => JSON.parse(entry.text)),
    [reply],
  );
  await harness.runner.stop();
});

test('a malformed first response can recover after the exact sent receipt pins a new conversation', async () => {
  const harness = createHarness({
    options: { newChat: true },
    view: { url: 'https://chatgpt.com/' },
  });
  await harness.runner.start();
  harness.setView({ url: 'https://chatgpt.com/c/task-1' });
  showRecovery(harness);
  await settleRecovery(harness);
  assert.equal(harness.commits.length, 2);
  assert.equal(harness.runner.status.url, 'https://chatgpt.com/c/task-1');
  assert.equal(harness.progress().conversationUrl, 'https://chatgpt.com/c/task-1');
  assert.equal(harness.imports.length, 0);
  await harness.runner.stop();
});

test('streaming and changing responses restart the recovery quiet period', async () => {
  const harness = createHarness();
  await harness.runner.start();
  const observation = showRecovery(harness);
  await harness.runner.tick();
  harness.advance(15000);
  harness.setView({ busy: true });
  await harness.runner.tick();
  harness.setView({ busy: false });
  await harness.runner.tick();
  harness.advance(14999);
  await harness.runner.tick();
  assert.equal(harness.commits.length, 1);
  harness.setView({ replyRecovery: { ...observation, responseText: '{"actions": [still growing' } });
  await harness.runner.tick();
  harness.advance(15000);
  await harness.runner.tick();
  assert.equal(harness.commits.length, 1);
  harness.advance(105000);
  await harness.runner.tick();
  assert.equal(harness.commits.length, 2, JSON.stringify(harness.runner.status));
  assert.equal(harness.imports.length, 0);
  await harness.runner.stop();
});

test('invalid recovery evidence and unavailable pages never authorize another send', async (context) => {
  for (const [name, change] of [
    ['different full receipt', (observation) => ({ replyRecovery: { ...observation, userText: 'edited' } })],
    ['retired nonce', (observation) => ({ replyRecovery: { ...observation, exchangeId: 'old' } })],
    ['later human turn', () => ({ lastUserText: 'Please stop.', lastUserId: 'human' })],
    ['draft', () => ({ draft: true, draftText: 'My draft' })],
    ['busy', () => ({ busy: true })],
    ['loading', () => ({ ready: false })],
    ['stopped', () => ({ stopped: true })],
    ['navigation', () => ({ url: 'https://chatgpt.com/c/other' })],
  ]) {
    await context.test(name, async () => {
      const harness = createHarness();
      await harness.runner.start();
      const observation = showRecovery(harness);
      harness.setView(change(observation));
      await settleRecovery(harness);
      assert.equal(harness.commits.length, 1);
      assert.equal(harness.imports.length, 0);
      await harness.runner.stop();
    });
  }
});

test('the final live read catches drafts and new human turns arriving during native report lookup', async (context) => {
  for (const change of [{ draft: true, draftText: 'Human draft' }, { lastUserText: 'New instruction' }]) {
    await context.test(JSON.stringify(change), async () => {
      const harness = createHarness();
      await harness.runner.start();
      showRecovery(harness);
      const rpc = harness.dependencies.rpc;
      harness.dependencies.rpc = async (method, params) => {
        const result = await rpc(method, params);
        if (method === 'worker.report') {
          harness.setView(change);
        }
        return result;
      };
      await settleRecovery(harness);
      assert.equal(harness.commits.length, 1);
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.progress().formatRepairs, 0);
      await harness.runner.stop();
    });
  }
});

test('automatic recovery retains its two-request budget across saved checkpoints', async () => {
  const harness = createHarness();
  await harness.runner.start();
  for (let attempt = 1; attempt <= 2; attempt++) {
    showRecovery(harness);
    await settleRecovery(harness);
    assert.equal(harness.commits.length, attempt + 1);
    assert.equal(harness.progress().formatRepairs, attempt);
  }
  const progress = structuredClone(harness.progress());
  const lastReceipt = structuredClone(harness.options.lastReceipt);
  const lastText = harness.commits.at(-1).text;
  await harness.runner.stop();
  const resumed = createHarness({
    progress,
    options: { lastReceipt, resumeExisting: true },
    view: { count: 1, userCount: 1, lastRole: 'user', lastUserText: lastText, lastUserId: 'saved_user' },
  });
  await resumed.runner.start();
  showRecovery(resumed, 'unreadable_reply', { userText: lastText });
  await settleRecovery(resumed);
  assert.equal(resumed.commits.length, 0);
  assert.equal(resumed.imports.length, 0);
  assert.equal(resumed.runner.status.errorCode, 'REPLY_RECOVERY_EXHAUSTED');
  await resumed.runner.stop();
});

test('Stop during the native recovery check prevents the correction send', async () => {
  const harness = createHarness();
  await harness.runner.start();
  showRecovery(harness);
  await harness.runner.tick();
  harness.advance(15000);
  let release;
  let entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const rpc = harness.dependencies.rpc;
  harness.dependencies.rpc = async (method, params) => {
    const result = await rpc(method, params);
    if (method === 'state') {
      entered();
      await held;
    }
    return result;
  };
  const ticking = harness.runner.tick();
  await ready;
  const stopping = harness.runner.stop();
  release();
  await Promise.all([ticking, stopping]);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.progress().formatRepairs, 0);
});

test('a changed native task or queued batch cannot authorize recovery', async (context) => {
  for (const changed of [{ goal: 'A replacement task' }, { queue: [{ type: 'list', path: '.' }] }]) {
    await context.test(JSON.stringify(changed), async () => {
      const harness = createHarness();
      await harness.runner.start();
      showRecovery(harness);
      const rpc = harness.dependencies.rpc;
      harness.dependencies.rpc = async (method, params) => {
        const result = await rpc(method, params);
        if (method === 'state') {
          return { ...result, workers: [{ ...harness.worker, ...changed }] };
        }
        return result;
      };
      await settleRecovery(harness);
      assert.equal(harness.commits.length, 1);
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.progress().formatRepairs, 0);
      await harness.runner.stop();
    });
  }
});

test('native work arriving during report loading or checkpoint saving prevents a recovery send', async (context) => {
  for (const boundary of ['report', 'checkpoint']) {
    for (const changed of [
      { queue: [{ type: 'list', path: '.' }] },
      { state: 'complete' },
      {
        pending: {
          token: 'pending_1',
          fingerprint: 'approval_1',
          action: { type: 'list', path: '.' },
          reason: 'Awaiting approval',
          revision: 1,
        },
      },
    ]) {
      await context.test(boundary + JSON.stringify(changed), async () => {
        const harness = createHarness();
        await harness.runner.start();
        showRecovery(harness);
        if (boundary === 'report') {
          const rpc = harness.dependencies.rpc;
          harness.dependencies.rpc = async (method, params) => {
            const result = await rpc(method, params);
            if (method === 'worker.report') {
              Object.assign(harness.worker, changed);
            }
            return result;
          };
        } else {
          harness.configuration.beforeSave = async (progress) => {
            if (progress.formatRepairs === 1) {
              Object.assign(harness.worker, changed);
            }
          };
        }
        await settleRecovery(harness);
        assert.equal(harness.commits.length, 1);
        assert.equal(harness.imports.length, 0);
        if (boundary === 'report') {
          assert.equal(harness.progress().formatRepairs, 0);
        }
        await harness.runner.stop();
      });
    }
  }
});

test('a restarted background consumes the saved reply once without another Send or a new turn', async () => {
  const original = createHarness();
  await original.runner.start();
  const saved = original.progress();
  saved.phase = 'waiting_reply';
  saved.conversationUrl = original.options.url;
  const resumed = createHarness({
    progress: saved,
    options: {
      waitingReplyRevision: saved.revision,
      lastReceipt: { ...saved.lastReceipt, at: saved.lastReceipt.at + 100 },
    },
    view: {
      lastUserText: original.commits[0].text,
      lastUserId: 'sent_user',
      userIds: ['sent_user'],
      userCount: 1,
    },
  });
  // The sent page can already contain a completed answer before Chrome wakes Miter.
  resumed.showReply();
  await resumed.runner.start();
  assert.equal(resumed.runner.status.active, true);
  assert.equal(resumed.runner.status.phase, 'waiting_reply');
  assert.equal(
    resumed.events.some((event) => event.startsWith('page:')),
    false,
  );
  for (let i = 0; i < 4 && resumed.imports.length === 0; i++) {
    await resumed.runner.tick();
    resumed.advance(2000);
  }
  assert.equal(resumed.imports.length, 1);
  assert.equal(resumed.commits.length, 0);
  assert.equal(resumed.progress().turns, saved.turns);
  assert.equal(resumed.progress().lowerBound, saved.lowerBound);
  assert.equal(resumed.progress().lastReceipt.at, saved.lastReceipt.at);
  assert.equal(resumed.progress().lastImportedId, 'reply_1');
  await resumed.runner.stop();
});
