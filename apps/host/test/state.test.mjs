import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { openNodeSqlite } from '../src/adapters/sqlite.js';
import { Store } from '../src/core/database.js';
import {
  createStateBackup,
  verifyStateBackup,
  listStateBackups,
  restoreStateBackup,
} from '../src/core/backups.js';
import { acquireHostLock } from '../src/core/host-lock.js';
import { resolveStateRoot, assertStateRoot, canonicalLocation } from '../src/core/state-root.js';
import {
  validateResetRoot,
  markResetPending,
  removeApplicationState,
  RESET_MARKER,
} from '../src/core/reset.js';
import { openRuntime } from '../src/runtime.js';
import { temporaryDirectory, deferred, nextTurn } from './fixtures.mjs';
test('backup manifests and SQLite checksums are validated before restore', async (t) => {
  const directory = await temporaryDirectory(t);
  const database = openNodeSqlite(path.join(directory, 'mitter.sqlite'));
  const store = new Store(database);
  store.set('value', 'original');
  const backup = await createStateBackup(database, directory);
  assert.equal((await verifyStateBackup(directory, backup.id)).id, backup.id);
  store.set('value', 'changed');
  store.close();
  const restored = await restoreStateBackup(directory, backup.id, true);
  assert.equal(restored.restored, backup.id);
  assert.equal(restored.projectFilesChanged, false);
  const reopened = new Store(openNodeSqlite(path.join(directory, 'mitter.sqlite')));
  assert.equal(reopened.get('value'), 'original');
  reopened.close();
  const manifest = path.join(directory, 'backups', backup.id + '.json');
  await fs.writeFile(
    manifest,
    JSON.stringify({
      ...backup,
      schemaVersion: '1',
    }),
  );
  await assert.rejects(verifyStateBackup(directory, backup.id));
  assert.equal(
    (await listStateBackups(directory)).some((entry) => entry.id === backup.id),
    false,
  );
  await fs.writeFile(manifest, JSON.stringify(backup));
  await fs.appendFile(path.join(directory, 'backups', backup.id + '.sqlite'), 'corrupt');
  await assert.rejects(verifyStateBackup(directory, backup.id), /size or file type/);
});
test('runtime refuses linked SQLite rollback journals before native storage opens', async (t) => {
  const directory = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  const protectedFile = path.join(outside, 'keep.txt');
  const journal = path.join(directory, 'mitter.sqlite-journal');
  await fs.writeFile(protectedFile, 'outside sentinel');

  for (const link of ['symbolic', 'hard']) {
    if (link === 'symbolic') {
      await fs.symlink(protectedFile, journal);
    } else {
      await fs.link(protectedFile, journal);
    }
    let runtime;

    try {
      await assert.rejects(async () => {
        runtime = await openRuntime({ portable: true, dataDir: directory });
      }, /Unsafe database path: mitter\.sqlite-journal/);
      assert.equal(await fs.readFile(protectedFile, 'utf8'), 'outside sentinel');
      assert.ok(await fs.lstat(journal));
    } finally {
      await runtime?.close();
      await fs.unlink(journal).catch(() => {});
    }
  }
});

test('host lease rejects linked SQLite sidecars before acquiring its lease', async (t) => {
  const directory = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  const protectedFile = path.join(outside, 'keep.txt');
  await fs.writeFile(protectedFile, 'outside sentinel');

  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = path.join(directory, 'host-lease.sqlite' + suffix);
    await fs.symlink(protectedFile, sidecar);
    let release;

    try {
      await assert.rejects(async () => {
        release = await acquireHostLock(directory);
      }, /Unsafe host lock path/);
      assert.equal(await fs.readFile(protectedFile, 'utf8'), 'outside sentinel');
      assert.ok((await fs.lstat(sidecar)).isSymbolicLink());
    } finally {
      await release?.();
      await fs.unlink(sidecar).catch(() => {});
    }
  }
});

