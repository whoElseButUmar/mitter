import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_VERSION, BUILD_ID } from '../../../../../packages/protocol/src/index.ts';
import { fixture } from './test-fixture.mjs';

test('state and diagnostics both report this helper’s release and build fingerprint', async (context) => {
  const { service } = await fixture(context);
  const snapshot = await service.handle('state', {});
  const health = await service.handle('system.health', {});
  for (const reported of [snapshot.runtime, health]) {
    assert.equal(reported.version, APP_VERSION);
    assert.equal(reported.buildId, BUILD_ID);
  }
});
