import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { computeBuildId } from '../build/identity.ts';

test('matching installs get the same fingerprint; runtime changes affect it and generated test output does not', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'miter-build-id-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'first');
  const source = path.resolve(import.meta.dirname, '../..');
  // Use actual build inputs to keep the fixture from drifting when an entrypoint is added.
  for (const entry of [
    'apps/extension',
    'apps/host/src',
    'apps/inference/src',
    'packages',
    'scripts/build',
    'scripts/build-page.mjs',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.host.json',
    'package.json',
  ]) {
    await mkdir(path.dirname(path.join(root, entry)), { recursive: true });
    await cp(path.join(source, entry), path.join(root, entry), {
      recursive: true,
      filter: (filename) => !['node_modules', '.wxt', '.output', '.cache'].includes(path.basename(filename)),
    });
  }
  const initial = computeBuildId(root);
  assert.match(initial, /^[a-f0-9]{16}$/);
  const twin = path.join(directory, 'second');
  await cp(root, twin, { recursive: true });
  assert.equal(computeBuildId(twin), initial);
  await writeFile(path.join(twin, 'apps/extension/public/mitter-page.js'), 'generated bundle');
  await writeFile(path.join(twin, 'apps/host/src/unrelated.test.mjs'), 'test only');
  assert.equal(computeBuildId(twin), initial);
  await writeFile(path.join(twin, 'apps/extension/src/client.ts'), 'export const updated = true;');
  assert.notEqual(computeBuildId(twin), initial);
});