test(
  'host lease excludes another host and refuses malformed/linked ' + 'compatibility markers',
  async (t) => {
    const directory = await temporaryDirectory(t);
    const release = await acquireHostLock(directory);
    await assert.rejects(acquireHostLock(directory), /Another Miter host/);
    await release();
    await release();
    await fs.writeFile(path.join(directory, 'host.lock'), '{"pid":"unchecked"}');
    await assert.rejects(acquireHostLock(directory), /Unrecognized host.lock/);
    assert.equal(await fs.readFile(path.join(directory, 'host.lock'), 'utf8'), '{"pid":"unchecked"}');
    await fs.unlink(path.join(directory, 'host.lock'));
    const outside = await temporaryDirectory(t);
    await fs.symlink(path.join(outside, 'marker'), path.join(directory, 'host.lock'));
    await assert.rejects(acquireHostLock(directory), /Unsafe host lock path/);
  },
);
test(
  'state identity detects directory replacement and dangling aliases ' + 'cannot hide protected projects',
  async (t) => {
    const directory = await temporaryDirectory(t);
    const state = path.join(directory, 'state');
    await fs.mkdir(state);
    const identity = await resolveStateRoot(state);
    await fs.rename(state, path.join(directory, 'original'));
    await fs.mkdir(state);
    await assert.rejects(assertStateRoot(identity), /changed/);
    const dangling = path.join(directory, 'dangling');
    await fs.symlink(path.join(directory, 'nonexistent'), dangling);
    await assert.rejects(canonicalLocation(path.join(dangling, 'project')), /Cannot safely resolve/);
    await assert.rejects(validateResetRoot(state, [directory]), /overlaps/);
  },
);
test(
  'reset unlinks symlinks without following them and preserves orphaned ' + 'worktrees/infrastructure',
  async (t) => {
    const directory = await temporaryDirectory(t);
    const outside = await temporaryDirectory(t);
    const identity = await resolveStateRoot(directory);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'user source');
    await fs.symlink(outside, path.join(directory, 'linked'));
    await fs.mkdir(path.join(directory, 'worktrees'));
    await fs.writeFile(path.join(directory, 'worktrees', 'keep.txt'), 'orphaned edits');
    await fs.writeFile(path.join(directory, 'host.lock'), 'infrastructure');
    await fs.writeFile(path.join(directory, 'delete.txt'), 'application state');
    await markResetPending(directory);
    const result = await removeApplicationState(directory, identity);
    assert.equal(result.cleared, true);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'user source');
    assert.equal(await fs.readFile(path.join(directory, 'worktrees', 'keep.txt'), 'utf8'), 'orphaned edits');
    assert.deepEqual((await fs.readdir(directory)).sort(), [RESET_MARKER, 'host.lock', 'worktrees'].sort());
  },
);
test('runtime shutdown waits for the durable reset barrier before releasing ' + 'its lease', async (t) => {
  const directory = await temporaryDirectory(t);
  const runtime = await openRuntime({
    portable: true,
    dataDir: directory,
  });
  t.after(() => runtime.close());
  await assert.rejects(runtime.prepareReset('wrong'), /exactly CLEAR/);
  const external = deferred();
  const started = deferred();
  const preparing = runtime.prepareReset('CLEAR', async () => {
    started.resolve();
    await external.promise;
  });
  await started.promise;
  assert.equal(runtime.resetRequired, true);
  let closed = false;
  const close = runtime.close().then(() => {
    closed = true;
  });
  await nextTurn();
  assert.equal(closed, false);
  external.resolve();
  await preparing;
  await close;
  const reopened = await openRuntime({
    portable: true,
    dataDir: directory,
  });
  assert.equal(reopened.resetRequired, true);
  assert.throws(() => reopened.service, /reset is incomplete/);
  await reopened.reset('CLEAR');
  assert.equal(reopened.resetRequired, true);
  await reopened.completeReset('CLEAR');
  assert.equal(reopened.resetRequired, false);
  await reopened.close();
});
