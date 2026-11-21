import assert from 'node:assert/strict';
import { test } from 'node:test';
import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { establishOwnership, inspectOwnership } from '../installation/ownership.mjs';
import { acquireInstallationLock } from '../installation/lock.mjs';

const identity = { extensionId: 'mclgchkiejnomabbnglaodgnmfhhipep' };
const owner = { format: 1, extensionId: identity.extensionId };
const partialName = '.miter-installation.json.3c4e125b-286f-463d-8932-3f43b3b45d45.partial';

async function temporary(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'miter-owner-recovery-'));

  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

test(
  'complete first-owner partial is promoted only under the installation lock',
  { skip: process.platform !== 'darwin' },
  async (context) => {
    const directory = await temporary(context);
    const partial = path.join(directory, partialName);

    await writeFile(path.join(directory, '.installation.lock'), '');
    await writeFile(partial, JSON.stringify(owner));
    assert.equal((await inspectOwnership(directory, identity)).kind, 'partial');
    const lock = await acquireInstallationLock(directory);

    try {
      await establishOwnership(directory, identity);
    } finally {
      await lock.close();
    }

    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory, '.miter-installation.json'), 'utf8')),
      owner,
    );
    await assert.rejects(readFile(partial), { code: 'ENOENT' });
    assert.equal((await inspectOwnership(directory, identity)).kind, 'owner');
  },
);

test('partial filenames do not authorize unknown, incomplete, foreign or linked contents', async (context) => {
  for (const content of [
    '',
    '{',
    JSON.stringify({ ...owner, extensionId: 'a'.repeat(32) }),
    JSON.stringify({ ...owner, extra: true }),
  ]) {
    const directory = await temporary(context);

    await writeFile(path.join(directory, '.installation.lock'), '');
    await writeFile(path.join(directory, partialName), content);
    const before = await readdir(directory);

    await assert.rejects(inspectOwnership(directory, identity), /empty destination|different extension/);
    assert.deepEqual(await readdir(directory), before);
    assert.equal(await readFile(path.join(directory, partialName), 'utf8'), content);
  }

  for (const extra of [
    'personal.txt',
    '.miter-installation.json.6c4e125b-286f-463d-8932-3f43b3b45d45.partial',
  ]) {
    const directory = await temporary(context);

    await writeFile(path.join(directory, '.installation.lock'), '');
    await writeFile(path.join(directory, partialName), JSON.stringify(owner));
    await writeFile(path.join(directory, extra), 'leave alone');
    await assert.rejects(inspectOwnership(directory, identity), /empty destination/);
    assert.equal(await readFile(path.join(directory, extra), 'utf8'), 'leave alone');
  }

  const directory = await temporary(context);
  const outside = path.join(await temporary(context), 'marker.json');

  await writeFile(outside, JSON.stringify(owner));
  await writeFile(path.join(directory, '.installation.lock'), '');
  await symlink(outside, path.join(directory, partialName));
  await assert.rejects(inspectOwnership(directory, identity), /linked or non-regular/);
  await rm(path.join(directory, partialName));
  await link(outside, path.join(directory, partialName));
  await assert.rejects(inspectOwnership(directory, identity), /linked or non-regular/);
  assert.deepEqual(JSON.parse(await readFile(outside, 'utf8')), owner);
});

test(
  'invalid owner can use matching active metadata, while valid foreign owner always refuses',
  { skip: process.platform !== 'darwin' },
  async (context) => {
    const directory = await temporary(context);
    const ownerFile = path.join(directory, '.miter-installation.json');
    const state = { ...owner, release: 'b'.repeat(64), version: '1.0.0' };

    await writeFile(ownerFile, '{');
    await writeFile(path.join(directory, 'installation.json'), JSON.stringify(state));
    await writeFile(path.join(directory, 'keep.txt'), 'unrelated data');
    assert.equal((await inspectOwnership(directory, identity)).kind, 'state');
    const lock = await acquireInstallationLock(directory);

    try {
      await establishOwnership(directory, identity);
    } finally {
      await lock.close();
    }

    assert.deepEqual(JSON.parse(await readFile(ownerFile, 'utf8')), owner);
    assert.equal(await readFile(path.join(directory, 'keep.txt'), 'utf8'), 'unrelated data');
    const foreign = JSON.stringify({ ...owner, extensionId: 'a'.repeat(32) });

    await writeFile(ownerFile, foreign);
    await assert.rejects(inspectOwnership(directory, identity), /different extension/);
    assert.equal(await readFile(ownerFile, 'utf8'), foreign);
  },
);
