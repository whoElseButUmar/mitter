import './host-source-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import {
  createMaintenanceBackup,
  parseMaintenanceArguments,
  requireStateRestoreSchema,
  restoreMaintenanceBackup,
} from '../maintenance.mjs';

const host = await import('../../apps/host/src/core/backups.js');
const { stateRestoreResultSchema, verifyStateBackup } = host;
const { stateBackupsSchema } = await import('../../packages/protocol/src/rpc.js');
const { acquireHostLock } = await import('../../apps/host/src/core/host-lock.js');
const { openNodeSqlite } = await import('../../apps/host/src/adapters/sqlite.js');

async function temporaryDirectory(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mitter-maintenance-'));

  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

const selectedId = 'state-20261011T123456789Z-12345678-1234-4abc-8def-123456789abc';
const rollbackId = 'state-20261011T123456790Z-87654321-4321-4def-9abc-cba987654321';

async function createFixtureDatabase(directory) {
  const file = path.join(directory, 'mitter.sqlite');
  const source = new DatabaseSync(file);

  try {
    source.exec(
      'CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); ' +
        'CREATE TABLE workers (id TEXT); CREATE TABLE projects (id TEXT); ' +
        'CREATE TABLE envelopes (id TEXT); CREATE TABLE events (id INTEGER); ' +
        'CREATE TABLE journal (id TEXT); PRAGMA user_version=1;',
    );
    source.prepare('INSERT INTO kv VALUES (?, ?)').run('test', 'private state');
  } finally {
    source.close();
  }

  return file;
}

test('maintenance validates commands, backup IDs and confirmation before loading state APIs', () => {
  const id = selectedId;

  assert.deepEqual(parseMaintenanceArguments([]), { command: 'help', id: undefined, confirmed: false });
  assert.deepEqual(parseMaintenanceArguments(['backup']), {
    command: 'backup',
    id: undefined,
    confirmed: false,
  });
  assert.deepEqual(parseMaintenanceArguments(['restore', id, '--confirm']), {
    command: 'restore',
    id,
    confirmed: true,
  });
  assert.deepEqual(parseMaintenanceArguments(['verify', id]), { command: 'verify', id, confirmed: false });

  for (const args of [
    ['backup', '--dry-run'],
    ['list', '--confirm'],
    ['help', 'backup'],
    ['verify'],
    ['verify', '../backup'],
    ['verify', id, '--confirm'],
    ['restore', id, '--confrim'],
    ['restore', id, '--confirm', '--confirm'],
  ]) {
    assert.throws(() => parseMaintenanceArguments(args), /Usage:/);
  }
});

test('maintenance backups use the actual host database wrapper and remain restorable', async (context) => {
  const directory = await temporaryDirectory(context);
  const sourceFile = await createFixtureDatabase(directory);
  const originalBytes = await readFile(sourceFile);
  const backup = await createMaintenanceBackup(directory);

  assert.equal(backup.reason, 'maintenance');
  assert.deepEqual(stateBackupsSchema.parse([backup]), [backup]);
  assert.equal(backup.schemaVersion, 1);
  assert.deepEqual(await verifyStateBackup(directory, backup.id), backup);
  assert.deepEqual(await readFile(sourceFile), originalBytes);
  const backupFile = path.join(directory, 'backups', backup.id + '.sqlite');
  const copy = openNodeSqlite(backupFile, true);

  try {
    assert.deepEqual(copy.prepare('SELECT value FROM kv WHERE key=?').get('test'), {
      value: 'private state',
    });
  } finally {
    copy.close();
  }

  if (process.platform !== 'win32') {
    assert.equal((await stat(backupFile)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(directory, 'backups', backup.id + '.json'))).mode & 0o777, 0o600);
  }

  await assert.rejects(access(path.join(directory, 'host.lock')), {
    code: 'ENOENT',
  });
  const release = await acquireHostLock(directory);

  await release();
});

