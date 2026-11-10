import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionSchema,
  parseAction,
  parseCheck,
  parseChecks,
  parseEnvelope,
  parseEnvelopeWith,
  parseRequest,
  VERSION,
} from '../src/index.ts';
import { parseProposalAction, parseProposalEnvelope, proposalActionSchema } from '../src/proposal.ts';
import { ReplyValidationError, correctionAdvice } from '../src/validation.ts';

const hash = 'a'.repeat(64);
const base = 'r_' + 'b'.repeat(16);
const envelope = {
  protocol: VERSION,
  id: 'batch',
  workerId: 'worker',
  projectId: 'project',
  summary: 'Inspect.',
  actions: [{ type: 'diff' }],
};

function assertIssue(run, expected) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof ReplyValidationError);
    assert.deepEqual(error.issue, expected);
    return true;
  });
}

test('executable actions cannot import unresolved proposal references', () => {
  const referenced = { type: 'write', path: 'a.ts', content: '', base };
  assert.deepEqual(parseProposalAction(referenced), referenced);
  assert.ok(proposalActionSchema.safeParse(referenced).success);
  assert.equal(actionSchema.safeParse(referenced).success, false);
  assert.throws(() => parseAction(referenced), { message: 'Unexpected field: base' });
  assert.deepEqual(parseAction({ type: 'write', path: 'a.ts', content: '', expectedHash: hash }), {
    type: 'write',
    path: 'a.ts',
    content: '',
    expectedHash: hash,
  });
});

test('proposal edit base errors retain stable codes, fields and literal messages', () => {
  assertIssue(() => parseProposalAction({ type: 'write', path: 'a', content: '' }), {
    stage: 'schema',
    code: 'BASE_REQUIRED',
    field: 'base',
    message:
      'An edit needs a recorded read base or an exact expectedHash. ' +
      'No default/current version is assumed.',
  });
  assertIssue(
    () => parseProposalAction({ type: 'write', path: 'a', content: '', base, expectedHash: hash }),
    {
      stage: 'schema',
      code: 'BASE_CONFLICT',
      field: 'base',
      message: 'An edit must use either base or expectedHash, never both.',
    },
  );
  assertIssue(
    () => parseProposalAction({ type: 'replace', path: 'a', before: 'x', after: '', base: 'missing' }),
    {
      stage: 'schema',
      code: 'INVALID_BASE',
      field: 'base',
      message: 'base must be the exact r_ reference returned by read, or "missing" for a new file.',
    },
  );
});

test('no new optional defaults and no materialized undefined action keys', () => {
  assert.deepEqual(parseAction({ type: 'list', path: null }), { type: 'list', path: '.' });
  assert.deepEqual(parseAction({ type: 'team_pause', workerId: 'w', reason: 'wait', seconds: null }), {
    type: 'team_pause',
    workerId: 'w',
    reason: 'wait',
    seconds: 120,
  });
  assert.deepEqual(parseAction({ type: 'read', path: 'a', offset: undefined, limit: undefined }), {
    type: 'read',
    path: 'a',
  });
  assert.deepEqual(parseAction({ type: 'team_message', message: 'x', to: undefined }), {
    type: 'team_message',
    message: 'x',
  });
  assert.throws(() => parseAction({ type: 'read' }), { message: 'Invalid path (maximum 1000 characters).' });
  assert.throws(() => parseAction({ type: 'write', path: 'a', content: '' }), ReplyValidationError);
});

test('optional action normalization preserves defined keys, key order and frozen inputs', () => {
  const read = Object.freeze({ limit: 10, offset: undefined, path: '  a.ts  ', type: 'read' });
  const parsedRead = parseAction(read);
  assert.deepEqual(parsedRead, { type: 'read', path: '  a.ts  ', limit: 10 });
  assert.deepEqual(Object.keys(parsedRead), ['type', 'path', 'limit']);
  assert.equal(Object.hasOwn(read, 'offset'), true);

  const message = Object.freeze({ to: undefined, message: '  exact  ', type: 'team_message' });
  const parsedMessage = parseAction(message);
  assert.deepEqual(parsedMessage, { type: 'team_message', message: '  exact  ' });
  assert.deepEqual(Object.keys(parsedMessage), ['type', 'message']);
  assert.equal(Object.hasOwn(message, 'to'), true);

  assert.deepEqual(parseAction({ type: 'read', path: 'a', offset: 0, limit: undefined }), {
    type: 'read',
    path: 'a',
    offset: 0,
  });
  assert.deepEqual(parseAction({ type: 'team_message', message: 'x', to: 'worker' }), {
    type: 'team_message',
    message: 'x',
    to: 'worker',
  });
});

