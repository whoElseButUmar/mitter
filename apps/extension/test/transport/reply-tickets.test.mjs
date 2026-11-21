import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyTickets } from '../../src/background/reply-tickets.ts';
import { replyDigest } from '../../../../packages/bridge/src/reply-recovery.ts';

function ticket(workerId = 'worker') {
  return {
    workerId,
    projectId: 'project',
    goal: 'exact goal',
    link: {
      providerId: 'chatgpt',
      id: 7,
      url: 'https://chatgpt.com/c/conversation',
      title: 'Chat',
      newChat: false,
    },
    envelope: {
      protocol: 'mitter/1',
      id: 'reply',
      workerId,
      projectId: 'project',
      summary: 'Edit file',
      actions: [
        {
          type: 'write',
          path: 'file.txt',
          content: 'original\r\n',
          expectedHash: 'missing',
        },
      ],
    },
    hash: 'a'.repeat(64),
    source: 'chat',
    expiresAt: 120000,
    createdAt: 0,
  };
}

test('reply tickets are task-bound, expiring, superseded, and consumed once', () => {
  let now = 0;
  const tickets = new ReplyTickets(() => now);
  tickets.issue('first', ticket());
  assert.throws(() => tickets.read('first', 'other-task'), /expired/);
  tickets.issue('second', ticket());
  assert.throws(() => tickets.read('first', 'worker'), /expired/);
  assert.equal(tickets.read('second', 'worker').goal, 'exact goal');
  tickets.consume('second');
  assert.throws(() => tickets.read('second', 'worker'), /expired/);
  tickets.issue('expired', ticket());
  now = 120001;
  assert.throws(() => tickets.read('expired', 'worker'), /expired/);
});

test('reading an expired ticket irreversibly releases its payload even if the clock rolls back', () => {
  let now = 0;
  const tickets = new ReplyTickets(() => now);
  tickets.issue('expired', ticket());
  now = 120001;
  assert.throws(() => tickets.read('expired', 'worker'), /expired/);
  now = 0;
  assert.throws(() => tickets.read('expired', 'worker'), /expired/);
});

test('wrong-task reads preserve valid tickets but still release an expired payload', () => {
  let now = 0;
  const tickets = new ReplyTickets(() => now);
  tickets.issue('proof', ticket());
  assert.throws(() => tickets.read('proof', 'another'), /expired/);
  assert.equal(tickets.read('proof', 'worker').goal, 'exact goal');
  now = 120001;
  assert.throws(() => tickets.read('proof', 'another'), /expired/);
  now = 0;
  assert.throws(() => tickets.read('proof', 'worker'), /expired/);
});

test('ticket binding pins the exact tab, conversation, task, project, and goal', () => {
  const tickets = new ReplyTickets(() => 0);
  const value = ticket();
  tickets.issue('proof', value);
  const proof = tickets.read('proof', 'worker');
  const worker = { id: 'worker', projectId: 'project', goal: 'exact goal' };
  tickets.assertBinding(proof, worker, value.link);
  assert.throws(
    () => tickets.assertBinding(proof, worker, { ...value.link, providerId: 'gemini' }),
    /changed/,
  );
  assert.throws(() => tickets.assertBinding(proof, worker, { ...value.link, id: 8 }), /changed/);
  assert.throws(
    () =>
      tickets.assertBinding(proof, worker, {
        ...value.link,
        url: 'https://chatgpt.com/c/different',
      }),
    /changed/,
  );
  assert.throws(() => tickets.assertBinding(proof, { ...worker, id: 'different' }, value.link), /changed/);
  assert.throws(
    () => tickets.assertBinding(proof, { ...worker, projectId: 'different' }, value.link),
    /changed/,
  );
  assert.throws(
    () => tickets.assertBinding(proof, { ...worker, goal: 'changed goal' }, value.link),
    /changed/,
  );
  assert.throws(
    () =>
      tickets.issue('wrong-payload', {
        ...value,
        envelope: { ...value.envelope, workerId: 'another' },
      }),
    /another task/,
  );
});

test('reply ticket approval cannot be reused in a replacement task epoch', () => {
  const tickets = new ReplyTickets(() => 0);
  const value = ticket();
  tickets.issue('proof', value, { epoch: 7, mode: 'active' });
  const proof = tickets.read('proof', 'worker');
  const worker = { id: 'worker', projectId: 'project', goal: 'exact goal', control: { epoch: 7 } };
  tickets.assertBinding(proof, worker, value.link);
  assert.throws(
    () => tickets.assertBinding(proof, { ...worker, control: { epoch: 8 } }, value.link),
    /changed/,
  );
  tickets.revoke('worker');
  assert.throws(() => tickets.assertBinding(proof, worker, value.link), /changed/);
});

test('ticket schema preserves the complete validated reply digest and enforces the bounded cache', async () => {
  const tickets = new ReplyTickets(() => 0);
  const value = ticket();
  value.hash = await replyDigest(value.envelope);
  tickets.issue('exact', value);
  assert.equal(await replyDigest(tickets.read('exact', 'worker').envelope), value.hash);
  const changed = structuredClone(value.envelope);
  changed.actions[0].content = 'original\n';
  assert.notEqual(await replyDigest(changed), value.hash);

  for (let index = 0; index < 12; index++) {
    tickets.issue('ticket-' + index, ticket('worker-' + index));
  }

  assert.throws(() => tickets.read('exact', 'worker'), /expired/);
  tickets.revoke('worker-11');
  assert.throws(() => tickets.read('ticket-11', 'worker-11'), /expired/);
  tickets.clear();
  assert.throws(() => tickets.read('ticket-0', 'worker-0'), /expired/);
});