test('maintenance uses the canonical host restore schema and refuses absent or fake exports before mutation', async () => {
  assert.equal(requireStateRestoreSchema(host), stateRestoreResultSchema);
  let calls = 0;

  for (const schema of [undefined, null, { parse() {} }, z.string().describe('Not a restore receipt.')]) {
    const staleHost = {
      stateRestoreResultSchema: schema,
      async restoreStateBackup() {
        calls++;

        throw new Error('A stale host must not reach restore.');
      },
    };

    await assert.rejects(
      restoreMaintenanceBackup('/unused/state', selectedId, true, staleHost),
      /canonical state restore receipt schema is missing.*Run pnpm build:host.*Restore was not started/,
    );
  }

  assert.equal(calls, 0);
});

test('restore validates canonical backup IDs and explicit confirmation before calling the host', async () => {
  let calls = 0;
  const checkedHost = {
    stateRestoreResultSchema,
    async restoreStateBackup() {
      calls++;

      throw new Error('Invalid inputs must not reach restore.');
    },
  };

  for (const id of ['../backup', 'state-20261011T123456789Z-12345678-1234-1234-1234-123456789abc']) {
    await assert.rejects(
      restoreMaintenanceBackup('/unused/state', id, true, checkedHost),
      /Select a listed state backup.*Restore was not started/,
    );
  }
  await assert.rejects(
    restoreMaintenanceBackup('/unused/state', selectedId, false, checkedHost),
    /Restore needs --confirm.*Restore was not started/,
  );
  await assert.rejects(
    restoreMaintenanceBackup('/unused/state', selectedId, true, { stateRestoreResultSchema }),
    /state restore API is missing.*Restore was not started/,
  );

  assert.equal(calls, 0);
});

test('restore accepts canonical receipts with and without a rollback backup and runs exactly once', async () => {
  for (const receipt of [
    { restored: selectedId, projectFilesChanged: false },
    { restored: selectedId, rollback: rollbackId, projectFilesChanged: false },
  ]) {
    let calls = 0;
    const checkedHost = {
      stateRestoreResultSchema,
      async restoreStateBackup(directory, id, confirmed) {
        calls++;
        assert.equal(directory, '/unused/state');
        assert.equal(id, selectedId);
        assert.equal(confirmed, true);

        return receipt;
      },
    };

    assert.deepEqual(await restoreMaintenanceBackup('/unused/state', selectedId, true, checkedHost), receipt);
    assert.equal(calls, 1);
  }
});

