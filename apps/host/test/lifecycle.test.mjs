import assert from 'node:assert/strict';
import test from 'node:test';
import { Locks } from '../src/core/locks.js';
import { RequestQueue } from '../src/core/request-queue.js';
import { OutputQueue } from '../src/core/output-queue.js';
import { FrameDecoder, encodeFrame } from '../src/core/framing.js';
import { referenceWorkflow, TRANSITIONS } from '../src/core/workflow.js';
import { loadXStateWorkflow } from '../src/adapters/xstate.js';
import { deferred, nextTurn } from './fixtures.mjs';
test('an aborted lock waiter cannot let its successor overtake the current owner', async () => {
  const locks = new Locks();
  const firstGate = deferred();
  const order = [];
  const first = locks.using('workspace', new AbortController().signal, async () => {
    order.push('first');
    await firstGate.promise;
  });
  await nextTurn();
  const abort = new AbortController();
  const middle = locks.using('workspace', abort.signal, async () => order.push('middle'));
  const rejected = assert.rejects(middle);
  const last = locks.using('workspace', new AbortController().signal, async () => order.push('last'));
  abort.abort();
  await rejected;
  await nextTurn();
  assert.deepEqual(order, ['first']);
  firstGate.resolve();
  await Promise.all([first, last]);
  assert.deepEqual(order, ['first', 'last']);
});
test('request queue preserves ordinary FIFO while Stop bypasses a blocked ' + 'ordinary lane', async () => {
  const gate = deferred();
  const order = [];
  const queue = new RequestQueue((error) => assert.fail(String(error)), 2);
  queue.submit('read', async () => {
    order.push('read');
    await gate.promise;
  });
  queue.submit('write', async () => {
    order.push('write');
  });
  assert.equal(
    queue.submit('third', async () => {}),
    false,
  );
  assert.equal(
    queue.submit('worker.stop', async () => {
      order.push('stop');
    }),
    true,
  );
  await nextTurn();
  assert.deepEqual(order, ['read', 'stop']);
  gate.resolve();
  await queue.whenIdle(1000);
  assert.deepEqual(order, ['read', 'stop', 'write']);
  queue.close();
  assert.equal(
    queue.submit('read', async () => {}),
    false,
  );
});
test('output queue coalesces only pending snapshots and fails closed at its bounds', async () => {
  const gate = deferred();
  const sent = [];
  const failures = [];
  const queue = new OutputQueue(
    async (message) => {
      sent.push(message);

      if (sent.length === 1) {
        await gate.promise;
      }
    },
    (error) => failures.push(error),
  );
  queue.send({
    id: 'first',
    ok: true,
  });
  queue.send({
    event: 'snapshot',
    data: 1,
  });
  queue.send({
    id: 'reply',
    ok: true,
  });
  queue.send({
    event: 'snapshot',
    data: 2,
  });
  gate.resolve();
  await nextTurn();
  assert.deepEqual(sent, [
    {
      id: 'first',
      ok: true,
    },
    {
      event: 'snapshot',
      data: 2,
    },
    {
      id: 'reply',
      ok: true,
    },
  ]);
  assert.equal(failures.length, 0);
  const bounded = new OutputQueue(
    async () => {},
    (error) => failures.push(error),
    4,
  );
  bounded.send({
    large: 'message',
  });
  bounded.send({
    id: 'never-written',
  });
  assert.equal(failures.length, 1);
});
test('output queue retains only the charged JSON snapshot rather than a mutable source object', async () => {
  const writing = deferred();
  const sent = [];
  const failures = [];
  const queue = new OutputQueue(
    async (message) => {
      sent.push(message);

      if (sent.length === 1) {
        await writing.promise;
      }
    },
    (error) => failures.push(error),
    128,
  );
  queue.send({ id: 'in-flight' });
  const response = { id: 'queued', result: 'small' };
  queue.send(response);
  response.result = 'x'.repeat(1000);
  response.unserializedResource = { dispose() {} };
  writing.resolve();
  await nextTurn();

  assert.deepEqual(sent, [{ id: 'in-flight' }, { id: 'queued', result: 'small' }]);
  assert.deepEqual(failures, []);
});

test('output queue reports one terminal failure even if an in-flight write later rejects', async () => {
  const writing = deferred();
  const failures = [];
  const sent = [];
  const queue = new OutputQueue(
    async (message) => {
      sent.push(message);
      await writing.promise;
    },
    (error) => failures.push(error),
    64,
  );
  queue.send({ id: 'in-flight' });
  queue.send({ id: 'queued' });
  queue.send({ value: 'x'.repeat(64) });

  assert.equal(failures.length, 1);
  writing.reject(new Error('pipe closed'));
  await nextTurn();

  assert.equal(failures.length, 1);
  assert.deepEqual(sent, [{ id: 'in-flight' }]);
});

test(
  'native frames reject partial/invalid framing and invalid UTF-8, while ' + 'supporting split input',
  () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({
      id: 'request',
      value: '😀',
    });
    assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
    assert.deepEqual(decoder.push(frame.subarray(2)), [
      {
        id: 'request',
        value: '😀',
      },
    ]);
    decoder.end();
    const partial = new FrameDecoder();
    partial.push(frame.subarray(0, 5));
    assert.throws(() => partial.end(), /Incomplete/);
    assert.throws(() => new FrameDecoder().push(Buffer.alloc(4)), /Invalid native frame length/);
    const corrupt = encodeFrame('x');
    corrupt[5] = 255;
    assert.throws(() => new FrameDecoder().push(corrupt));
  },
);
test('reference and real XState adapters conform to the same transition graph', async () => {
  const xstate = await loadXStateWorkflow();

  for (const [initial, targets] of Object.entries(TRANSITIONS)) {
    for (const target of targets) {
      for (const factory of [referenceWorkflow, xstate]) {
        const updates = [];
        const workflow = factory(initial, (state) => updates.push(state));
        workflow.move(target);
        assert.equal(workflow.get(), target);
        assert.equal(updates.at(-1), target);
        workflow.stop();
      }
    }
  }

  for (const factory of [referenceWorkflow, xstate]) {
    const workflow = factory('idle', () => {});
    assert.throws(() => workflow.move('complete'), /Invalid transition/);
    workflow.stop();
  }
});
