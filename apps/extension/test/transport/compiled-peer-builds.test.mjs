import assert from 'node:assert/strict';
import test from 'node:test';

// This file runs in its own Node test process. Match the identifier that WXT
// substitutes in a packaged view, so source-mode legacy fixtures cannot pass here.
globalThis.__MITER_BUILD_ID__ = 'bbbbbbbbbbbbbbbb';
const { APP_VERSION, BUILD_ID } = await import('../../../../packages/protocol/src/index.ts');
const { HostClient } = await import('../../src/client.ts');
const { mockPort, snapshot } = await import('./chrome-mock.mjs');

test('a packaged workspace shows legacy and stale same-release backgrounds without sending its action', async (t) => {
  assert.equal(BUILD_ID, 'bbbbbbbbbbbbbbbb');
  for (const buildId of [undefined, 'cccccccccccccccc']) {
    const port = mockPort();
    globalThis.chrome = { runtime: { connect: () => port } };
    const builds = [];
    const client = new HostClient(
      () => {},
      () => {},
      () => {},
      (value) => builds.push(value),
    );
    t.after(() => client.close());
    const pending = client.request('project.create', {
      parentRoot: '/tmp',
      folderName: 'notes',
      name: 'Notes',
    });
    port.onMessage.emit({ type: 'hello', id: port.messages[0].id, version: APP_VERSION, buildId });
    await assert.rejects(pending, /Open chrome:\/\/extensions.*Reload/);
    assert.deepEqual(
      port.messages.map((message) => message.type),
      ['hello'],
    );
    assert.equal(builds.at(-1).background.buildId, buildId);
    client.close();
    assert.deepEqual(builds.at(-1), {});
  }
});

test('packaged views report a legacy helper and retire its identity on disconnect', async (t) => {
  const port = mockPort();
  globalThis.chrome = { runtime: { connect: () => port } };
  const builds = [];
  const errors = [];
  const client = new HostClient(
    () => {},
    (ready, error) => errors.push({ ready, error }),
    () => {},
    (value) => builds.push(value),
  );
  t.after(() => client.close());
  client.connect();
  port.onMessage.emit({ type: 'hello', id: port.messages[0].id, version: APP_VERSION, buildId: BUILD_ID });
  port.onMessage.emit({ event: 'snapshot', data: snapshot });
  assert.equal(builds.at(-1).helper.version, APP_VERSION);
  assert.equal(builds.at(-1).helper.buildId, undefined);
  assert.match(errors.at(-1).error, /build unknown/);
  await assert.rejects(
    client.request('project.create', { parentRoot: '/tmp', folderName: 'notes', name: 'Notes' }),
    /build unknown/,
  );
  assert.equal(port.messages.length, 1);
  port.onMessage.emit({ event: 'connection', connected: false, error: 'Helper disconnected.' });
  assert.equal(builds.at(-1).helper, undefined);
  assert.equal(builds.at(-1).background.buildId, BUILD_ID);
});
