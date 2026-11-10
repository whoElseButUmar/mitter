import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingRequests } from '../../src/transport/pending-requests.ts';
import { NativeRequestTimeout } from '../../../../packages/bridge/src/native-request.ts';

function setup(context) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = new PendingRequests();
  context.after(() => {
    pending.rejectAll(new Error('Test cleanup'));
    context.mock.timers.tick(1000);
  });

  return pending;
}

test('pending responses, post failures, and teardown clear their timers and preserve rejection identity', async (context) => {
  const pending = setup(context);
  let timeouts = 0;
  let posts = 0;
  const timeout = () => {
    timeouts++;
    return new Error('Unexpected timeout');
  };
  const post = () => {
    posts++;
  };
  const completed = pending.send('complete', 100, timeout, post);
  assert.equal(pending.receive({ id: 'complete', ok: true, result: 'exact result' }), true);
  assert.equal(await completed, 'exact result');
  assert.equal(pending.receive({ id: 'complete', ok: true, result: 'late duplicate' }), false);
  const denied = pending.send('denied', 100, timeout, post);
  pending.receive({ id: 'denied', ok: false, error: 'Policy denied this action.' });
  await assert.rejects(denied, /Policy denied/);
  const failure = new Error('Posting failed');
  await assert.rejects(
    pending.send('failed', 100, timeout, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  const first = pending.send('first', 100, timeout, post);
  const second = pending.send('second', 100, timeout, post);
  const disposed = new Error('Connection disposed; operations were not replayed.');
  const rejected = [
    assert.rejects(first, (error) => error === disposed),
    assert.rejects(second, (error) => error === disposed),
  ];
  pending.rejectAll(disposed);
  pending.rejectAll(disposed);
  await Promise.all(rejected);
  context.mock.timers.tick(1000);
  assert.equal(timeouts, 0);
  assert.equal(posts, 4);
  assert.equal(pending.receive({ id: 'first', ok: true, result: 'late' }), false);
});

test('duplicate pending IDs cannot overwrite the original request or post another operation', async (context) => {
  const pending = setup(context);
  const timeout = new NativeRequestTimeout('worker.import');
  let posts = 0;
  const post = () => {
    posts++;
  };
  const original = pending.send('same-id', 100, () => timeout, post);
  void original.catch(() => {});
  const duplicate = pending.send('same-id', 200, () => new Error('Wrong request timed out'), post);
  void duplicate.catch(() => {});
  assert.equal(posts, 1);
  await assert.rejects(duplicate, /already pending.*not sent/);
  const expired = assert.rejects(original, (error) => error === timeout);
  context.mock.timers.tick(100);
  await expired;
  assert.equal(pending.receive({ id: 'same-id', ok: true, result: 'late import receipt' }), false);
});

test('a throwing timeout factory rejects its promise instead of escaping the timer callback', async (context) => {
  const pending = setup(context);
  const failure = new Error('Could not construct timeout detail');
  const request = pending.send(
    'request',
    100,
    () => {
      throw failure;
    },
    () => {},
  );
  const rejected = assert.rejects(request, (error) => error === failure);
  assert.doesNotThrow(() => context.mock.timers.tick(100));
  await rejected;
  assert.equal(pending.receive({ id: 'request', ok: true, result: 'late' }), false);
});

test('old post cleanup cannot remove a replacement request admitted during teardown', async (context) => {
  const pending = setup(context);
  let replacement;
  let replacementTimeouts = 0;
  const original = pending.send(
    'same-id',
    100,
    () => new Error('Old timeout'),
    () => {
      pending.rejectAll(new Error('Previous connection retired.'));
      replacement = pending.send(
        'same-id',
        200,
        () => {
          replacementTimeouts++;
          return new Error('Replacement timed out');
        },
        () => {},
      );
      void replacement.catch(() => {});
      throw new Error('The old post callback failed after teardown.');
    },
  );
  await assert.rejects(original, /Previous connection retired/);
  assert.equal(pending.receive({ id: 'same-id', ok: true, result: 'replacement result' }), true);
  assert.equal(await replacement, 'replacement result');
  context.mock.timers.tick(1000);
  assert.equal(replacementTimeouts, 0);
});
