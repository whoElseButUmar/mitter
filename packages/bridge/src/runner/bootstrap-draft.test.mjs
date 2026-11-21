import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';
import { rawDraftDigest } from '../bootstrap-draft.ts';
import { wrapMessage } from '../message-wire.ts';

const origin = 'https://chatgpt.com';
const exchangeId = 'a05c70de-2fa8-471d-82f0-df6cdf8b64b4';
const oldText = wrapMessage('A previously completed task.', exchangeId);
const emptyTranscript = {
  version: 'message-discovery/1',
  state: 'empty',
  roleAttributes: 0,
  alternativeRoles: 0,
  semanticRoles: 0,
  turnContainers: 0,
  unknownTurns: 0,
  unclassifiedTail: false,
  users: 0,
  assistants: 0,
  codeBlocks: 0,
  openShadowRoots: 0,
  frames: 0,
  scanLimited: false,
};
const proof = {
  workerId: 'old_worker',
  projectId: 'project_1',
  exchangeId,
  origin,
  goalHash: 'a'.repeat(64),
  rawHash: await rawDraftDigest(oldText),
};

function freshHarness(changes = {}) {
  return createHarness({
    options: { newChat: true, url: origin },
    view: { url: origin, transcript: emptyTranscript, composerSession: 'document_1', ...changes },
  });
}

test('first prepare keeps exact raw fingerprint, but confirmation waits for a sent user message', async () => {
  const harness = freshHarness();
  const page = harness.dependencies.page;
  harness.dependencies.page = async (tabId, request) => {
    const result = await page(tabId, request);
    if (request.op === 'prepare') {
      result.draftText = request.text;
    }
    return result;
  };
  const confirmed = [];
  harness.dependencies.confirmBootstrapDraft = async (value) => confirmed.push(value);
  await harness.runner.start();
  assert.equal(confirmed.length, 0);
  const candidate = harness.progress().lastReceipt.bootstrapDraft;
  assert.equal(candidate.rawHash, await rawDraftDigest(harness.commits[0].text));
  harness.setView({
    url: origin + '/c/owned',
    transcript: { ...emptyTranscript, state: 'ready', users: 1, roleAttributes: 1 },
  });
  await harness.runner.tick();
  assert.deepEqual(confirmed, [candidate]);
  await harness.runner.stop();
});

test('a first accepted nonce-linked reply confirms the fingerprint without a readable user bubble', async () => {
  const harness = freshHarness();
  const page = harness.dependencies.page;
  harness.dependencies.page = async (tabId, request) => {
    const result = await page(tabId, request);
    if (request.op === 'prepare') {
      result.draftText = request.text;
    }
    return result;
  };
  const confirmed = [];
  const answered = [];
  harness.dependencies.confirmBootstrapDraft = async (value) => confirmed.push(value);
  harness.dependencies.rememberAnsweredDraft = async (exchange) => {
    assert.equal(harness.imports.length, 1);
    answered.push(exchange);
  };
  await harness.runner.start();
  const envelope = harness.showReply();
  harness.setView({
    url: origin + '/c/owned',
    count: 0,
    userCount: 0,
    lastRole: '',
    lastUserText: '',
    lastUserId: '',
    userIds: [],
    assistantText: '',
    assistantId: '',
    complete: false,
    codeReply: {
      id: envelope.id,
      workerId: envelope.workerId,
      projectId: envelope.projectId,
      replyTo: envelope.replyTo,
      text: JSON.stringify(envelope),
      hasCopyControl: false,
    },
    codeReplyCount: 1,
    codeReplyTotal: 1,
    codeReplyIds: [envelope.id],
  });
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  assert.equal(confirmed.length, 1);
  assert.deepEqual(answered, [envelope.replyTo]);
  assert.equal(harness.progress().lastReceipt.composerHash, confirmed[0].rawHash);
  await harness.runner.stop();
});

test('confirmed stale draft clearing precedes exactly one new send', async () => {
  const harness = freshHarness({ draft: true, draftText: oldText });
  harness.dependencies.findCompletedBootstrapDraft = async (text) => {
    assert.equal(text, oldText);
    return proof;
  };
  const page = harness.dependencies.page;
  let clears = 0;
  harness.dependencies.page = async (tabId, request) => {
    if (request.op === 'clear_draft') {
      clears++;
      assert.equal(request.text, oldText);
      assert.deepEqual(request.staleDraft, proof);
      assert.equal(request.composerSession, 'document_1');
      assert.equal(harness.commits.length, 0);
      harness.setView({ draft: false, draftText: '' });
      return { ...(await page(tabId, { ...request, op: 'inspect' })), outcome: 'cleared' };
    }
    return page(tabId, request);
  };
  await harness.runner.start();
  assert.equal(clears, 1);
  assert.equal(harness.commits.length, 1);
  assert.notEqual(harness.commits[0].text, oldText);
  await harness.runner.tick();
  assert.equal(clears, 1);
  assert.equal(harness.commits.length, 1);
  await harness.runner.stop();
});

test('an unavailable draft-history store cannot interrupt an accepted batch', async () => {
  const harness = createHarness();
  harness.dependencies.rememberAnsweredDraft = async () => {
    throw new Error('Storage unavailable');
  };
  await harness.runner.start();
  harness.showReply();
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  assert.ok(harness.events.includes('worker.run'));
  await harness.runner.stop();
});

test('unknown draft and late completed-task verification preserve the draft and do not send', async (context) => {
  await context.test('no confirmed proof', async () => {
    const harness = freshHarness({ draft: true, draftText: oldText });
    harness.dependencies.findCompletedBootstrapDraft = async () => undefined;
    await assert.rejects(harness.runner.start(), { code: 'DRAFT_CONFLICT' });
    assert.equal(harness.commits.length, 0);
  });
  await context.test('Stop while checking the previous task', async () => {
    const harness = freshHarness({ draft: true, draftText: oldText });
    const pending = Promise.withResolvers();
    harness.dependencies.findCompletedBootstrapDraft = () => pending.promise;
    const starting = harness.runner.start().catch(() => {});
    for (let attempt = 0; attempt < 30 && !harness.events.includes('page:inspect'); attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await harness.runner.stop();
    pending.resolve(proof);
    await starting;
    assert.equal(harness.events.includes('page:clear_draft'), false);
    assert.equal(harness.commits.length, 0);
  });
});
