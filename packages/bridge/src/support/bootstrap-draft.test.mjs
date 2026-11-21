import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';
import { matchesBootstrapDraft, rawDraftDigest } from '../bootstrap-draft.ts';
import { wrapMessage } from '../message-wire.ts';
import { ChatLinkStore, LINK_STORAGE_KEY } from '../chat-links.ts';
import { chatLink } from './fixtures.mjs';

const exchangeId = 'a05c70de-2fa8-471d-82f0-df6cdf8b64b4';
const text = wrapMessage('Keep spaces and\nsource bytes.', exchangeId);
const proof = {
  workerId: 'worker_1',
  projectId: 'project_1',
  exchangeId,
  origin: 'https://chatgpt.com',
  goalHash: 'a'.repeat(64),
  rawHash: await rawDraftDigest(text),
};

test('stale-draft authorization preserves every whitespace and frame edit', async () => {
  assert.equal(await matchesBootstrapDraft(text, proof), true);
  for (const edited of [
    ' ' + text,
    text + '\n',
    text.replaceAll('\n', '\r\n'),
    text.replace('spaces', 'other words'),
    text.replace('Keep spaces', 'Keep\u00a0spaces'),
    text.replaceAll(exchangeId, 'b05c70de-2fa8-471d-82f0-df6cdf8b64b4'),
  ]) {
    assert.equal(await matchesBootstrapDraft(edited, proof), false);
  }
});

test('one confirmed bootstrap proof survives later receipts and storage reload without prompt bodies', async () => {
  const stored = {};
  const storage = {
    get: async () => stored,
    set: async (value) => Object.assign(stored, structuredClone(value)),
  };
  const links = new ChatLinkStore(storage);
  await links.ready;
  links.set('worker_1', { ...chatLink, projectId: 'project_1', confirmedBootstrapDraft: proof });
  links.set('worker_1', { ...links.get('worker_1'), updatedAt: 123 });
  await links.flush(true);
  assert.equal(JSON.stringify(stored).includes(text), false);
  const restored = new ChatLinkStore(storage);
  await restored.ready;
  assert.deepEqual(restored.get('worker_1').confirmedBootstrapDraft, proof);
  restored.set('worker_1', {
    ...chatLink,
    projectId: 'project_1',
    confirmedBootstrapDraft: { ...proof, workerId: 'other' },
  });
  assert.equal(restored.get('worker_1').confirmedBootstrapDraft, undefined);
  assert.equal(Object.keys(stored[LINK_STORAGE_KEY].links).length, 1);
  await links.quiesce();
  await restored.quiesce();
});

test('unpaired surrogate edits cannot match a replacement-character fingerprint', async () => {
  const replacement = wrapMessage('Text \uFFFD', exchangeId);
  const invalid = wrapMessage('Text \uD800', exchangeId);
  const replacementProof = { ...proof, rawHash: await rawDraftDigest(replacement) };
  assert.equal(await matchesBootstrapDraft(invalid, replacementProof), false);
  await assert.rejects(rawDraftDigest(invalid), /unpaired Unicode surrogate/);
  const emoji = wrapMessage('Text 🦊', exchangeId);
  assert.equal(await matchesBootstrapDraft(emoji, { ...proof, rawHash: await rawDraftDigest(emoji) }), true);
});
