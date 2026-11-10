import { z } from 'zod';
import { VERSION } from '../constants.js';
import { workerStateSchema } from '../schemas/domain.js';
import { rpcCounterSchema, rpcTimestampSchema, sha256Schema } from './primitives.js';

export const stateBackupIdSchema = z
  .string()
  .regex(/^state-\d{8}T\d{9}Z-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, {
    error: 'Invalid backup ID. Select a listed state backup.',
  })
  .describe('A path-safe UTC timestamp and lowercase version-four UUID identifying a state backup.');

export const stateBackupSchema = z
  .strictObject({
    format: z.literal('miter-state-backup/1').describe('The exact private backup-manifest format.'),
    id: stateBackupIdSchema.describe('The timestamp and UUID identifying the manifest and SQLite snapshot.'),
    createdAt: rpcTimestampSchema.describe('Backup creation time in Unix milliseconds.'),
    appVersion: z
      .string()
      .min(1)
      .max(120)
      .describe('The installed application version that created the backup.'),
    schemaVersion: rpcCounterSchema.describe('The SQLite application schema version at backup time.'),
    reason: z
      .string()
      .min(1)
      .max(120)
      .describe('The bounded creation reason, such as manual or before-upgrade.'),
    bytes: rpcCounterSchema.positive().describe('The exact positive SQLite snapshot size in bytes.'),
    sha256: sha256Schema.describe('The SHA-256 of the complete SQLite snapshot bytes.'),
  })
  .describe('Complete private state backup metadata, including format, schema version, size and checksum.');

export const stateBackupsSchema = z
  .array(stateBackupSchema)
  .describe('Recent complete state backup manifests; damaged or incomplete backups are not advertised.');

export const healthSchema = z
  .strictObject({
    version: z.string().describe('The installed application version.'),
    protocol: z.literal(VERSION).describe('The exact host protocol version.'),
    node: z.string().describe('The current Node runtime version.'),
    platform: z.string().describe('The current Node operating-system platform.'),
    architecture: z.string().describe('The current Node process architecture.'),
    workflow: z.string().describe('The active workflow adapter name.'),
    database: z
      .strictObject({
        ok: z.boolean().describe('Whether SQLite returned exactly one successful quick-check row.'),
        schema: rpcCounterSchema.describe('The SQLite application schema version.'),
        bytes: rpcCounterSchema.describe('The main database file size in bytes, or zero if unavailable.'),
      })
      .describe('The checked local database health summary.'),
    tasks: z
      .strictObject({
        total: rpcCounterSchema.describe('The number of saved tasks.'),
        active: rpcCounterSchema.describe('The number of tasks with owned active execution.'),
        finished: rpcCounterSchema.describe('The number of tasks explicitly marked complete.'),
        stopped: rpcCounterSchema.describe('The number of tasks fenced by a stopped control record.'),
      })
      .describe('Read-only task lifecycle counts.'),
    attention: z
      .array(
        z
          .strictObject({
            id: z.string().describe('The task requiring user attention.'),
            name: z.string().describe('The current task display name.'),
            state: workerStateSchema.describe('The lifecycle state of this task.'),
            reason: z.string().optional().describe('The current error or approval reason, when present.'),
          })
          .describe('One task requiring user attention.'),
      )
      .describe('The bounded tasks with errors or pending approval.'),
    backups: stateBackupsSchema.describe('Recent complete backup metadata advertised locally.'),
    dataDirectory: z.string().describe('The pinned application state directory, not a project folder.'),
    limits: z
      .strictObject({
        savedProjects: rpcCounterSchema.describe('The maximum supported number of saved projects.'),
        savedTasks: rpcCounterSchema.describe('The maximum supported number of saved tasks.'),
        previewBytes: rpcCounterSchema.describe('The maximum ordinary-file preview size in bytes.'),
      })
      .describe('The configured preview and saved-record limits.'),
    notice: z.string().describe('The privacy and read-only inspection reminder.'),
  })
  .describe('The complete read-only host health report; it makes no model or network request.');

export const folderPickerResultSchema = z
  .discriminatedUnion('cancelled', [
    z
      .strictObject({
        cancelled: z.literal(true).describe('The user cancelled or selected no folder.'),
      })
      .describe('A cancelled folder picker with no selected path.'),
    z
      .strictObject({
        root: z.string().min(1).describe('The canonical host-checked absolute project folder selected.'),
        cancelled: z.literal(false).describe('The user selected a folder.'),
      })
      .describe('A selected and host-checked project folder.'),
  ])
  .describe('The project.pickFolder result; cancellation cannot fabricate a project root.');

export type StateBackup = z.infer<typeof stateBackupSchema>;
export type Health = z.infer<typeof healthSchema>;
export type FolderPickerResult = z.infer<typeof folderPickerResultSchema>;
