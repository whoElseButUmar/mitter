import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** SQLite owns the inter-process lease. The OS releases it on process death.
 * host.lock remains as a compatibility marker for older Miter hosts; it is not
 * deleted merely because a timeout elapsed. No other process is ever killed. */
export async function acquireHostLock(dataDir: string): Promise<() => Promise<void>> {
  const leasePath = path.join(dataDir, 'host-lease.sqlite');
  const lockPath = path.join(dataDir, 'host.lock');
  for (const file of [leasePath, lockPath]) {
    const stat = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return undefined; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error('Unsafe host lock path. No files were changed.');
  }
  const lease = new DatabaseSync(leasePath);
  let owned = false;
  const token = randomUUID();
  try {
    await fs.chmod(leasePath, 0o600);
    try { lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
    catch { throw new Error('Another Miter host is running. Close its browser connection before maintenance or another CLI session.'); }
    // Only one new host can inspect/reclaim the legacy marker at a time.
    let marker: string | undefined;
    try { marker = await fs.readFile(lockPath, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (marker !== undefined) {
      let previous: { pid?: number };
      try { if (marker.length > 2048) throw Error(); previous = JSON.parse(marker); }
      catch { throw new Error('Unrecognized host.lock. It was preserved. Close Miter and inspect it before continuing.'); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid! <= 0) throw new Error('Unrecognized host.lock. It was preserved.');
      let alive = true;
      try { process.kill(previous.pid!, 0); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw e; }
      if (alive) throw new Error('Another Miter host is running. Close its browser connection before maintenance or another CLI session.');
      await fs.unlink(lockPath);
    }
    const handle = await fs.open(lockPath, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token, time: Date.now() })); await handle.sync(); }
    finally { await handle.close(); }
    owned = true;
    let released = false;
    return async () => {
      if (released) return; released = true;
      try {
        const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        if (current.token === token) await fs.unlink(lockPath);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write('Miter lock marker cleanup: '+String(e)+'\n'); }
      finally { lease.close(); }
    };
  } catch (error) {
    if (owned) await fs.unlink(lockPath).catch(() => {});
    lease.close(); throw error;
  }
}
