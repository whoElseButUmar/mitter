import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Store } from './core/database.js';
import { Service } from './core/service.js';
import { referenceWorkflow } from './core/workflow.js';
import { loadXStateWorkflow } from './adapters/xstate.js';
import { ModelProcess } from './adapters/models.js';
import { acquireHostLock } from './core/host-lock.js';
import { createStateBackup, assertStateDatabasePaths } from './core/backups.js';
import {
  RESET_MARKER,
  validateResetRoot,
  markResetPending,
  resetPending,
  removeApplicationState,
  type ResetResult,
} from './core/reset.js';
import { resolveStateRoot, assertStateRoot } from './core/state-root.js';
import { APP_VERSION } from '../../../packages/protocol/src/index.js';
import type { SqlDatabase } from './core/types.js';
import {
  databaseVersion,
  databaseValueSchema,
  databaseTableSchema,
  openNodeSqlite,
  openBetterSqlite,
} from './adapters/sqlite.js';

export const defaultDataDir = () =>
  path.resolve(process.env.MITTER_HOME || path.join(os.homedir(), '.mitter'));

export const runtimeOptionsSchema = z
  .object({
    portable: z
      .boolean()
      .optional()
      .describe('Whether to use Node SQLite and the portable reference workflow.'),
    dataDir: z
      .string()
      .optional()
      .describe('The requested application state directory, resolved and pinned before use.'),
    lock: z
      .boolean()
      .optional()
      .describe('Only explicit false skips the inter-process lease for isolated tests.'),
  })
  .strict()
  .describe(
    'Explicit local host startup options; filesystem identity and lease ' + 'checks remain mandatory.',
  );

export type RuntimeOptions = z.infer<typeof runtimeOptionsSchema>;

