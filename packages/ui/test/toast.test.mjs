import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToastCenter } from '../src/toast.js';

function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map();
  return {
    now: () => now,
    set(fn, ms) {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
    clear(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const pending = [...timers].sort((left, right) => left[1].at - right[1].at)[0];
        if (!pending || pending[1].at > end) {
          break;
        }
        now = pending[1].at;
        timers.delete(pending[0]);
        pending[1].fn();
      }
      now = end;
    },
    get pending() {
      return timers.size;
    },
  };
}

test('toast views keep an explicit action slot when deduplication adds or clears an action', () => {
  const clock = fakeClock();
  const center = new ToastCenter(clock);
  const id = center.push({ message: 'message', key: 'same' });
  const first = center.items()[0];
  assert.equal(Object.hasOwn(first, 'action'), true);
  assert.equal(first.action, undefined);

  const action = { label: 'Run', run() {} };
  assert.equal(center.push({ message: 'action', key: 'same', action }), id);
  assert.equal(center.items()[0].action, action);
  assert.equal(clock.pending, 1);

  assert.equal(center.push({ message: 'no action', key: 'same' }), id);
  const cleared = center.items()[0];
  assert.equal(Object.hasOwn(cleared, 'action'), true);
  assert.equal(cleared.action, undefined);
  assert.equal(clock.pending, 1);
  center.dispose();
  assert.equal(clock.pending, 0);
});

test('toast keys deduplicate, reset duration, and queued entries get a full visible lifetime', () => {
  const clock = fakeClock();
  const center = new ToastCenter(clock, 1, 2);
  const first = center.push({ message: 'first', key: 'key', duration: 1000 });
  clock.advance(500);
  assert.equal(center.push({ message: 'updated', key: 'key', duration: 1000 }), first);
  const second = center.push({ message: 'second', duration: 1000 });
  clock.advance(999);
  assert.equal(center.items()[0].id, first);
  clock.advance(1);
  assert.equal(center.items()[0].id, second);
  clock.advance(999);
  assert.equal(center.items().length, 1);
  clock.advance(1);
  assert.deepEqual(center.items(), []);
  assert.equal(clock.pending, 0);
});

test('hover, focus, hidden-window and busy pauses retain remaining visible time', async () => {
  const clock = fakeClock();
  const center = new ToastCenter(clock);
  const pending = Promise.withResolvers();
  const id = center.push({
    message: 'action',
    duration: 1000,
    action: { label: 'Run', run: () => pending.promise },
  });
  clock.advance(400);
  center.pause(id, 'hover', true);
  center.pause(id, 'focus', true);
  clock.advance(10000);
  center.pause(id, 'hover', false);
  clock.advance(10000);
  center.pause(id, 'focus', false);
  center.pauseAll('hidden', true);
  clock.advance(10000);
  center.pauseAll('hidden', false);
  const invoking = center.invoke(id);
  assert.equal(center.items()[0].busy, true);
  clock.advance(10000);
  pending.reject(new Error('<script>literal failure</script>'));
  await invoking;
  assert.equal(center.items()[0].message, '<script>literal failure</script>');
  assert.equal(center.items()[0].kind, 'error');
  assert.equal(center.items()[0].action, undefined);
  assert.equal(Object.hasOwn(center.items()[0], 'action'), true);
  clock.advance(9999);
  assert.equal(center.items().length, 1);
  clock.advance(1);
  assert.equal(center.items().length, 0);
});

test('toast action cannot be invoked twice and late failures after disposal remain ignored', async () => {
  const clock = fakeClock();
  const center = new ToastCenter(clock);
  const pending = Promise.withResolvers();
  let calls = 0;
  const id = center.push({
    message: 'work',
    action: {
      label: 'Run',
      run: () => {
        calls += 1;
        return pending.promise;
      },
    },
  });
  const invoking = center.invoke(id);
  await center.invoke(id);
  assert.equal(calls, 1);
  center.dispose();
  pending.reject(new Error('late'));
  await invoking;
  assert.deepEqual(center.items(), []);
  assert.equal(clock.pending, 0);
  assert.equal(center.push({ message: 'after disposal' }), '');
});

test('toast queue bounds and disposal preserve visible entries and remove timers', () => {
  const clock = fakeClock();
  const center = new ToastCenter(clock, 1, 1);
  let updates = 0;
  const unsubscribe = center.subscribe(() => {
    updates += 1;
  });
  const first = center.push({ message: 'first' });
  center.push({ message: 'evicted' });
  const latest = center.push({ message: 'latest' });
  assert.equal(center.items()[0].id, first);
  center.dismiss(first);
  assert.equal(center.items()[0].id, latest);
  const before = updates;
  unsubscribe();
  center.dismiss(latest);
  assert.equal(updates, before);
  center.push({ message: 'timer' });
  center.dispose();
  assert.equal(clock.pending, 0);
});

test('failed toast subscription does not retain a listener with no unsubscribe handle', () => {
  const clock = fakeClock();
  const center = new ToastCenter(clock);
  let calls = 0;
  const failure = new Error('Initial notification failed');
  assert.throws(
    () =>
      center.subscribe(() => {
        calls += 1;
        throw failure;
      }),
    (reason) => reason === failure,
  );
  assert.doesNotThrow(() => center.push({ message: 'Still working' }));
  assert.equal(calls, 1);
  assert.equal(clock.pending, 1);
  center.dispose();
});

