import { z } from 'zod';
import {
  envelopeSchema,
  type Activity,
  type Project,
  type Worker,
} from '../../../../packages/protocol/src/index.js';
import { databaseValueSchema, databaseVersion } from '../adapters/sqlite.js';
import {
  activitySchema,
  changedFileSchema,
  firstFileChangeSchema,
  fileChangeSchema,
  journalSchema,
  lastFileChangeSchema,
  projectSchema,
  workerSchema,
} from './storage-schemas.js';
import { errorMessage, type SqlDatabase } from './types.js';

export type Journal = z.infer<typeof journalSchema>;

export type ChangedFile = z.infer<typeof changedFileSchema>;

export type FileChange = z.infer<typeof fileChangeSchema>;
const envelopeIdentitySchema = z
  .object({
    id: envelopeSchema.shape.id.describe('The exact batch identifier found in the imported-envelope table.'),
  })
  .describe('The identity returned when checking whether a batch has already been imported.');
const envelopeOwnerSchema = z
  .object({
    worker_id: z.string().describe('The task that imported this envelope.'),
  })
  .describe('An imported envelope owner.');
const envelopeCountSchema = z
  .object({
    n: z.number().int().nonnegative().describe('The count of imported envelopes for one task.'),
  })
  .describe('The number of imported envelopes for a worker.');

/** JSON storage returns unknown unless the caller supplies an actual schema. */

export function parseStoredJSON(row: unknown): unknown {
  const serialized = databaseValueSchema.parse(row).value;
  const parsed: unknown = JSON.parse(serialized);

  return parsed;
}

