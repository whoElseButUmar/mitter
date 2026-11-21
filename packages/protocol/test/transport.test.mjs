import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_FRAME } from '../src/index.ts';
import {
  MAX_HANDOFF_BYTES,
  exceedsHandoffBytes,
  hasCompleteReplyFence,
  isIncompleteReplyJSON,
  isReadOnlyReply,
  normalizeReplySyntax,
  readReplyJSON,
  utf8Bytes,
} from '../src/reply-json.ts';
import { parseProposalEnvelope } from '../src/proposal.ts';
import { MAX_NATIVE_TRANSFER, NativeMessageInbox, nativeMessages } from '../src/native-transfer.ts';
import { PART_CHARS } from '../src/schemas/native-transfer.ts';

const event = 'miter.native-part/1';

function fragments(payload, transferId = 'transfer') {
  const source = JSON.stringify(payload);
  return [
    { event, transferId, index: 0, parts: 2, characters: source.length, text: source.slice(0, 1) },
    { event, transferId, index: 1, parts: 2, characters: source.length, text: source.slice(1) },
  ];
}

test('handoff limits count raw UTF-8 bytes, including whitespace/fences', () => {
  assert.equal(utf8Bytes('😀é'), 6);
  assert.equal(exceedsHandoffBytes('é'.repeat(MAX_HANDOFF_BYTES / 2)), false);
  assert.equal(exceedsHandoffBytes('é'.repeat(MAX_HANDOFF_BYTES / 2 + 1)), true);
  assert.deepEqual(readReplyJSON('{}' + ' '.repeat(MAX_HANDOFF_BYTES - 2)), {});
  assert.throws(() => readReplyJSON('{}' + ' '.repeat(MAX_HANDOFF_BYTES - 1)), {
    message: 'Handoff is too large. Split it into smaller batches.',
  });
});

test('syntax recovery cannot change literal source, tokens or quoted whitespace entities', () => {
  const literal = 'exact\u00a0&nbsp; &#160; \\n "quoted"';
  const raw = '{&nbsp;"source":\\\r\n' + JSON.stringify(literal) + '\u202f}';
  assert.deepEqual(readReplyJSON(raw), { source: literal });
  assert.equal(normalizeReplySyntax(JSON.stringify(literal)), JSON.stringify(literal));

  for (const rejected of [
    '{"x":tr&nbsp;ue}',
    '{"x":&quot;value&quot;}',
    '{} {}',
    'prose\n{}',
    '```JSON\n{}\n```',
    '{&amp;nbsp;"x":1}',
  ]) {
    assert.throws(
      () => readReplyJSON(rejected),
      (error) => {
        assert.equal(error.code, 'INVALID_HANDOFF_JSON');
        return true;
      },
    );
  }

  assert.deepEqual(readReplyJSON('```json\n{"x":1}\n```'), { x: 1 });
});

test('streaming and read-only observations do not pretend to validate executable input', () => {
  assert.equal(isIncompleteReplyJSON('{"x":"unfinished'), true);
  assert.equal(isIncompleteReplyJSON('{"x":[]}'), false);
  assert.equal(isIncompleteReplyJSON('{"x":[}'), false);
  assert.equal(isIncompleteReplyJSON('```json\n{"x":['), true);
  assert.equal(isReadOnlyReply({ actions: [{ type: 'read', path: null, extra: 'still invalid' }] }), true);
  assert.equal(isReadOnlyReply({ actions: [{ type: 'write' }] }), false);
  assert.equal(isReadOnlyReply({ actions: [] }), false);
});

test('literal escaped fences preserve every quoted byte through full envelope validation', () => {
  const fence = '\\`'.repeat(3);
  const envelope = {
    protocol: 'mitter/1',
    id: 'reply_1',
    replyTo: 'exchange_1',
    workerId: 'worker_1',
    projectId: 'project_1',
    summary: 'Preserve exact source.',
    actions: [
      {
        type: 'write',
        path: 'notes &#x20;.txt',
        base: 'missing',
        content: '  literal &#x20; &nbsp; &amp;nbsp; \u00a0 \\n \\` "quoted"\r\n```json\n{}\n```\n',
      },
      { type: 'search', query: 'exact &#x20; \\n \u00a0' },
    ],
  };
  const source = JSON.stringify(envelope, null, 2)
    .replace(/^ +/gm, (spaces) => '&#x20;'.repeat(spaces.length))
    .replace(/\n/g, '\\\n');
  const reply = fence + 'json\\\n' + source + '\\\n' + fence;

  assert.equal(hasCompleteReplyFence(reply), true);
  assert.deepEqual(readReplyJSON(reply), envelope);
  assert.deepEqual(parseProposalEnvelope(reply), parseProposalEnvelope(JSON.stringify(envelope)));
  assert.equal(isIncompleteReplyJSON(reply), false);

  for (const marker of ['```', fence]) {
    assert.equal(hasCompleteReplyFence(marker + 'json\r\n{}\r\n' + marker), true);
    assert.deepEqual(readReplyJSON(marker + '\\\r\n{}\\\r\n' + marker), {});
  }
});