test('strict keys have their original priority and safe envelope diagnostics', () => {
  assert.throws(() => parseAction({ type: 'read', path: '', private: 'secret' }), {
    message: 'Unexpected field: private',
  });
  assertIssue(
    () =>
      parseEnvelope(
        JSON.stringify({
          ...envelope,
          actions: [{ type: 'diff' }, { type: 'read', path: '', private: 'secret' }],
        }),
      ),
    {
      stage: 'schema',
      code: 'INVALID_ACTION',
      actionIndex: 1,
      message: 'The action contains unsupported fields.',
    },
  );
  assertIssue(() => parseEnvelope(JSON.stringify({ ...envelope, private: 'secret' })), {
    stage: 'schema',
    code: 'ENVELOPE_FIELDS',
    message: 'The reply contains unsupported top-level fields.',
  });
});

test('finish ordering applies to proposals, not legacy executable queues', () => {
  const input = JSON.stringify({
    ...envelope,
    actions: [{ type: 'finish', summary: 'done' }, { type: 'diff' }],
  });
  assert.equal(parseEnvelope(input).actions.length, 2);
  assertIssue(() => parseProposalEnvelope(input), {
    stage: 'schema',
    code: 'FINISH_ORDER',
    actionIndex: 0,
    field: 'type',
    message: 'finish must be the final action in a batch.',
  });
});

test('exact-hash errors keep action indexes and never echo a rejected hash', () => {
  const source = JSON.stringify({
    ...envelope,
    actions: [
      { type: 'diff' },
      { type: 'write', path: 'a', content: '', expectedHash: 'private explanation' },
    ],
  });
  assert.throws(
    () => parseEnvelope(source),
    (error) => {
      assert.ok(error instanceof ReplyValidationError);
      assert.equal(error.issue.code, 'INVALID_EXPECTED_HASH');
      assert.equal(error.issue.field, 'expectedHash');
      assert.equal(error.issue.actionIndex, 1);
      assert.equal(error.message.includes('private explanation'), false);
      assert.ok(correctionAdvice(error.issue).includes('actions[1] (action 2)'));
      return true;
    },
  );
});

test('schema validation never runs callbacks for an invalid envelope header', () => {
  let calls = 0;
  const parse = (value) => {
    calls += 1;
    return { observation: value };
  };
  assert.throws(() => parseEnvelopeWith(JSON.stringify({ ...envelope, protocol: 'other' }), parse), {
    message: 'Unsupported protocol. Expected mitter/1.',
  });
  assert.equal(calls, 0);
  assert.deepEqual(parseEnvelopeWith(JSON.stringify(envelope), parse).actions, [
    { observation: { type: 'diff' } },
  ]);
  assert.equal(calls, 1);
});

test('check and request boundaries remain strict and retain original defaults', () => {
  assert.deepEqual(parseChecks([]), []);
  assert.equal(parseChecks(Array.from({ length: 20 }, () => ({ type: 'exists', path: '.' }))).length, 20);
  assert.throws(() => parseChecks(Array(21)), { message: 'Provide an array of at most 20 checks.' });
  assert.throws(() => parseCheck({ type: 'exists', path: '.', extra: true }), {
    message: 'Unexpected field: extra',
  });
  assert.deepEqual(parseRequest({ id: 'request', method: 'snapshot', params: null }), {
    id: 'request',
    method: 'snapshot',
    params: {},
  });
  assert.throws(() => parseRequest({ id: 'request', method: 'snapshot', params: [] }), {
    message: 'Expected params.',
  });
});
