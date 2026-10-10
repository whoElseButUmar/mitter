import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase } from './types.js';
import { APP_VERSION } from '../../../../packages/protocol/src/index.js';
import { acquireHostLock } from './host-lock.js';

export interface StateBackup {
  format: 'miter-state-backup/1'; id: string; createdAt: number;
  appVersion: string; schemaVersion: number; reason: string; bytes: number; sha256: string;
}
const validId = (id: string) => /^state-\d{8}T\d{9}Z-[a-f0-9-]{36}$/.test(id);
/** Check the main database and sidecars before SQLite opens any of them.
 * Maintenance uses the same boundary as the native runtime. */
export async function assertStateDatabasePaths(dataDir: string): Promise<void> {
  for (const name of ['mitter.sqlite', 'mitter.sqlite-wal', 'mitter.sqlite-shm']) {
    const st = await fs.lstat(path.join(dataDir, name)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return undefined;
    });
    if (st && (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)) throw new Error('Unsafe database path: ' + name);
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function directory(dataDir: string) {
  const dir = path.join(dataDir, 'backups');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Unsafe backup directory.');
  return dir;
}
export async function createStateBackup(db: SqlDatabase, dataDir: string, reason = 'manual'): Promise<StateBackup> {
  const dir = await directory(dataDir);
  const id = 'state-' + new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID();
  const temp = path.join(dir, id + '.partial');
  const destination = path.join(dir, id + '.sqlite');
  try {
    // VACUUM INTO gives a transactionally consistent snapshot including WAL
    // contents; copying the live .sqlite file alone is not a safe backup.
    db.prepare('VACUUM INTO ?').run(temp);
    await fs.chmod(temp, 0o600);
    const sync = await fs.open(temp, 'r'); try { await sync.sync(); } finally { await sync.close(); }
    const backup: StateBackup = { format: 'miter-state-backup/1', id, createdAt: Date.now(), appVersion: APP_VERSION,
      schemaVersion: Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0), reason: reason.slice(0, 120),
      bytes: (await fs.stat(temp)).size, sha256: await hashFile(temp) };
    await fs.rename(temp, destination);
    const manifest = path.join(dir, id + '.json');
    const handle = await fs.open(manifest + '.partial', 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(backup, null, 2)+'\n'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(manifest + '.partial', manifest);
    return backup;
  } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
}
async function readMetadata(dir:string,id:string):Promise<StateBackup> {
  if(!validId(id))throw new Error('Invalid backup ID. Select a listed state backup.');
  const file=path.join(dir,id+'.json'),stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>8192)throw new Error('Invalid backup metadata file.');
  const meta=JSON.parse(await fs.readFile(file,'utf8')) as StateBackup;
  if(meta.format!=='miter-state-backup/1'||meta.id!==id||!/^[a-f0-9]{64}$/.test(meta.sha256)||!Number.isSafeInteger(meta.bytes)||meta.bytes<1||!Number.isFinite(meta.createdAt)||typeof meta.appVersion!=='string'||typeof meta.reason!=='string')throw new Error('Invalid backup metadata.');
  return meta;
}
export async function listStateBackups(dataDir: string): Promise<StateBackup[]> {
  const dir = await directory(dataDir), entries = await fs.readdir(dir), results: StateBackup[] = [];
  for (const name of entries.filter(n => n.endsWith('.json') && validId(n.slice(0,-5))).sort().reverse().slice(0, 100)) {
    try { results.push(await readMetadata(dir,name.slice(0,-5))); }
    catch { /* An incomplete snapshot is not advertised as restorable. */ }
  }
  return results;
}
export async function verifyStateBackup(dataDir: string, id: string): Promise<StateBackup> {
  if (!validId(id)) throw new Error('Invalid backup ID. Select a listed state backup.');
  const meta = await readMetadata(await directory(dataDir),id);
  const file = path.join(await directory(dataDir), id+'.sqlite'), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size!==meta.bytes) throw new Error('State backup size or file type is invalid.');
  if (await hashFile(file)!==meta.sha256) throw new Error('State backup checksum mismatch. Nothing was restored.');
  const db = new DatabaseSync(file,{readOnly:true});
  try {
    const checks = db.prepare('PRAGMA quick_check').all();
    if (checks.length!==1 || checks[0]?.quick_check!=='ok') throw new Error('State backup integrity check failed.');
    const version=Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version!==1 || meta.schemaVersion!==version) throw new Error('Unsupported backup database schema. Nothing was restored.');
    for (const name of ['kv','workers','projects','envelopes','events','journal']) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error('Not a complete Miter state database.');
    }
  } finally { db.close(); }
  return meta;
}
/** Offline maintenance only. Never restores project files or model permissions. */
export async function restoreStateBackup(dataDir: string, id: string, confirm: boolean) {
  if (!confirm) throw new Error('Restore needs --confirm. It replaces saved task state, not project files.');
  const release = await acquireHostLock(dataDir);
  let db: DatabaseSync | undefined;
  const target=path.join(dataDir,'mitter.sqlite'), staged=path.join(dataDir,'state-restore-'+randomUUID()+'.partial');
  try {
    const selected = await verifyStateBackup(dataDir,id);
    await assertStateDatabasePaths(dataDir);
    const stat=await fs.lstat(target).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return undefined;});
    if(stat&&(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1))throw new Error('Unsafe active database path.');
    let rollback:StateBackup|undefined;
    if(stat){
      db=new DatabaseSync(target);
      if (Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) > 1) throw new Error('Current state uses a newer database schema. Nothing was restored.');
      rollback=await createStateBackup(db as unknown as SqlDatabase,dataDir,'before-restore');
      const result=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if(Number(result?.busy??0)!==0)throw new Error('The state database is still in use. Close all Miter views before restoring.');
      db.close();db=undefined;
    }
    await fs.copyFile(path.join(dataDir,'backups',id+'.sqlite'),staged);
    await fs.chmod(staged,0o600);
    if(await hashFile(staged)!==selected.sha256)throw new Error('Restore staging checksum mismatch.');
    const handle=await fs.open(staged,'r');try{await handle.sync();}finally{await handle.close();}
    // Checkpoint above drained any WAL before this atomic database replacement.
    for(const suffix of ['-wal','-shm'])await fs.unlink(target+suffix).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
    await fs.rename(staged,target);
    return {restored:selected.id,rollback:rollback?.id,projectFilesChanged:false};
  } finally {db?.close();await fs.unlink(staged).catch(()=>{});await release();}
}