test('fence detection rejects ambiguous wrappers without seeking a JSON substring', () => {
  const fence = '\\`'.repeat(3);
  const complete = fence + 'json\\\n{}\\\n' + fence;

  for (const rejected of [
    'Before\n' + complete,
    complete + '\nAfter',
    complete + '\n' + complete,
    fence + 'json\n{}\n```',
    '```json\n{}\n' + fence,
    '\\\\`'.repeat(3) + 'json\n{}\n' + '\\\\`'.repeat(3),
    fence + 'json\\\\\n{}\n' + fence,
    fence + 'JSON\n{}\n' + fence,
    fence + 'json\n{}',
    '{}\n' + fence,
  ]) {
    assert.equal(hasCompleteReplyFence(rejected), false, rejected);
    assert.throws(() => readReplyJSON(rejected), { code: 'INVALID_HANDOFF_JSON' });
  }

  assert.equal(hasCompleteReplyFence('{}'), false);
  assert.equal(hasCompleteReplyFence(complete + ' '.repeat(MAX_HANDOFF_BYTES)), false);
  assert.throws(() => readReplyJSON(complete + ' '.repeat(MAX_HANDOFF_BYTES)), /too large/);
  assert.equal(isIncompleteReplyJSON(fence + 'json\\\n{\\\n&#x20;"actions":['), true);
});

test('a complete literal fence cannot repair invalid quoted source or invalid actions', () => {
  const fence = '\\`'.repeat(3);

  for (const body of [
    '{"source":"bad\\`escape"}',
    '{"source":"unfinished}',
    '{\\\\\n"value":1}',
    '{&amp;#x20;"value":1}',
    '{"value":tr&#x20;ue}',
    '{"value":&quot;quoted&quot;}',
    '{"value":1} {"other":2}',
    '{"value":1',
  ]) {
    const reply = fence + 'json\\\n' + body + '\\\n' + fence;
    assert.equal(hasCompleteReplyFence(reply), true);
    assert.throws(() => readReplyJSON(reply), { code: 'INVALID_HANDOFF_JSON' });
  }

  const invalidEnvelope = {
    protocol: 'mitter/1',
    id: 'reply_1',
    workerId: 'worker_1',
    projectId: 'project_1',
    summary: 'Invalid action remains invalid.',
    actions: [{ type: 'write', path: 'file.txt', content: 'Unreviewed edit has no base.' }],
  };
  const reply = fence + 'json\\\n' + JSON.stringify(invalidEnvelope) + '\\\n' + fence;
  assert.deepEqual(readReplyJSON(reply), invalidEnvelope);
  assert.throws(() => parseProposalEnvelope(reply), /base|expectedHash/);
});

test('native response threshold counts bytes while fragments count UTF-16 characters', () => {
  const atLimit = { text: 'x'.repeat(MAX_FRAME - 11) };
  assert.equal(utf8Bytes(JSON.stringify(atLimit)), MAX_FRAME);
  assert.strictEqual(nativeMessages(atLimit, 'transfer')[0], atLimit);
  assert.ok(nativeMessages({ text: atLimit.text + 'x' }, 'transfer').length > 1);

  // The surrogate pair crosses the first 128,000-character fragment boundary.
  const payload = { text: 'x'.repeat(127_990) + '😀'.repeat(180_000) };
  const inbox = new NativeMessageInbox(() => 0);
  let result;

  for (const fragment of nativeMessages(payload, 'transfer')) {
    result = inbox.accept(fragment);
  }

  assert.deepEqual(result, payload);
  assert.throws(() => nativeMessages({ text: 'x'.repeat(MAX_NATIVE_TRANSFER) }, 'transfer'), {
    message: 'Native response exceeds the 32 MB transfer limit.',
  });
});

test('native inbox preserves passthrough data and legacy ignored fragment extension keys', () => {
  const inbox = new NativeMessageInbox(() => 0);
  const message = { event: 'snapshot', result: 'not validated by this transport' };
  assert.strictEqual(inbox.accept(message), message);
  assert.equal(inbox.accept(null), null);
  const [first, second] = fragments({ ok: true });
  assert.equal(inbox.accept({ ...first, extra: true }), undefined);
  assert.deepEqual(inbox.accept(second), { ok: true });
});

