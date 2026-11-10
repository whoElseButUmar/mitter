import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  openNodeSqlite,
  databaseVersion,
  databaseCheckSchema,
  databaseTableSchema,
} from '../adapters/sqlite.js';
import type { SqlDatabase } from './types.js';
import { hasErrorCode } from './types.js';
import { stateBackupSchema, stateBackupIdSchema } from '../../../../packages/protocol/src/rpc.js';
import type { StateBackup } from '../../../../packages/protocol/src/rpc.js';
export { stateBackupSchema } from '../../../../packages/protocol/src/rpc.js';
export type { StateBackup } from '../../../../packages/protocol/src/rpc.js';
import { APP_VERSION } from '../../../../packages/protocol/src/index.js';
import { acquireHostLock } from './host-lock.js';

export const stateRestoreResultSchema = z
  .strictObject({
    restored: stateBackupIdSchema.describe('The exact validated state backup ID restored offline.'),
    rollback: stateBackupIdSchema
      .optional()
      .describe('The pre-restore rollback backup ID, when a database existed.'),
    projectFilesChanged: z.literal(false).describe('Offline state restoration never changes project files.'),
  })
  .describe(
    'An offline state restoration receipt with checked selected and optional rollback backup identities.',
  );

export type StateRestoreResult = z.infer<typeof stateRestoreResultSchema>;
const validId = (id: string) => stateBackupIdSchema.safeParse(id).success;
const checkpointSchema = z
  .object({
    busy: z.number().int().nonnegative().describe('The number of busy readers preventing a WAL checkpoint.'),
  })
  .describe('SQLite WAL checkpoint lock status.');

/** Check the main database and sidecars before SQLite opens any of them. */

export async function assertStateDatabasePaths(dataDir: string): Promise<void> {
  for (const name of ['mitter.sqlite', 'mitter.sqlite-journal', 'mitter.sqlite-wal', 'mitter.sqlite-shm']) {
    const stat = await fs.lstat(path.join(dataDir, name)).catch((error: unknown) => {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }

      return undefined;
    });

    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) {
      throw new Error('Unsafe database path: ' + name);
    }
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

async function directory(dataDir: string): Promise<string> {
  const directoryPath = path.join(dataDir, 'backups');
  await fs.mkdir(directoryPath, {
    recursive: true,
    mode: 0o700,
  });
  const stat = await fs.lstat(directoryPath);

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Unsafe backup directory.');
  }

  return directoryPath;
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, 'r');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createStateBackup(
  database: SqlDatabase,
  dataDir: string,
  reason = 'manual',
): Promise<StateBackup> {
  const backupReason = stateBackupSchema.shape.reason.parse(reason.slice(0, 120));
  const backupDirectory = await directory(dataDir);
  const id = 'state-' + new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID();
  const temporary = path.join(backupDirectory, id + '.partial');
  const destination = path.join(backupDirectory, id + '.sqlite');

  try {
    // VACUUM INTO snapshots WAL contents transactionally; copying the live file does not.
    database.prepare('VACUUM INTO ?').run(temporary);
    await fs.chmod(temporary, 0o600);
    await syncFile(temporary);
    const backup = stateBackupSchema.parse({
      format: 'miter-state-backup/1',
      id,
      createdAt: Date.now(),
      appVersion: APP_VERSION,
      schemaVersion: databaseVersion(database),
      reason: backupReason,
      bytes: (await fs.stat(temporary)).size,
      sha256: await hashFile(temporary),
    });
    await fs.rename(temporary, destination);
    const manifest = path.join(backupDirectory, id + '.json');
    const handle = await fs.open(manifest + '.partial', 'wx', 0o600);

    try {
      await handle.writeFile(JSON.stringify(backup, null, 2) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(manifest + '.partial', manifest);

    return backup;
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});

    throw error;
  }
}

async function readMetadata(backupDirectory: string, id: string): Promise<StateBackup> {
  if (!validId(id)) {
    throw new Error('Invalid backup ID. Select a listed state backup.');
  }

  const file = path.join(backupDirectory, id + '.json');
  const stat = await fs.lstat(file);

  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) {
    throw new Error('Invalid backup metadata file.');
  }

  const metadata = stateBackupSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));

  if (metadata.id !== id) {
    throw new Error('Invalid backup metadata.');
  }

  return metadata;
}

