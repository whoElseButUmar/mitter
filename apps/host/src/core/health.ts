import { promises as fs } from 'node:fs';
import path from 'node:path';
import { APP_VERSION, VERSION, type Worker } from '../../../../packages/protocol/src/index.js';
import type { Store } from './database.js';
import { listStateBackups } from './backups.js';
import { MAX_PREVIEW_BYTES } from './assets.js';
export async function inspectHealth(store:Store,dataDir:string,workers:Worker[],active:number,workflow:string){
  const checks=store.db.prepare('PRAGMA quick_check').all();
  const databaseOK=checks.length===1&&checks[0]?.quick_check==='ok';
  const stat=await fs.stat(path.join(dataDir,'mitter.sqlite')).catch(()=>undefined);
  const backups=await listStateBackups(dataDir);
  return {version:APP_VERSION,protocol:VERSION,node:process.version,platform:process.platform,architecture:process.arch,workflow,
    database:{ok:databaseOK,schema:Number(store.db.prepare('PRAGMA user_version').get()?.user_version??0),bytes:stat?.size??0},
    tasks:{total:workers.length,active,finished:workers.filter(w=>w.state==='complete').length,stopped:workers.filter(w=>w.control?.mode==='stopped').length},
    attention:workers.filter(w=>w.error||w.pending).slice(0,20).map(w=>({id:w.id,name:w.name,state:w.state,reason:w.pending?'Command approval needed':w.error})),
    backups:backups.slice(0,10),dataDirectory:dataDir,
    limits:{savedProjects:50,savedTasks:200,previewBytes:MAX_PREVIEW_BYTES},
    notice:'State backups contain task history and journaled source. They are private and are not backups of your project directories. No network request or model invocation was made.'};
}
