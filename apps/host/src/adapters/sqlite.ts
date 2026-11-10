import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { isRecord } from '../core/types.js';
import type { SqlDatabase, SqlStatement, SqlValue } from '../core/types.js';
const sqlValueSchema = z
  .union([z.string(), z.number().finite(), z.bigint(), z.null(), z.instanceof(Uint8Array)])
  .describe('A SQLite bind parameter or returned column value.');
const sqlRowSchema = z.record(z.string(), sqlValueSchema).describe('A native SQLite result row.');
const sqlRunSchema = z
  .object({
    changes: z
      .union([z.number().int().nonnegative(), z.bigint().nonnegative()])
      .describe('The number of rows changed by the native SQLite mutation.'),
    lastInsertRowid: z
      .union([z.number().int(), z.bigint()])
      .describe('The last inserted SQLite row identifier as returned by the driver.'),
  })
  .describe('Checked native SQLite mutation counts.');

export const databaseVersionSchema = z
  .object({
    user_version: z
      .number()
      .int()
      .nonnegative()
      .describe('The nonnegative SQLite application schema version.'),
  })
  .describe('The SQLite application schema version.');

export const databaseValueSchema = z
  .object({
    value: z.string().describe('The literal JSON text returned from an application value column.'),
  })
  .describe('A JSON text column from application storage.');

export const databaseCheckSchema = z
  .array(
    z.object({
      quick_check: z
        .string()
        .describe('The literal SQLite quick-check diagnostic; only one ok row means success.'),
    }),
  )
  .describe('SQLite integrity-check result rows.');

export const databaseTableSchema = z
  .object({
    name: z.string().describe('The table name returned by a sqlite_master identity query.'),
  })
  .describe('A checked SQLite table identity, not merely a truthy driver result.');

/** Preserve the native receiver while validating every returned row. */

export function adaptSqliteDatabase(resource: unknown): SqlDatabase {
  if (!isRecord(resource)) {
    throw new Error('SQLite did not return a database resource.');
  }

  const nativeExec = resource.exec;
  const nativePrepare = resource.prepare;
  const nativeClose = resource.close;

  if (
    typeof nativeExec !== 'function' ||
    typeof nativePrepare !== 'function' ||
    typeof nativeClose !== 'function'
  ) {
    throw new Error('SQLite database methods are missing.');
  }

  return {
    exec(sql) {
      Reflect.apply(nativeExec, resource, [sql]);
    },
    prepare(sql): SqlStatement {
      const statement: unknown = Reflect.apply(nativePrepare, resource, [sql]);

      if (!isRecord(statement)) {
        throw new Error('SQLite did not return a statement resource.');
      }

      const nativeRun = statement.run;
      const nativeGet = statement.get;
      const nativeAll = statement.all;

      if (
        typeof nativeRun !== 'function' ||
        typeof nativeGet !== 'function' ||
        typeof nativeAll !== 'function'
      ) {
        throw new Error('SQLite statement methods are missing.');
      }
      function parameters(values: SqlValue[]): SqlValue[] {
        return z.array(sqlValueSchema).parse(values);
      }

      return {
        run(...values) {
          const result: unknown = Reflect.apply(nativeRun, statement, parameters(values));

          return sqlRunSchema.parse(result);
        },
        get(...values) {
          const row: unknown = Reflect.apply(nativeGet, statement, parameters(values));

          if (row === undefined) {
            return undefined;
          }

          return sqlRowSchema.parse(row);
        },
        all(...values) {
          const rows: unknown = Reflect.apply(nativeAll, statement, parameters(values));

          return z.array(sqlRowSchema).parse(rows);
        },
      };
    },
    close() {
      Reflect.apply(nativeClose, resource, []);
    },
  };
}

export function openNodeSqlite(file: string, readOnly = false): SqlDatabase {
  return adaptSqliteDatabase(
    new DatabaseSync(file, {
      readOnly,
    }),
  );
}

export async function openBetterSqlite(file: string): Promise<SqlDatabase> {
  const moduleName = 'better-sqlite3';
  const loaded: unknown = await import(moduleName);

  if (!isRecord(loaded) || typeof loaded.default !== 'function') {
    throw new Error('better-sqlite3 does not export a database constructor.');
  }

  const resource: unknown = Reflect.construct(loaded.default, [file]);

  try {
    return adaptSqliteDatabase(resource);
  } catch (error) {
    if (isRecord(resource) && typeof resource.close === 'function') {
      Reflect.apply(resource.close, resource, []);
    }

    throw error;
  }
}

export function databaseVersion(database: SqlDatabase): number {
  return databaseVersionSchema.parse(database.prepare('PRAGMA user_version').get()).user_version;
}
