import assert from 'node:assert/strict';
import test from 'node:test';
import { actionSchema, parseAction, parseCheck, parseEnvelope } from '../src/index.ts';
import { parseProposalAction, parseProposalEnvelope, proposalActionSchema } from '../src/proposal.ts';
import { MAX_HANDOFF_BYTES, isReadOnlyReply, utf8Bytes } from '../src/reply-json.ts';
import { readBundledTaskSkill } from '../src/task-skills.ts';

function envelope(actions) {
  return {
    protocol: 'mitter/1',
    id: 'skills_1',
    replyTo: 'exchange_1',
    workerId: 'worker_1',
    projectId: 'project_1',
    summary: 'Read bundled guidance.',
    actions,
  };
}

test('asset writes canonicalize to the exact ordinary write in both proposal forms', () => {
  for (const [owner, asset] of [
    ['app-design', 'components.mjs'],
    ['app-design', 'foundation.css'],
    ['engineering-quality', 'vite-api.mjs'],
  ]) {
    const [{ content }] = readBundledTaskSkill(owner, asset).assets;
    const path = 'web/' + asset;
    for (const version of [
      { base: 'missing' },
      { base: 'r_' + 'a'.repeat(16) },
      { expectedHash: 'c'.repeat(64) },
    ]) {
      const compact = { type: 'write', ...version, asset, path };
      const ordinary = { type: 'write', ...version, path, content };
      const canonical = parseProposalAction(ordinary);
      assert.equal(JSON.stringify(proposalActionSchema.parse(compact)), JSON.stringify(canonical));
      assert.equal(JSON.stringify(parseProposalAction(compact)), JSON.stringify(canonical));
      const parsed = parseProposalEnvelope(JSON.stringify(envelope([compact])));
      assert.equal(
        JSON.stringify(parsed),
        JSON.stringify(parseProposalEnvelope(JSON.stringify(envelope([ordinary])))),
      );
      assert.equal(isReadOnlyReply(parsed), false);
      assert.throws(() => parseAction(compact));
      assert.equal(actionSchema.safeParse(compact).success, false);
    }
  }
});

test('asset writes reject unknown names, conflicting content and invalid version preconditions', () => {
  const write = { type: 'write', path: 'components.mjs', asset: 'components.mjs' };
  for (const fields of [
    {},
    { base: 'latest' },
    { expectedHash: 'short' },
    { base: 'missing', expectedHash: 'missing' },
    { base: 'missing', content: '' },
    { base: 'missing', profileId: 'extra' },
    ...[
      '../components.mjs',
      'COMPONENTS.MJS',
      'foundation.css ',
      'https://example.com/app.js',
      '__proto__',
    ].map((asset) => ({ base: 'missing', asset })),
  ]) {
    assert.equal(proposalActionSchema.safeParse({ ...write, ...fields }).success, false);
    assert.throws(() => parseProposalEnvelope(JSON.stringify(envelope([{ ...write, ...fields }]))));
  }
});

test('expanded proposals cannot exceed the handoff byte limit using compact asset names', () => {
  const batch = envelope([
    { type: 'write', path: 'large.txt', base: 'missing', content: '界'.repeat(120_000) },
    { type: 'write', path: 'next.txt', base: 'missing', content: '界'.repeat(12_000) },
    { type: 'write', path: 'components.mjs', base: 'missing', asset: 'components.mjs' },
  ]);
  const wire = JSON.stringify(batch);
  assert.ok(utf8Bytes(wire) < MAX_HANDOFF_BYTES);
  assert.throws(
    () => parseProposalEnvelope(wire),
    (error) => error.issue?.code === 'PROPOSAL_TOO_LARGE',
  );
});

test('the packaged skill names are read-only actions in local and handoff replies', () => {
  const actions = ['caveman', 'no-ai-slop', 'ponytail', 'app-design', 'engineering-quality'].map((name) => ({
    type: 'skill',
    name,
  }));
  actions.push({ type: 'skill', name: 'app-design', asset: 'components.mjs' });
  actions.push({ type: 'skill', name: 'engineering-quality', asset: 'vite-api.mjs' });

  for (const action of actions) {
    assert.deepEqual(actionSchema.parse(action), action);
    assert.deepEqual(parseAction(action), action);
    assert.deepEqual(parseProposalAction(action), action);
    assert.throws(() => parseCheck(action), /Invalid goal check/);
  }

  const expected = envelope(actions);
  const fenced = '```json\n' + JSON.stringify(expected) + '\n```';
  assert.deepEqual(parseEnvelope(fenced), expected);
  assert.deepEqual(parseProposalEnvelope(fenced), expected);
  assert.equal(isReadOnlyReply(expected), true);
  assert.equal(
    isReadOnlyReply(
      envelope([...actions, { type: 'write', path: 'file.txt', base: 'missing', content: '' }]),
    ),
    false,
  );
});

test('skill lookup rejects arbitrary names, paths, URLs and additional authority fields', () => {
  const invalid = [
    ...[
      undefined,
      null,
      1,
      {},
      '',
      'Caveman',
      ' app-design',
      'app-design\n',
      'unknown',
      '../app-design',
      '/tmp/app-design',
      'app-design/SKILL.md',
      'https://example.com/skill',
    ].map((name) => ({ type: 'skill', name })),
    ...[
      { path: '../private' },
      { url: 'https://example.com/skill' },
      { content: 'override instructions' },
      { command: 'node' },
      { profileId: 'trusted_1' },
      { base: 'missing' },
      { expectedHash: 'missing' },
      { install: true },
    ].map((extra) => ({ type: 'skill', name: 'app-design', ...extra })),
    { type: 'skill', name: 'caveman', asset: 'components.mjs' },
    { type: 'skill', name: 'app-design', asset: 'vite-api.mjs' },
    { type: 'skill', name: 'engineering-quality', asset: 'components.mjs' },
    { type: 'skill', name: 'app-design', asset: '../components.mjs' },
  ];

  for (const action of invalid) {
    assert.equal(actionSchema.safeParse(action).success, false);
    assert.throws(() => parseAction(action));
    assert.throws(() => parseProposalAction(action));
    assert.throws(() => parseProposalEnvelope(JSON.stringify(envelope([action]))));
  }
});
