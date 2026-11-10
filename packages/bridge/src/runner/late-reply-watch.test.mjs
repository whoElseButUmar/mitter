import assert from 'node:assert/strict';
import { test } from 'node:test';
import './test-source-loader.mjs';

const { LateReplyWatch, LATE_REPLY_WATCH_MS } = await import('./late-reply-watch.ts');

test('watch polling keeps its lifecycle barrier separate from read scheduling', () => {
  const watch = new LateReplyWatch();
  watch.start('Reader failed.');
  assert.equal(watch.running, false);
  assert.equal(watch.canPoll(10000), true);
  watch.beginPoll(10000);
  assert.equal(watch.running, true);
  assert.equal(watch.canPoll(11499), false);
  assert.equal(watch.canPoll(11500), true);
  watch.finishPoll();
  assert.equal(watch.running, false);
  assert.equal(watch.canPoll(11500), true);
});

test('watch candidates require consecutive stable observations, with a longer correction window', () => {
  const watch = new LateReplyWatch();
  watch.start('Reader failed.');
  assert.equal(watch.isStable('reply:one', 10000, false), false);
  assert.equal(watch.isStable('reply:one', 11799, false), false);
  assert.equal(watch.isStable('reply:one', 11800, false), true);
  watch.clearCandidate();
  assert.equal(watch.isStable('reply:one', 12000, false), false);
  assert.equal(watch.isStable('correction:one', 14000, true), false);
  assert.equal(watch.isStable('correction:one', 16999, true), false);
  assert.equal(watch.isStable('correction:one', 17000, true), true);
  assert.equal(LATE_REPLY_WATCH_MS, 15 * 60000);
});

test('failed watch reads break stability and back off only future reads', () => {
  const watch = new LateReplyWatch();
  watch.start('Reader failed.');
  watch.beginPoll(10000);
  assert.equal(watch.canPoll(11499), false);
  assert.equal(watch.canPoll(11500), true);
  watch.isStable('reply:one', 10000, false);
  assert.equal(watch.readFailed('BRIDGE_TIMEOUT', 11000), true);
  assert.equal(watch.canPoll(13999), false);
  assert.equal(watch.canPoll(14000), true);
  assert.equal(watch.isStable('reply:one', 14000, false), false);
  assert.equal(watch.readFailed('BRIDGE_TIMEOUT', 14000), false);
  assert.equal(watch.canPoll(19999), false);
  assert.equal(watch.canPoll(20000), true);
  assert.equal(watch.readSucceeded(), true);
  assert.equal(watch.readSucceeded(), false);
  assert.equal(watch.canPoll(20000), true);
});
