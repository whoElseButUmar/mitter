import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { hasErrorCode, errorMessage } from './types.js';
const legacyMarkerSchema = z
  .object({
    pid: z.number().int().positive().describe('The positive host process ID checked for OS liveness.'),
  })
  .describe('A legacy host marker used only to verify process liveness under the ' + 'SQLite lease.');
const hostMarkerSchema = z
  .object({
    version: z.literal(1).describe('The host compatibility-marker format version.'),
    pid: legacyMarkerSchema.shape.pid,
    token: z.string().uuid().describe('The unique host lease token, required before marker removal.'),
    time: z
      .number()
      .finite()
      .describe('The marker creation time in Unix milliseconds; it is not a lease timeout.'),
  })
  .describe('A host-owned compatibility marker correlated to one inter-process lease.');

/** SQLite owns the inter-process lease. The OS releases it on process death.
 * The compatibility marker is never reclaimed solely because a timeout elapsed. */

export async function acquireHostLock(dataDir: string): Promise<() => Promise<void>> {
  const leasePath = path.join(dataDir, 'host-lease.sqlite');
  const lockPath = path.join(dataDir, 'host.lock');

  for (const file of [leasePath, leasePath + '-journal', leasePath + '-wal', leasePath + '-shm', lockPath]) {
    const stat = await fs.lstat(file).catch((error: unknown) => {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }

      return undefined;
    });

    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) {
      throw new Error('Unsafe host lock path. No files were changed.');
    }
  }

  const lease = new DatabaseSync(leasePath);
  let owned = false;
  const token = randomUUID();

  try {
    await fs.chmod(leasePath, 0o600);

    try {
      lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    } catch {
      throw new Error(
        'Another Miter host is running. Close its browser connection before ' +
          'maintenance or another CLI session.',
      );
    }

    let marker: string | undefined;

    try {
      marker = await fs.readFile(lockPath, 'utf8');
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }

    if (marker !== undefined) {
      let previous: z.infer<typeof legacyMarkerSchema>;

      try {
        if (marker.length > 2048) {
          throw new Error('Host marker exceeds its size bound.');
        }
        previous = legacyMarkerSchema.parse(JSON.parse(marker));
      } catch {
        throw new Error(
          'Unrecognized host.lock. It was preserved. Close Miter and inspect it ' + 'before continuing.',
        );
      }

      let alive = true;

      try {
        process.kill(previous.pid, 0);
      } catch (error) {
        if (hasErrorCode(error, 'ESRCH')) {
          alive = false;
        } else {
          throw error;
        }
      }

      if (alive) {
        throw new Error(
          'Another Miter host is running. Close its browser connection before ' +
            'maintenance or another CLI session.',
        );
      }

      await fs.unlink(lockPath);
    }

    const handle = await fs.open(lockPath, 'wx', 0o600);

    try {
      const marker = hostMarkerSchema.parse({
        version: 1,
        pid: process.pid,
        token,
        time: Date.now(),
      });
      await handle.writeFile(JSON.stringify(marker));
      await handle.sync();
    } finally {
      await handle.close();
    }
    owned = true;
    let released = false;

    return async () => {
      if (released) {
        return;
      }
      released = true;

      try {
        const current = hostMarkerSchema.parse(JSON.parse(await fs.readFile(lockPath, 'utf8')));

        if (current.token === token) {
          await fs.unlink(lockPath);
        }
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          process.stderr.write('Miter lock marker cleanup: ' + errorMessage(error) + '\n');
        }
      } finally {
        lease.close();
      }
    };
  } catch (error) {
    if (owned) {
      await fs.unlink(lockPath).catch(() => {});
    }
    lease.close();

    throw error;
  }
}