test('a failed toast notification cannot cancel expiry scheduling', () => {
  const clock = fakeClock();
  const center = new ToastCenter(clock);
  let calls = 0;
  const failure = new Error('Subscriber update failed');
  const unsubscribe = center.subscribe(() => {
    calls += 1;
    if (calls === 2) {
      throw failure;
    }
  });
  assert.throws(
    () => center.push({ message: 'Expires', duration: 1000 }),
    (reason) => reason === failure,
  );
  unsubscribe();
  assert.equal(clock.pending, 1);
  clock.advance(1000);
  assert.deepEqual(center.items(), []);
  assert.equal(clock.pending, 0);
  center.dispose();
});

test('zero queued-toast capacity preserves visible entries without retaining an extra queued action', () => {
  const clock = fakeClock();
  const center = new ToastCenter(clock, 1, 0);
  const first = center.push({ message: 'Visible', duration: 1000 });
  const dropped = center.push({ message: 'Cannot queue', action: { label: 'Run', run() {} } });
  assert.equal(dropped, '');
  assert.equal(center.items()[0].id, first);
  clock.advance(1000);
  assert.deepEqual(center.items(), []);
  assert.equal(clock.pending, 0);
  assert.notEqual(center.push({ message: 'Free capacity' }), '');
  center.dispose();
});

test('toast disposal clears retained entries when the clock disposer throws', async () => {
  const clock = fakeClock();
  const center = new ToastCenter(clock);
  let actions = 0;
  const id = center.push({
    message: 'Action',
    action: {
      label: 'Run',
      run: () => {
        actions += 1;
      },
    },
  });
  const clear = clock.clear;
  const failure = new Error('Timer disposal failed');
  clock.clear = (handle) => {
    clear(handle);
    throw failure;
  };
  assert.throws(
    () => center.dispose(),
    (reason) => reason === failure,
  );
  assert.deepEqual(center.items(), []);
  assert.equal(clock.pending, 0);
  assert.doesNotThrow(() => center.dispose());
  await center.invoke(id);
  assert.equal(actions, 0);
});

test('toast actions show structured explanations and never display opaque object labels', async () => {
  const failures = [
    {
      reason: { message: '  The task is no longer available.  ' },
      message: 'The task is no longer available.',
    },
    { reason: {}, message: 'The notification action failed.' },
    { reason: null, message: 'The notification action failed.' },
    { reason: undefined, message: 'The notification action failed.' },
  ];

  for (const failure of failures) {
    const clock = fakeClock();
    const center = new ToastCenter(clock);

    try {
      const id = center.push({
        message: 'Open task',
        action: {
          label: 'Open',
          run() {
            throw failure.reason;
          },
        },
      });

      await center.invoke(id);
      assert.equal(center.items()[0].message, failure.message);
      assert.equal(center.items()[0].kind, 'error');
      assert.equal(center.items()[0].action, undefined);
    } finally {
      center.dispose();
    }
  }
});

test('late expiry and pause callbacks do not touch a disposed clock or retain new state', () => {
  const clock = fakeClock();
  const center = new ToastCenter(clock);
  const id = center.push({ message: 'Expires', duration: 1000 });
  const failure = new Error('Timer cancellation failed');

  clock.clear = () => {
    throw failure;
  };
  assert.throws(
    () => center.dispose(),
    (error) => error === failure,
  );
  clock.now = () => assert.fail('A disposed toast center must not read its clock.');

  assert.doesNotThrow(() => clock.advance(1000));
  assert.doesNotThrow(() => center.dismiss(id));
  assert.doesNotThrow(() => center.pauseAll('hidden', true));
  assert.equal(center.globalPause.size, 0);
  assert.deepEqual(center.items(), []);
  assert.equal(clock.pending, 0);
});

test('toast action failures with blank reasons still provide readable feedback', async () => {
  const clock = fakeClock();
  const center = new ToastCenter(clock);
  const id = center.push({
    message: 'Action',
    action: {
      label: 'Run',
      run() {
        throw new Error(' ');
      },
    },
  });
  await center.invoke(id);
  assert.equal(center.items()[0].message, 'The notification action failed.');
  assert.equal(center.items()[0].kind, 'error');
  assert.equal(center.items()[0].action, undefined);
  center.dispose();
});

test('a successful late toast action does not access a disposed clock', async () => {
  const clock = fakeClock();
  let stopped = false;
  let lateReads = 0;
  clock.now = () => {
    if (stopped) {
      lateReads += 1;
    }
    return 0;
  };
  const center = new ToastCenter(clock);
  const pending = Promise.withResolvers();
  const id = center.push({ message: 'Action', action: { label: 'Run', run: () => pending.promise } });
  const invoking = center.invoke(id);
  center.dispose();
  stopped = true;
  pending.resolve();
  await invoking;
  assert.equal(lateReads, 0);
  assert.deepEqual(center.items(), []);
});