export async function openRuntime(options: RuntimeOptions = {}) {
  options = runtimeOptionsSchema.parse(options);
  const requestedDir = path.resolve(options.dataDir ?? defaultDataDir());
  await fs.mkdir(requestedDir, {
    recursive: true,
    mode: 0o700,
  });
  const stateRoot = await resolveStateRoot(requestedDir);
  const dataDir = stateRoot.path;
  let release = async () => {};

  if (options.lock !== false) {
    release = await acquireHostLock(dataDir);
  }

  let current: Service | undefined;
  let closed = false;
  let resetting = false;
  let needsReset = false;
  let cleanupComplete = false;
  let resetDone: Promise<void> = Promise.resolve();
  let closeJob: Promise<void> | undefined;
  let protectedProjects: string[] = [];
  async function exclusiveReset<T>(confirmation: unknown, operation: () => Promise<T>): Promise<T> {
    if (confirmation !== 'CLEAR') {
      throw Error('Type exactly CLEAR to delete all Miter application data.');
    }

    if (closed || resetting) {
      throw Error('The host is closing or a reset is already running.');
    }
    resetting = true;
    let done: (() => void) | undefined;
    resetDone = new Promise<void>((resolve) => {
      done = resolve;
    });
    const complete = done;

    if (!complete) {
      resetting = false;

      throw new Error('Reset barrier was not initialized.');
    }

    try {
      return await operation();
    } finally {
      resetting = false;
      complete();
    }
  }
  async function stopForReset(stopExternal: () => Promise<void>, drain: () => Promise<void>): Promise<void> {
    cleanupComplete = false;
    await assertStateRoot(stateRoot);

    if (current?.projects.size) {
      protectedProjects = [...current.projects.values()].map((project) => project.root);
    }

    await validateResetRoot(dataDir, protectedProjects);
    await markResetPending(dataDir);
    needsReset = true;
    // Prepare is durable and non-deleting. Even if a browser view refuses the
    // barrier, native writers stop and restart remains explicitly locked.
    await current?.quiesce();
    await stopExternal();
    await drain();
    // An already-running project registration can finish while the normal RPC
    // lane drains. Include it before the final overlap check, not only the
    // snapshot taken when preparation began.

    if (current) {
      protectedProjects = [
        ...new Set([...protectedProjects, ...[...current.projects.values()].map((project) => project.root)]),
      ];
    }

    await current?.close();
    await assertStateRoot(stateRoot);
    await validateResetRoot(dataDir, protectedProjects);
  }
  async function createService(allowBackup = true): Promise<Service> {
    let database: SqlDatabase | undefined;

    try {
      await assertStateRoot(stateRoot);
      await assertStateDatabasePaths(dataDir);
      const databaseFile = path.join(dataDir, 'mitter.sqlite');

      if (options.portable) {
        database = openNodeSqlite(databaseFile);
      } else {
        database = await openBetterSqlite(databaseFile);
      }

      const schema = databaseVersion(database);

      if (schema > 1) {
        throw new Error('This database was created by a newer Miter schema. It was not modified.');
      }

      const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").get();
      let hasState = false;

      if (table !== undefined) {
        const record = databaseTableSchema.parse(table);

        if (record.name !== 'kv') {
          throw new Error('The saved database table identity is invalid. State was not modified.');
        }

        hasState = true;
      }

      if (hasState && allowBackup) {
        const versionRow = database.prepare("SELECT value FROM kv WHERE key='miter.installedVersion'").get();
        let prior: string | undefined;

        if (versionRow !== undefined) {
          prior = databaseValueSchema.parse(versionRow).value;
        }

        if (prior !== JSON.stringify(APP_VERSION)) {
          await createStateBackup(database, dataDir, 'before-upgrade');
        }
      }

      const store = new Store(database);
      let workflow = referenceWorkflow;
      let workflowName = 'portable reference graph (not XState)';

      if (!options.portable) {
        workflow = await loadXStateWorkflow();
        workflowName = 'XState v5';
      }

      let service: Service | undefined;
      const models = new ModelProcess(() => {
        if (!service) {
          throw new Error('The local model service is not initialized.');
        }

        return service.settings;
      });
      service = new Service(store, dataDir, workflow, models, workflowName);
      store.set('miter.installedVersion', APP_VERSION);
      await fs.chmod(path.join(dataDir, 'mitter.sqlite'), 0o600);

      return service;
    } catch (error) {
      database?.close();

      throw error;
    }
  }

  try {
    needsReset = await resetPending(dataDir);
    // A crash or a partial deletion must never reopen the old DB, recreate a
    // backup, revive a worker or write recovery records before explicit retry.

    if (!needsReset) {
      current = await createService();
    }

    return {
      dataDir,
      get service() {
        if (!current) {
          throw Error('Data reset is incomplete. Retry Clear all Miter data.');
        }

        return current;
      },
      get resetRequired() {
        return needsReset;
      },
      prepareReset(
        confirmation: unknown,
        stopExternal: () => Promise<void> = async () => {},
        drain: () => Promise<void> = async () => {},
      ) {
        return exclusiveReset(confirmation, async () => {
          await stopForReset(stopExternal, drain);

          return {
            prepared: true,
          };
        });
      },
      reset(
        confirmation: unknown,
        stopExternal: () => Promise<void> = async () => {},
        drain: () => Promise<void> = async () => {},
      ): Promise<ResetResult> {
        return exclusiveReset(confirmation, async () => {
          await stopForReset(stopExternal, drain);
          current = undefined;

          if (closed) {
            throw Error(
              'The host closed during reset preparation. State was not deleted; retry ' +
                'after reconnecting.',
            );
          }

          const result = await removeApplicationState(dataDir, stateRoot, protectedProjects);

          if (!result.cleared) {
            return result;
          }

          if (closed) {
            throw Error('The host closed during cleanup. Reset remains locked; reconnect and retry.');
          }
          current = await createService(false);
          cleanupComplete = true;

          return result; // locked until browser cleanup is also verified
        });
      },
      completeReset(confirmation: unknown) {
        return exclusiveReset(confirmation, async () => {
          if (!needsReset || !cleanupComplete || !current) {
            throw Error('A complete, confirmed state reset is required before restarting.');
          }

          if (current.projects.size || current.workers.size) {
            throw Error('Fresh state verification failed. Reset remains locked.');
          }

          await assertStateRoot(stateRoot);
          await validateResetRoot(dataDir, protectedProjects);
          await fs.unlink(path.join(dataDir, RESET_MARKER));
          needsReset = false;
          cleanupComplete = false;
          protectedProjects = [];

          return {
            cleared: true,
          };
        });
      },
      close(): Promise<void> {
        if (closeJob) {
          return closeJob;
        }
        closed = true;
        // Do not release the host lease or close a DB while reset can still
        // delete/recreate it. Concurrent callers share one shutdown result.
        closeJob = (async () => {
          await resetDone;

          try {
            await current?.close();
          } finally {
            await release();
          }
        })();

        return closeJob;
      },
    };
  } catch (error) {
    try {
      await current?.close();
    } finally {
      await release();
    }

    throw error;
  }
}
