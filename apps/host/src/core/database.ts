import type { Activity, Project, Worker } from '../../../../packages/protocol/src/index.js';
import type { SqlDatabase } from './types.js';
export interface Journal { id: string; workerId: string; runId: string; path: string; before: string | null; after: string; beforeHash: string; afterHash: string; status: string; time: number }
export class Store {
  constructor(readonly db: SqlDatabase) {
    const version=Number(db.prepare('PRAGMA user_version').get()?.user_version??0);
    if(version>1)throw new Error('This database was created by a newer Miter schema. It was not downgraded or modified.');
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
  transaction<T>(fn:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get<T>(key:string):T|undefined { const row=this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value):undefined; }
  set(key:string,value:unknown):void { this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  projects():Project[] { return this.db.prepare('SELECT value FROM projects ORDER BY rowid').all().map(r=>JSON.parse(r.value)); }
  workers():Worker[] { return this.db.prepare('SELECT value FROM workers ORDER BY rowid').all().map(r=>JSON.parse(r.value)); }
  saveProject(p:Project):void { this.db.prepare('INSERT INTO projects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(p.id,JSON.stringify(p.sourceRoot?{...p,root:p.sourceRoot,sourceRoot:undefined}:p)); }
  saveWorker(w:Worker):void { this.db.prepare('INSERT INTO workers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(w.id,JSON.stringify(w)); }
  rememberEnvelope(id:string,workerId:string):void { this.db.prepare('INSERT INTO envelopes VALUES (?,?)').run(id,workerId); }
  hasEnvelope(id:string):boolean { return !!this.db.prepare('SELECT id FROM envelopes WHERE id=?').get(id); }
  envelopeOwner(id:string):string|undefined { return this.db.prepare('SELECT worker_id FROM envelopes WHERE id=?').get(id)?.worker_id; }
  envelopeCount(workerId:string):number { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM envelopes WHERE worker_id=?').get(workerId)?.n??0); }
  event(workerId:string,kind:string,message:string):void {
    this.db.prepare('INSERT INTO events(worker_id,time,kind,message) VALUES(?,?,?,?)').run(workerId,Date.now(),kind,message.slice(0,8000));
    // Bounded diagnostics, not an unbounded copy of project output.
    this.db.prepare('DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-5000 FROM events)').run();
  }
  events():Activity[] { return this.db.prepare('SELECT id,worker_id AS workerId,time,kind,message FROM events ORDER BY id DESC LIMIT 80').all(); }
  taskEvents(workerId:string,before=Number.MAX_SAFE_INTEGER):Activity[] { return this.db.prepare('SELECT id,worker_id AS workerId,time,kind,message FROM events WHERE worker_id=? AND id<? ORDER BY id DESC LIMIT 101').all(workerId,before); }
  prepareWrite(j:Journal):void {
    this.db.prepare('INSERT INTO journal VALUES(?,?,?,?,?,?,?,?,?,?)').run(j.id,j.workerId,j.runId,j.path,j.before,j.after,j.beforeHash,j.afterHash,j.status,j.time);
  }
  journal(id:string):Journal|undefined { return this.db.prepare('SELECT id,worker_id AS workerId,run_id AS runId,path,before_text AS before,after_text AS after,before_hash AS beforeHash,after_hash AS afterHash,status,time FROM journal WHERE id=?').get(id); }
  writes(runId:string):Journal[] { return this.db.prepare('SELECT id,worker_id AS workerId,run_id AS runId,path,before_text AS before,after_text AS after,before_hash AS beforeHash,after_hash AS afterHash,status,time FROM journal WHERE run_id=? ORDER BY rowid DESC').all(runId); }
  changedFiles(runId:string):{path:string;status:string;bytes:number}[]{return this.db.prepare('SELECT path,status,LENGTH(CAST(after_text AS BLOB)) AS bytes FROM journal WHERE run_id=? ORDER BY rowid DESC').all(runId).map(r=>({path:r.path,status:r.status,bytes:r.bytes}));}
  fileChange(runId:string,relative:string):{before:string|null;after:string;beforeHash:string;afterHash:string;status:string}|undefined {
    const first=this.db.prepare("SELECT before_text AS before,before_hash AS beforeHash FROM journal WHERE run_id=? AND path=? AND status IN ('applied','prepared') ORDER BY rowid LIMIT 1").get(runId,relative);
    if(!first)return undefined;
    const last=this.db.prepare("SELECT after_text AS after,after_hash AS afterHash,status FROM journal WHERE run_id=? AND path=? AND status IN ('applied','prepared') ORDER BY rowid DESC LIMIT 1").get(runId,relative);
    return {...first,...last};
  }
  markWrite(id:string,status:string):void { this.db.prepare('UPDATE journal SET status=? WHERE id=?').run(status,id); }
  close():void { this.db.close(); }
}
export { DEFAULT_SETTINGS } from '../../../../packages/protocol/src/model-settings.js';