test('native inbox rejects invalid, out-of-order and nested fragments', () => {
  const inbox = new NativeMessageInbox(() => 0);
  const [first, second] = fragments({ ok: true });
  assert.throws(() => inbox.accept({ ...first, parts: 264 }), {
    message: 'Invalid native response fragment.',
  });
  assert.throws(() => inbox.accept(second), { message: 'Unexpected native response fragment.' });
  assert.equal(inbox.accept(first), undefined);
  assert.throws(() => inbox.accept(first), { message: 'Out-of-order native response fragments.' });
  assert.throws(() => inbox.accept(second), { message: 'Unexpected native response fragment.' });
  const [nestedFirst, nestedSecond] = fragments({ event });
  assert.equal(inbox.accept(nestedFirst), undefined);
  assert.throws(() => inbox.accept(nestedSecond), {
    message: 'Nested native response fragments are not supported.',
  });
});

test('a malformed fragment aborts only its transfer and releases its concurrency slot', () => {
  const inbox = new NativeMessageInbox(() => 0);
  for (const transferId of ['a', 'b', 'c', 'd']) {
    inbox.accept(fragments({ ok: true }, transferId)[0]);
  }
  const [, second] = fragments({ ok: true }, 'a');
  assert.throws(() => inbox.accept({ ...second, index: second.parts }), {
    message: 'Invalid native response fragment.',
  });
  assert.equal(inbox.accept(fragments({ ok: true }, 'e')[0]), undefined);
  assert.throws(() => inbox.accept(second), { message: 'Unexpected native response fragment.' });
  assert.deepEqual(inbox.accept(fragments({ ok: true }, 'b')[1]), { ok: true });
});

test('native inbox rejects the existing byte limit before retaining an oversized partial transfer', () => {
  const inbox = new NativeMessageInbox(() => 0);
  const text = '界'.repeat(PART_CHARS);
  const crossingIndex = Math.floor(MAX_NATIVE_TRANSFER / utf8Bytes(text));
  const parts = crossingIndex + 2;
  const fragment = { event, transferId: 'oversized', parts, characters: parts * text.length, text };
  for (let index = 0; index < crossingIndex; index++) {
    assert.equal(inbox.accept({ ...fragment, index }), undefined);
  }
  assert.throws(() => inbox.accept({ ...fragment, index: crossingIndex }), {
    message: 'Native response exceeds its byte limit.',
  });
  assert.throws(() => inbox.accept({ ...fragment, index: crossingIndex + 1 }), {
    message: 'Unexpected native response fragment.',
  });
  const [first, second] = fragments({ ok: true }, 'replacement');
  assert.equal(inbox.accept(first), undefined);
  assert.deepEqual(inbox.accept(second), { ok: true });
});

test('native inbox preserves an exact-limit payload with a surrogate pair split between fragments', () => {
  const prefix = 'x'.repeat(127_990) + '😀';
  const remainingBytes = MAX_NATIVE_TRANSFER - utf8Bytes(JSON.stringify({ text: prefix }));
  const payload = {
    text: prefix + '界'.repeat(Math.floor(remainingBytes / 3)) + 'x'.repeat(remainingBytes % 3),
  };
  assert.equal(utf8Bytes(JSON.stringify(payload)), MAX_NATIVE_TRANSFER);
  const inbox = new NativeMessageInbox(() => 0);
  let result;
  for (const fragment of nativeMessages(payload, 'exact-limit')) {
    result = inbox.accept(fragment);
  }
  assert.deepEqual(result, payload);
});

test('native inbox reports oversized and truncated character counts', () => {
  const inbox = new NativeMessageInbox(() => 0);
  const [first, second] = fragments({ ok: true });
  assert.equal(inbox.accept({ ...first, characters: 1 }), undefined);
  assert.throws(() => inbox.accept({ ...second, characters: 1 }), {
    message: 'Native response size mismatch.',
  });
  assert.equal(inbox.accept({ ...first, characters: first.characters + 1 }), undefined);
  assert.throws(() => inbox.accept({ ...second, characters: second.characters + 1 }), {
    message: 'Truncated native response.',
  });
});

test('native inbox expires strictly after ten seconds, limits concurrency, and clears state', () => {
  let now = 0;
  const inbox = new NativeMessageInbox(() => now);
  const [first, second] = fragments({ ok: true });
  inbox.accept(first);
  now = 10_000;
  assert.deepEqual(inbox.accept(second), { ok: true });
  inbox.accept(first);
  now = 20_001;
  assert.throws(() => inbox.accept(second), { message: 'Unexpected native response fragment.' });

  for (const transferId of ['a', 'b', 'c', 'd']) {
    inbox.accept(fragments({}, transferId)[0]);
  }

  assert.throws(() => inbox.accept(fragments({}, 'e')[0]), {
    message: 'Unexpected native response fragment.',
  });
  inbox.clear();
  assert.equal(inbox.accept(fragments({}, 'e')[0]), undefined);
});