test('invalid restore acknowledgements retain canonical validation causes and never replay the write', async () => {
  for (const receipt of [
    undefined,
    null,
    {},
    { restored: selectedId, projectFilesChanged: true },
    { restored: selectedId, rollback: '../backup', projectFilesChanged: false },
    { restored: selectedId, projectFilesChanged: false, extra: true },
  ]) {
    let calls = 0;
    const checkedHost = {
      stateRestoreResultSchema,
      async restoreStateBackup() {
        calls++;

        return receipt;
      },
    };

    await assert.rejects(
      restoreMaintenanceBackup('/unused/state', selectedId, true, checkedHost),
      (error) => {
        assert.match(
          error.message,
          /invalid restore acknowledgement.*Check saved state before repeating the restore/,
        );
        assert.ok(error.cause instanceof z.ZodError);
        assert.doesNotMatch(error.message, /invalid_type|unrecognized_keys/);

        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test('a receipt for another backup is not success and does not trigger a restore replay', async () => {
  let calls = 0;
  const checkedHost = {
    stateRestoreResultSchema,
    async restoreStateBackup() {
      calls++;

      return { restored: rollbackId, projectFilesChanged: false };
    },
  };

  await assert.rejects(
    restoreMaintenanceBackup('/unused/state', selectedId, true, checkedHost),
    /does not match the selected backup.*Check saved state before repeating the restore/,
  );
  assert.equal(calls, 1);
});

test('a lost restore acknowledgement preserves its cause and asks for a saved-state check, not a retry', async () => {
  const failure = new Error('Controlled lost acknowledgement after a write.');
  let calls = 0;
  const checkedHost = {
    stateRestoreResultSchema,
    async restoreStateBackup() {
      calls++;

      throw failure;
    },
  };

  await assert.rejects(restoreMaintenanceBackup('/unused/state', selectedId, true, checkedHost), (error) => {
    assert.match(
      error.message,
      /did not return a checked acknowledgement.*Check saved state before repeating/,
    );
    assert.equal(error.cause, failure);

    return true;
  });
  assert.equal(calls, 1);
});

test('source-only restore loads the canonical host export through the existing built-path hook', async (context) => {
  const directory = await temporaryDirectory(context);
  const file = await createFixtureDatabase(directory);
  const backup = await createMaintenanceBackup(directory);
  const changed = new DatabaseSync(file);

  try {
    changed.prepare('UPDATE kv SET value=? WHERE key=?').run('newer state', 'test');
  } finally {
    changed.close();
  }

  const receipt = await restoreMaintenanceBackup(directory, backup.id, true);
  assert.deepEqual(stateRestoreResultSchema.parse(receipt), receipt);
  assert.equal(receipt.restored, backup.id);
  assert.equal(typeof receipt.rollback, 'string');
  const restored = openNodeSqlite(file, true);

  try {
    assert.deepEqual(restored.prepare('SELECT value FROM kv WHERE key=?').get('test'), {
      value: 'private state',
    });
  } finally {
    restored.close();
  }
  await assert.rejects(access(path.join(directory, 'host.lock')), { code: 'ENOENT' });
});

test('stale-build CLI fails before restore, and help still works without a host build', async (context) => {
  const directory = await temporaryDirectory(context);
  const repositoryRoot = path.resolve(import.meta.dirname, '../..');
  const state = path.join(directory, 'state');
  await mkdir(state);
  await writeFile(path.join(state, 'canary'), 'saved state must remain unchanged');
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(path.join(repositoryRoot, 'node_modules'), path.join(directory, 'node_modules'), 'junction');

  for (const filename of ['maintenance.mjs', 'helpers/runtime.mjs']) {
    const target = path.join(directory, 'scripts', filename);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(repositoryRoot, 'scripts', filename), target);
  }
  await mkdir(path.join(directory, 'dist/apps/host/src/core'), { recursive: true });
  await writeFile(
    path.join(directory, 'dist/apps/host/src/runtime.js'),
    'export function defaultDataDir() { return process.env.MITTER_HOME; }',
  );
  await writeFile(
    path.join(directory, 'dist/apps/host/src/core/backups.js'),
    'import { writeFileSync } from "node:fs"; import path from "node:path";\n' +
      'export function restoreStateBackup(directory) {\n' +
      '  writeFileSync(path.join(directory, "restore-called"), "must not run");\n' +
      '  writeFileSync(path.join(directory, "canary"), "overwritten");\n' +
      '  return {};\n' +
      '}\n',
  );
  const options = {
    cwd: directory,
    env: { ...process.env, MITTER_HOME: state },
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
  };
  const stopped = spawnSync(
    process.execPath,
    ['scripts/maintenance.mjs', 'restore', selectedId, '--confirm'],
    options,
  );
  assert.equal(stopped.error, undefined);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /canonical state restore receipt schema is missing.*Restore was not started/);
  assert.doesNotMatch(stopped.stdout, /Re-enable\/reopen/);
  assert.equal(await readFile(path.join(state, 'canary'), 'utf8'), 'saved state must remain unchanged');
  await assert.rejects(access(path.join(state, 'restore-called')), { code: 'ENOENT' });

  await rm(path.join(directory, 'dist'), { recursive: true, force: true });
  const help = spawnSync(process.execPath, ['scripts/maintenance.mjs'], options);
  assert.equal(help.error, undefined);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Miter local state maintenance/);
  assert.equal(help.stderr, '');
});

test('failed backup releases its lease without creating a missing database', async (context) => {
  const directory = await temporaryDirectory(context);

  await assert.rejects(createMaintenanceBackup(directory), /unable to open database/);
  await assert.rejects(access(path.join(directory, 'mitter.sqlite')), {
    code: 'ENOENT',
  });
  await assert.rejects(access(path.join(directory, 'host.lock')), {
    code: 'ENOENT',
  });
  const release = await acquireHostLock(directory);

  await release();
});
