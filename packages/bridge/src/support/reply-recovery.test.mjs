import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';
import { createHash } from 'node:crypto';
import { worker, reply } from './fixtures.mjs';
const { boundReply, replyHeaders, replyDigest, actionSummary, preferReplyRecovery } =
  await import('../reply-recovery.ts');
const { taskReplyObservationSchema } = await import('../dom/types.ts');
const { readPageState } = await import('../transport/page-state.ts');
const { chatView } = await import('./fixtures.mjs');
const { ReplyValidationError } = await import('../../../protocol/src/validation.ts');

test('candidate headers remain observations and never repair actions or the original reply carrier', () => {
  const proposal = {
    ...reply,
    replyTo: 'exchange_1',
    actions: [{ type: 'write', path: 'source.txt', content: '  exact\\source\r\n🙂\n' }],
  };
  const original = '  ' + JSON.stringify(proposal) + '\n';
  const headers = taskReplyObservationSchema.parse(proposal);
  assert.deepEqual(headers, {
    id: proposal.id,
    workerId: proposal.workerId,
    projectId: proposal.projectId,
    replyTo: proposal.replyTo,
    protocol: proposal.protocol,
  });
  assert.equal(Object.hasOwn(headers, 'actions'), false);
  const observed = readPageState(
    chatView({
      codeReply: {
        id: proposal.id,
        workerId: proposal.workerId,
        projectId: proposal.projectId,
        text: original,
        hasCopyControl: true,
      },
    }),
    'reply',
  );
  assert.equal(observed.codeReply.text, original);
  assert.throws(
    () => boundReply(observed.codeReply.text, worker.id, worker.projectId),
    (error) => {
      assert.ok(error instanceof ReplyValidationError);
      assert.equal(error.issue.code, 'BASE_REQUIRED');
      return true;
    },
  );
  assert.equal(Object.hasOwn(proposal.actions[0], 'base'), false);
  assert.equal(Object.hasOwn(proposal.actions[0], 'expectedHash'), false);
});

test('recovery headers remain relaxed but task-bound; digests and summaries preserve source bytes', async () => {
  const invalidActions = JSON.stringify({
    ...reply,
    replyTo: 'exchange_1',
    actions: [{ type: 'unknown' }],
  });
  assert.deepEqual(replyHeaders(invalidActions, worker.id, worker.projectId), {
    id: reply.id,
    workerId: worker.id,
    projectId: worker.projectId,
    replyTo: 'exchange_1',
  });
  assert.throws(() => boundReply(invalidActions, worker.id, worker.projectId));
  assert.throws(
    () => replyHeaders(JSON.stringify({ ...reply, workerId: 'foreign' }), worker.id, worker.projectId),
    /Reply headers do not match/,
  );
  assert.deepEqual(boundReply(JSON.stringify(reply), worker.id, worker.projectId), reply);
  const write = {
    ...reply,
    actions: [{ type: 'write', path: 'source.txt', content: '🙂é\r\n' }],
  };
  assert.equal(await replyDigest(write), createHash('sha256').update(JSON.stringify(write)).digest('hex'));
  assert.notEqual(
    await replyDigest(write),
    await replyDigest({
      ...write,
      actions: [{ ...write.actions[0], content: '🙂é\n' }],
    }),
  );
  assert.deepEqual(actionSummary(write), ['Write source.txt (8 bytes)']);
  assert.equal(preferReplyRecovery('SAVED_SEND_MISMATCH'), true);
  assert.equal(preferReplyRecovery('TURN_LIMIT'), false);
});