export class Store {
  constructor(readonly db: SqlDatabase) {
    const version = databaseVersion(db);

    if (version > 1) {
      throw new Error(
        'This database was created by a newer Miter schema. It was not ' + 'downgraded or modified.',
      );
    }
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS envelopes (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id TEXT NOT NULL, time INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, run_id TEXT NOT NULL, path TEXT NOT NULL, before_text TEXT, after_text TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL, status TEXT NOT NULL, time INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_worker ON events(worker_id,id);
      CREATE INDEX IF NOT EXISTS journal_run ON journal(run_id,time);
      CREATE INDEX IF NOT EXISTS journal_file ON journal(run_id,path);
      PRAGMA user_version=1;`);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      const result = operation();
      this.db.exec('COMMIT');

      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Database transaction failed: ' +
            errorMessage(error) +
            '. Rollback also failed: ' +
            errorMessage(rollbackError) +
            '. Check saved state before repeating a mutation.',
        );
      }

      throw error;
    }
  }

  get(key: string): unknown;
  get<T>(key: string, schema: z.ZodType<T>): T | undefined;

  get(key: string, schema?: z.ZodType): unknown {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);

    if (row === undefined) {
      return undefined;
    }

    const value = parseStoredJSON(row);

    if (schema) {
      return schema.parse(value);
    }

    return value;
  }

  set(key: string, value: unknown): void {
    const serialized = JSON.stringify(value);

    if (serialized === undefined) {
      throw new Error('Stored values must be JSON serializable.');
    }
    this.db
      .prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET ' + 'value=excluded.value')
      .run(key, serialized);
  }

  projects(): Project[] {
    return this.db
      .prepare('SELECT value FROM projects ORDER BY rowid')
      .all()
      .map((row) => projectSchema.parse(parseStoredJSON(row)));
  }

  workers(): Worker[] {
    return this.db
      .prepare('SELECT value FROM workers ORDER BY rowid')
      .all()
      .map((row) => workerSchema.parse(parseStoredJSON(row)));
  }

  saveProject(project: Project): void {
    let saved = project;

    if (project.sourceRoot) {
      saved = {
        ...project,
        root: project.sourceRoot,
        sourceRoot: undefined,
      };
    }

    const record = projectSchema.parse(saved);
    this.db
      .prepare('INSERT INTO projects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET ' + 'value=excluded.value')
      .run(record.id, JSON.stringify(record));
  }

  saveWorker(worker: Worker): void {
    const record = workerSchema.parse(worker);
    this.db
      .prepare('INSERT INTO workers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET ' + 'value=excluded.value')
      .run(record.id, JSON.stringify(record));
  }

  rememberEnvelope(id: string, workerId: string): void {
    this.db.prepare('INSERT INTO envelopes VALUES (?,?)').run(id, workerId);
  }

  hasEnvelope(id: string): boolean {
    const row = this.db.prepare('SELECT id FROM envelopes WHERE id=?').get(id);

    if (row === undefined) {
      return false;
    }

    const record = envelopeIdentitySchema.parse(row);

    if (record.id !== id) {
      throw new Error('Saved envelope identity does not match this batch. No actions were repeated.');
    }

    return true;
  }

  envelopeOwner(id: string): string | undefined {
    const row = this.db.prepare('SELECT worker_id FROM envelopes WHERE id=?').get(id);

    if (row === undefined) {
      return undefined;
    }

    return envelopeOwnerSchema.parse(row).worker_id;
  }

  envelopeCount(workerId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM envelopes WHERE worker_id=?').get(workerId);

    return envelopeCountSchema.parse(row).n;
  }

  event(workerId: string, kind: string, message: string): void {
    this.db
      .prepare('INSERT INTO events(worker_id,time,kind,message) VALUES(?,?,?,?)')
      .run(workerId, Date.now(), kind, message.slice(0, 8000));
    // Bounded diagnostics, not an unbounded copy of project output.
    this.db.prepare('DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-5000 FROM events)').run();
  }

  events(): Activity[] {
    const rows = this.db
      .prepare('SELECT id,worker_id AS workerId,time,kind,message FROM events ORDER BY ' + 'id DESC LIMIT 80')
      .all();

    return z.array(activitySchema).parse(rows);
  }

  taskEvents(workerId: string, before = Number.MAX_SAFE_INTEGER): Activity[] {
    const rows = this.db
      .prepare(
        'SELECT id,worker_id AS workerId,time,kind,message FROM events WHERE ' +
          'worker_id=? AND id<? ORDER BY id DESC LIMIT 101',
      )
      .all(workerId, before);

    return z.array(activitySchema).parse(rows);
  }

  prepareWrite(journal: Journal): void {
    const record = journalSchema.parse(journal);
    this.db
      .prepare('INSERT INTO journal VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        record.id,
        record.workerId,
        record.runId,
        record.path,
        record.before,
        record.after,
        record.beforeHash,
        record.afterHash,
        record.status,
        record.time,
      );
  }

  journal(id: string): Journal | undefined {
    const row = this.db
      .prepare(
        'SELECT id,worker_id AS workerId,run_id AS runId,path,before_text AS ' +
          'before,after_text AS after,before_hash AS beforeHash,after_hash AS ' +
          'afterHash,status,time FROM journal WHERE id=?',
      )
      .get(id);

    if (row === undefined) {
      return undefined;
    }

    return journalSchema.parse(row);
  }

  writes(runId: string): Journal[] {
    const rows = this.db
      .prepare(
        'SELECT id,worker_id AS workerId,run_id AS runId,path,before_text AS ' +
          'before,after_text AS after,before_hash AS beforeHash,after_hash AS ' +
          'afterHash,status,time FROM journal WHERE run_id=? ORDER BY rowid DESC',
      )
      .all(runId);

    return z.array(journalSchema).parse(rows);
  }

  changedFiles(runId: string): ChangedFile[] {
    const rows = this.db
      .prepare(
        'SELECT path,status,LENGTH(CAST(after_text AS BLOB)) AS bytes FROM ' +
          'journal WHERE run_id=? ORDER BY rowid DESC',
      )
      .all(runId);

    return z.array(changedFileSchema).parse(rows);
  }

  fileChange(runId: string, relative: string): FileChange | undefined {
    const first = this.db
      .prepare(
        'SELECT before_text AS before,before_hash AS beforeHash FROM journal ' +
          "WHERE run_id=? AND path=? AND status IN ('applied','prepared') ORDER " +
          'BY rowid LIMIT 1',
      )
      .get(runId, relative);

    if (first === undefined) {
      return undefined;
    }

    const last = this.db
      .prepare(
        'SELECT after_text AS after,after_hash AS afterHash,status FROM journal ' +
          "WHERE run_id=? AND path=? AND status IN ('applied','prepared') ORDER " +
          'BY rowid DESC LIMIT 1',
      )
      .get(runId, relative);

    return {
      ...firstFileChangeSchema.parse(first),
      ...lastFileChangeSchema.parse(last),
    };
  }

  markWrite(id: string, status: string): void {
    this.db.prepare('UPDATE journal SET status=? WHERE id=?').run(status, id);
  }

  close(): void {
    this.db.close();
  }
}
export { DEFAULT_SETTINGS } from '../../../../packages/protocol/src/model-settings.js';
