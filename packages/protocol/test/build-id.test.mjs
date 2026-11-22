import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_VERSION, BUILD_ID, describeBuild, matchesBuild } from '../src/index.ts';

test('unstamped source accepts legacy snapshots only at its exact release', () => {
  assert.equal(BUILD_ID, 'source');
  assert.equal(matchesBuild(APP_VERSION), true);
  assert.equal(matchesBuild(APP_VERSION, 'source'), true);
  assert.equal(matchesBuild('earlier', 'source'), false);
  assert.equal(matchesBuild(undefined), false);
  assert.equal(matchesBuild(APP_VERSION, '0123456789abcdef'), false);
  assert.match(describeBuild(APP_VERSION, 'source'), /build source/);
});

test('a packaged build requires both release and source fingerprint, including for legacy snapshots', async (context) => {
  const fingerprint = '1234567890abcdef';
  Object.defineProperty(globalThis, '__MITER_BUILD_ID__', { value: fingerprint, configurable: true });
  context.after(() => {
    delete globalThis.__MITER_BUILD_ID__;
  });
  const packaged = await import('../src/build-id.ts?packaged');
  assert.equal(packaged.BUILD_ID, fingerprint);
  assert.equal(packaged.matchesBuild(APP_VERSION, fingerprint), true);
  for (const id of [undefined, 'source', '1111111111111111']) {
    assert.equal(packaged.matchesBuild(APP_VERSION, id), false);
  }
  assert.equal(packaged.matchesBuild('another-release', fingerprint), false);
  assert.match(packaged.describeBuild(APP_VERSION, fingerprint), /1234567890abcdef/);
});
