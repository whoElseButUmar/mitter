/** Local-only state backup/restore. No network or project file writes. */
import path from 'node:path';
import { z } from 'zod';
import { errorMessage, isMainModule, parseContract } from './helpers/runtime.mjs';

// Validate CLI path syntax before loading a possibly absent host build; result IDs use the host schema.
const backupIdSchema = z
  .string()
  .regex(/^state-\d{8}T\d{9}Z-[a-f0-9-]{36}$/)
  .describe('A state backup filename ID, not a path or CLI option.');

const maintenanceArgumentsSchema = z
  .union([
    z.tuple([]).describe('No command displays maintenance help.'),
    z.tuple([
      z.enum(['help', 'list', 'backup']).describe('A maintenance command that does not accept a backup ID.'),
    ]),
    z.tuple([z.literal('verify').describe('Verify a backup without restoring it.'), backupIdSchema]),
    z.tuple([
      z.literal('restore').describe('Restore saved state only, not project files.'),
      backupIdSchema,
      z.literal('--confirm').optional().describe('Explicit consent to replacing saved state.'),
    ]),
  ])
  .describe('Exact local maintenance argv validated before loading host state APIs.');

export function requireStateRestoreSchema(host) {
  let schema;

  if (host !== null && typeof host === 'object') {
    schema = host.stateRestoreResultSchema;
  }

  if (!(schema instanceof z.ZodObject) || !(schema.shape.restored instanceof z.ZodType)) {
    throw new Error(
      'The built canonical state restore receipt schema is missing. ' +
        'Run pnpm build:host before restoring saved state. Restore was not started.',
    );
  }

  return schema;
}

export async function restoreMaintenanceBackup(dataDirectory, id, confirmed, host) {
  if (confirmed !== true) {
    throw new Error(
      'Restore needs --confirm. It replaces saved task state, not project files. Restore was not started.',
    );
  }

  if (host === undefined) {
    host = await import('../dist/apps/host/src/core/backups.js');
  }

  const schema = requireStateRestoreSchema(host);
  const selectedId = parseContract(
    schema.shape.restored,
    id,
    'Invalid backup ID. Select a listed state backup. Restore was not started.',
  );

  if (typeof host.restoreStateBackup !== 'function') {
    throw new Error('The built state restore API is missing. Run pnpm build:host. Restore was not started.');
  }

  let restored;

  try {
    restored = await host.restoreStateBackup(dataDirectory, selectedId, confirmed);
  } catch (error) {
    throw new Error(
      'State restore did not return a checked acknowledgement. Check saved state before repeating the restore.',
      { cause: error },
    );
  }

  const receipt = parseContract(
    schema,
    restored,
    'The host returned an invalid restore acknowledgement. Check saved state before repeating the restore.',
  );

  if (receipt.restored !== selectedId) {
    throw new Error(
      'The restore acknowledgement does not match the selected backup. Check saved state before repeating the restore.',
    );
  }

  return receipt;
}

export async function createMaintenanceBackup(dataDirectory) {
  const { acquireHostLock } = await import('../dist/apps/host/src/core/host-lock.js');
  const { assertStateDatabasePaths, createStateBackup, stateBackupSchema } =
    await import('../dist/apps/host/src/core/backups.js');
  const { openNodeSqlite } = await import('../dist/apps/host/src/adapters/sqlite.js');
  const release = await acquireHostLock(dataDirectory);
  let database;

  try {
    await assertStateDatabasePaths(dataDirectory);
    const databaseFile = path.join(dataDirectory, 'mitter.sqlite');

    // The host API expects schema-checked row reads, not a raw DatabaseSync resource.
    database = openNodeSqlite(databaseFile, true);
    const backup = await createStateBackup(database, dataDirectory, 'maintenance');

    return parseContract(
      stateBackupSchema,
      backup,
      'The host returned invalid backup metadata. Run pnpm build:host before retrying maintenance.',
    );
  } finally {
    try {
      if (database) {
        database.close();
      }
    } finally {
      await release();
    }
  }
}

export function parseMaintenanceArguments(args) {
  const parsed = maintenanceArgumentsSchema.safeParse(args);

  if (!parsed.success) {
    throw new Error(
      'Usage: node scripts/maintenance.mjs [help | list | backup | verify BACKUP_ID | restore BACKUP_ID --confirm]',
      { cause: parsed.error },
    );
  }

  const [command = 'help', id, confirmation] = parsed.data;

  return { command, id, confirmed: confirmation === '--confirm' };
}

function printHelp() {
  console.log(
    'Miter local state maintenance\n\n' +
      '  node scripts/maintenance.mjs list\n' +
      '  node scripts/maintenance.mjs backup\n' +
      '  node scripts/maintenance.mjs verify BACKUP_ID\n' +
      '  node scripts/maintenance.mjs restore BACKUP_ID --confirm\n\n' +
      'Close/disable Miter before backup or restore via the CLI. ' +
      'Live backup is available from Connection & health.\n' +
      'State backups include source in journals, not the project directories themselves. Keep them private.',
  );
}

async function maintainState() {
  try {
    const { command, id, confirmed } = parseMaintenanceArguments(process.argv.slice(2));
    if (command === 'help') {
      printHelp();

      return;
    }

    const { defaultDataDir } = await import('../dist/apps/host/src/runtime.js');
    const dataDirectory = defaultDataDir();
    const host = await import('../dist/apps/host/src/core/backups.js');
    const { listStateBackups, verifyStateBackup, stateBackupSchema } = host;

    if (command === 'list') {
      const { stateBackupsSchema } = await import('../dist/packages/protocol/src/rpc.js');

      if (!(stateBackupsSchema instanceof z.ZodArray)) {
        throw new Error('The built canonical state backup list schema is missing. Run pnpm build:host.');
      }

      const backups = await listStateBackups(dataDirectory);
      const result = parseContract(
        stateBackupsSchema,
        backups,
        'The host returned an invalid backup list. Rebuild the host and verify the saved backup metadata.',
      );

      console.log(JSON.stringify(result, null, 2));
    } else if (command === 'verify') {
      const backup = await verifyStateBackup(dataDirectory, id);
      const result = parseContract(
        stateBackupSchema,
        backup,
        'The host returned invalid verified backup metadata. Rebuild the host before retrying.',
      );

      console.log(JSON.stringify(result, null, 2));
    } else if (command === 'restore') {
      console.log('Restoring saved task state only. Project files will not be changed.');
      const result = await restoreMaintenanceBackup(dataDirectory, id, confirmed, host);

      console.log(JSON.stringify(result, null, 2));
      console.log('Re-enable/reopen Miter. Review current files before resuming older plans.');
    } else if (command === 'backup') {
      const result = await createMaintenanceBackup(dataDirectory);

      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  await maintainState();
}
