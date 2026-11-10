import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  stat,
  mkdir,
  link,
  symlink,
  unlink,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicConfig, configTransaction, previousFile } from '../atomic-config.mjs';

async function temporaryDirectory(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mitter-registration-'));

  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

async function assertMode(file, expected) {
  if (process.platform !== 'win32') {
    const metadata = await stat(file);

    assert.equal(metadata.mode & 0o777, expected);
  }
}

test('atomic config replaces bytes privately and leaves no partial files', async (context) => {
  const directory = await temporaryDirectory(context);
  const file = path.join(directory, 'manifest.json');

  assert.equal(await previousFile(file), undefined);
  await atomicConfig(file, 'first\n', 0o600);
  await atomicConfig(file, 'replacement\n', 0o600);
  assert.equal(await readFile(file, 'utf8'), 'replacement\n');
  await assertMode(file, 0o600);
  assert.deepEqual(await readdir(directory), ['manifest.json']);
});

test('atomic config cleans staging after a write failure and preserves the destination', async (context) => {
  const directory = await temporaryDirectory(context);
  const file = path.join(directory, 'launcher');

  await writeFile(file, 'original', { mode: 0o700 });
  await assert.rejects(atomicConfig(file, {}, 0o700), TypeError);
  assert.equal(await readFile(file, 'utf8'), 'original');
  assert.deepEqual(await readdir(directory), ['launcher']);
});

test('atomic config refuses symlinks, hardlinks and non-regular destinations', async (context) => {
  const directory = await temporaryDirectory(context);
  const target = path.join(directory, 'target');
  const symbolic = path.join(directory, 'symbolic');
  const hard = path.join(directory, 'hard');
  const folder = path.join(directory, 'folder');

  await writeFile(target, 'untouched');
  await symlink(target, symbolic);
  await link(target, hard);
  await mkdir(folder);

  for (const file of [symbolic, hard, target, folder]) {
    await assert.rejects(previousFile(file), /linked or non-regular/);
    await assert.rejects(atomicConfig(file, 'unsafe', 0o600), /linked or non-regular/);
  }

  assert.equal(await readFile(target, 'utf8'), 'untouched');
});

test('transactions restore old bytes and modes and remove newly registered files', async (context) => {
  const directory = await temporaryDirectory(context);
  const launcher = path.join(directory, 'launcher');
  const manifest = path.join(directory, 'manifest');
  const added = path.join(directory, 'added');
  const originalError = new Error('registry failed');

  await writeFile(launcher, 'original launcher', { mode: 0o700 });
  await writeFile(manifest, 'original manifest', { mode: 0o600 });
  await assert.rejects(
    configTransaction([launcher, manifest, added], async () => {
      await atomicConfig(launcher, 'new launcher', 0o600);
      await unlink(manifest);
      await atomicConfig(added, 'new manifest', 0o600);

      throw originalError;
    }),
    (error) => {
      assert.equal(error, originalError);

      return true;
    },
  );

  assert.equal(await readFile(launcher, 'utf8'), 'original launcher');
  assert.equal(await readFile(manifest, 'utf8'), 'original manifest');
  await assertMode(launcher, 0o700);
  await assertMode(manifest, 0o600);
  assert.deepEqual((await readdir(directory)).sort(), ['launcher', 'manifest']);
});

test('transaction snapshot failures prevent the write callback', async (context) => {
  const directory = await temporaryDirectory(context);
  const unsafe = path.join(directory, 'folder');
  let writeCalled = false;

  await mkdir(unsafe);
  await assert.rejects(
    configTransaction([unsafe], async () => {
      writeCalled = true;
    }),
    /linked or non-regular/,
  );
  assert.equal(writeCalled, false);
});

test('successful transactions retain their return value and changes', async (context) => {
  const directory = await temporaryDirectory(context);
  const file = path.join(directory, 'launcher');
  const result = await configTransaction([file], async () => {
    await atomicConfig(file, 'registered', 0o700);

    return 'done';
  });

  assert.equal(result, 'done');
  assert.equal(await readFile(file, 'utf8'), 'registered');
  await assertMode(file, 0o700);
});

test('a rollback failure retains its cause and does not skip remaining files', async (context) => {
  const directory = await temporaryDirectory(context);
  const blocked = path.join(directory, 'blocked');
  const recoverable = path.join(directory, 'recoverable');
  const originalError = new Error('registration failed');

  await writeFile(blocked, 'original blocked');
  await writeFile(recoverable, 'original recoverable', { mode: 0o600 });
  await assert.rejects(
    configTransaction([blocked, recoverable], async () => {
      await unlink(blocked);
      await mkdir(blocked);
      await atomicConfig(recoverable, 'changed', 0o600);

      throw originalError;
    }),
    (error) => {
      assert.match(error.message, /registration failed; registration rollback failed:/);
      assert.equal(error.cause, originalError);

      return true;
    },
  );

  assert.equal(await readFile(recoverable, 'utf8'), 'original recoverable');
});
