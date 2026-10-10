/** Local-only state backup/restore. No network or project file writes. */
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {defaultDataDir} from '../dist/apps/host/src/runtime.js';
import {acquireHostLock} from '../dist/apps/host/src/core/host-lock.js';
import {assertStateDatabasePaths,createStateBackup,listStateBackups,verifyStateBackup,restoreStateBackup} from '../dist/apps/host/src/core/backups.js';
const [command='help',id,...flags]=process.argv.slice(2),dataDir=defaultDataDir();
try{
 if(command==='list')console.log(JSON.stringify(await listStateBackups(dataDir),null,2));
 else if(command==='verify')console.log(JSON.stringify(await verifyStateBackup(dataDir,id),null,2));
 else if(command==='restore'){
  console.log('Restoring saved task state only. Project files will not be changed.');
  console.log(JSON.stringify(await restoreStateBackup(dataDir,id,flags.includes('--confirm')),null,2));
  console.log('Re-enable/reopen Miter. Review current files before resuming older plans.');
 }else if(command==='backup'){
  const release=await acquireHostLock(dataDir);let db;
  try{await assertStateDatabasePaths(dataDir);db=new DatabaseSync(path.join(dataDir,'mitter.sqlite'),{readOnly:true});console.log(JSON.stringify(await createStateBackup(db,dataDir,'maintenance'),null,2));}
  finally{db?.close();await release();}
 }else if(command==='help')console.log('Miter local state maintenance\n\n  node scripts/maintenance.mjs list\n  node scripts/maintenance.mjs backup\n  node scripts/maintenance.mjs verify BACKUP_ID\n  node scripts/maintenance.mjs restore BACKUP_ID --confirm\n\nClose/disable Miter before backup or restore via the CLI. Live backup is available from Connection & health.\nState backups include source in journals, not the project directories themselves. Keep them private.');
 else throw Error('Unknown maintenance command. Run without arguments for help.');
}catch(e){console.error(e.message);process.exitCode=1;}
