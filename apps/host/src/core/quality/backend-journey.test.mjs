import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendActivity } from './backend-journey.ts';

test('only a newly entered API field read after reloading can prove backend persistence', () => {
  const fill = { type: 'fill', selector: '#name', value: 'New tool' };
  const expect = { type: 'expect', selector: '#list', text: 'Saved: New tool' };
  function run(initial, status, saved, rewriteAfterReload = false) {
    const activity = new BackendActivity();
    activity.start([fill, expect]);
    activity.response('GET', '/api/items', 200, JSON.stringify(initial));
    activity.completed(fill);
    activity.response('POST', '/api/items', status, 'null');
    activity.beginReload();
    if (rewriteAfterReload) {
      activity.response('POST', '/api/items', 201, 'null');
    }
    activity.response('GET', '/api/items', 200, JSON.stringify(saved));
    return activity.completed(expect);
  }
  assert.equal(run([], 201, [{ name: 'New tool' }]), true);
  assert.equal(run([{ name: 'New tool' }], 201, [{ name: 'New tool' }]), false);
  assert.equal(run([], 409, [{ name: 'New tool' }]), false);
  assert.equal(run([], 201, { 'New tool': false }), false);
  assert.equal(run([], 201, [{ name: 'New tool' }], true), false);
});
