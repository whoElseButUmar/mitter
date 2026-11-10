import { databaseVersion, databaseCheckSchema } from '../adapters/sqlite.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { APP_VERSION, VERSION, type Worker } from '../../../../packages/protocol/src/index.js';
import type { Store } from './database.js';
import { listStateBackups } from './backups.js';
import type { Health } from '../../../../packages/protocol/src/rpc.js';
export { healthSchema } from '../../../../packages/protocol/src/rpc.js';
export type { Health } from '../../../../packages/protocol/src/rpc.js';
import { MAX_PREVIEW_BYTES } from './assets.js';

export async function inspectHealth(
  store: Store,
  dataDir: string,
  workers: Worker[],
  active: number,
  workflow: string,
): Promise<Health> {
  const checks = databaseCheckSchema.parse(store.db.prepare('PRAGMA quick_check').all());
  const databaseOK = checks.length === 1 && checks[0]?.quick_check === 'ok';
  const stat = await fs.stat(path.join(dataDir, 'mitter.sqlite')).catch(() => undefined);
  const backups = await listStateBackups(dataDir);

  return {
    version: APP_VERSION,
    protocol: VERSION,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    workflow,
    database: {
      ok: databaseOK,
      schema: databaseVersion(store.db),
      bytes: stat?.size ?? 0,
    },
    tasks: {
      total: workers.length,
      active,
      finished: workers.filter((worker) => worker.state === 'complete').length,
      stopped: workers.filter((worker) => worker.control?.mode === 'stopped').length,
    },
    attention: workers
      .filter((worker) => worker.error || worker.pending)
      .slice(0, 20)
      .map((worker) => {
        let reason = worker.error;

        if (worker.pending) {
          reason = 'Command approval needed';
        }

        return {
          id: worker.id,
          name: worker.name,
          state: worker.state,
          reason,
        };
      }),
    backups: backups.slice(0, 10),
    dataDirectory: dataDir,
    limits: {
      savedProjects: 50,
      savedTasks: 200,
      previewBytes: MAX_PREVIEW_BYTES,
    },
    notice:
      'State backups contain task history and journaled source. They are ' +
      'private and are not backups of your project directories. No network ' +
      'request or model invocation was made.',
  };
}