export async function listStateBackups(dataDir: string): Promise<StateBackup[]> {
  const backupDirectory = await directory(dataDir);
  const entries = await fs.readdir(backupDirectory);
  const results: StateBackup[] = [];
  const selected = entries
    .filter((name) => name.endsWith('.json') && validId(name.slice(0, -5)))
    .sort()
    .reverse()
    .slice(0, 100);

  for (const name of selected) {
    try {
      results.push(await readMetadata(backupDirectory, name.slice(0, -5)));
    } catch {
      /* Incomplete or damaged snapshots are not advertised as restorable. */
    }
  }

  return results;
}

export async function verifyStateBackup(dataDir: string, id: string): Promise<StateBackup> {
  if (!validId(id)) {
    throw new Error('Invalid backup ID. Select a listed state backup.');
  }

  const backupDirectory = await directory(dataDir);
  const metadata = await readMetadata(backupDirectory, id);
  const file = path.join(backupDirectory, id + '.sqlite');
  const stat = await fs.lstat(file);

  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== metadata.bytes) {
    throw new Error('State backup size or file type is invalid.');
  }

  if ((await hashFile(file)) !== metadata.sha256) {
    throw new Error('State backup checksum mismatch. Nothing was restored.');
  }

  const database = openNodeSqlite(file, true);

  try {
    const checks = databaseCheckSchema.parse(database.prepare('PRAGMA quick_check').all());

    if (checks.length !== 1 || checks[0]?.quick_check !== 'ok') {
      throw new Error('State backup integrity check failed.');
    }

    const version = databaseVersion(database);

    if (version !== 1 || metadata.schemaVersion !== version) {
      throw new Error('Unsupported backup database schema. Nothing was restored.');
    }

    for (const name of ['kv', 'workers', 'projects', 'envelopes', 'events', 'journal']) {
      const row = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

      if (row === undefined) {
        throw new Error('Not a complete Miter state database.');
      }

      const table = databaseTableSchema.safeParse(row);

      if (!table.success) {
        throw new Error('Not a complete Miter state database.', { cause: table.error });
      }

      if (table.data.name !== name) {
        throw new Error('Not a complete Miter state database.');
      }
    }
  } finally {
    database.close();
  }

  return metadata;
}

/** Offline maintenance only. Never restores project files or model permissions. */

export async function restoreStateBackup(
  dataDir: string,
  id: string,
  confirm: boolean,
): Promise<StateRestoreResult> {
  if (confirm !== true) {
    throw new Error('Restore needs --confirm. It replaces saved task state, not project files.');
  }

  if (!validId(id)) {
    throw new Error('Invalid backup ID. Select a listed state backup.');
  }

  const release = await acquireHostLock(dataDir);
  let database: SqlDatabase | undefined;
  const target = path.join(dataDir, 'mitter.sqlite');
  const staged = path.join(dataDir, 'state-restore-' + randomUUID() + '.partial');

  try {
    const selected = await verifyStateBackup(dataDir, id);
    await assertStateDatabasePaths(dataDir);
    const stat = await fs.lstat(target).catch((error: unknown) => {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }

      return undefined;
    });

    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) {
      throw new Error('Unsafe active database path.');
    }

    let rollback: StateBackup | undefined;

    if (stat) {
      database = openNodeSqlite(target);

      if (databaseVersion(database) > 1) {
        throw new Error('Current state uses a newer database schema. Nothing was restored.');
      }
      rollback = await createStateBackup(database, dataDir, 'before-restore');
      const checkpoint = checkpointSchema.parse(database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());

      if (checkpoint.busy !== 0) {
        throw new Error('The state database is still in use. Close all Miter views before restoring.');
      }
      database.close();
      database = undefined;
    }

    await fs.copyFile(path.join(dataDir, 'backups', id + '.sqlite'), staged);
    await fs.chmod(staged, 0o600);

    if ((await hashFile(staged)) !== selected.sha256) {
      throw new Error('Restore staging checksum mismatch.');
    }

    await syncFile(staged);

    // Checkpoint above drained WAL before this atomic database replacement.

    for (const suffix of ['-wal', '-shm']) {
      await fs.unlink(target + suffix).catch((error: unknown) => {
        if (!hasErrorCode(error, 'ENOENT')) {
          throw error;
        }
      });
    }

    await fs.rename(staged, target);

    return stateRestoreResultSchema.parse({
      restored: selected.id,
      rollback: rollback?.id,
      projectFilesChanged: false,
    });
  } finally {
    database?.close();
    await fs.unlink(staged).catch(() => {});
    await release();
  }
}
