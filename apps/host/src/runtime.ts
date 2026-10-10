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
import { RESET_MARKER, validateResetRoot, markResetPending, resetPending, removeApplicationState, type ResetResult } from './core/reset.js';
import { resolveStateRoot, assertStateRoot } from './core/state-root.js';
import { APP_VERSION } from '../../../packages/protocol/src/index.js';
import type { SqlDatabase } from './core/types.js';
export const defaultDataDir=()=>path.resolve(process.env.MITTER_HOME||path.join(os.homedir(),'.mitter'));
export async function openRuntime(options:{portable?:boolean;dataDir?:string;lock?:boolean}={}) {
  const requestedDir=path.resolve(options.dataDir??defaultDataDir());
  await fs.mkdir(requestedDir,{recursive:true,mode:0o700});
  const stateRoot=await resolveStateRoot(requestedDir),dataDir=stateRoot.path;
  const release = options.lock===false ? async()=>{} : await acquireHostLock(dataDir);
  let current:Service|undefined, closed=false, resetting=false, needsReset=false, cleanupComplete=false;
  let resetDone:Promise<void>=Promise.resolve(), closeJob:Promise<void>|undefined;
  let protectedProjects:string[]=[];
  async function exclusiveReset<T>(confirmation:unknown,operation:()=>Promise<T>):Promise<T>{
    if(confirmation!=='CLEAR')throw Error('Type exactly CLEAR to delete all Miter application data.');
    if(closed||resetting)throw Error('The host is closing or a reset is already running.');
    resetting=true;let done!:()=>void;resetDone=new Promise<void>(resolve=>{done=resolve;});
    try{return await operation();}finally{resetting=false;done();}
  }
  async function stopForReset(stopExternal:()=>Promise<void>,drain:()=>Promise<void>):Promise<void>{
    cleanupComplete=false;
    await assertStateRoot(stateRoot);
    if(current?.projects.size)protectedProjects=[...current.projects.values()].map(p=>p.root);
    await validateResetRoot(dataDir,protectedProjects);
    await markResetPending(dataDir);needsReset=true;
    // Prepare is durable and non-deleting. Even if a browser view refuses the
    // barrier, native writers stop and restart remains explicitly locked.
    await current?.quiesce();await stopExternal();await drain();
    // An already-running project registration can finish while the normal RPC
    // lane drains. Include it before the final overlap check, not only the
    // snapshot taken when preparation began.
    if(current)protectedProjects=[...new Set([...protectedProjects,...[...current.projects.values()].map(p=>p.root)])];
    await current?.close();
    await assertStateRoot(stateRoot);
    await validateResetRoot(dataDir,protectedProjects);
  }
  async function createService(allowBackup=true):Promise<Service> {
    let database:SqlDatabase|undefined;
    try {
      await assertStateRoot(stateRoot);
      await assertStateDatabasePaths(dataDir);
      if(options.portable) {const {DatabaseSync}=await import('node:sqlite');database=new DatabaseSync(path.join(dataDir,'mitter.sqlite')) as unknown as SqlDatabase;}
      else {const name='better-sqlite3';const {default:Database}=await import(name);database=new Database(path.join(dataDir,'mitter.sqlite')) as SqlDatabase;}
      const schema=Number(database.prepare('PRAGMA user_version').get()?.user_version??0);
      if(schema>1)throw new Error('This database was created by a newer Miter schema. It was not modified.');
      const hasState=!!database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").get();
      if(hasState&&allowBackup){
        const prior=database.prepare("SELECT value FROM kv WHERE key='miter.installedVersion'").get()?.value;
        if(prior!==JSON.stringify(APP_VERSION))await createStateBackup(database,dataDir,'before-upgrade');
      }
      const store=new Store(database), workflow=options.portable?referenceWorkflow:await loadXStateWorkflow();
      let service!:Service;const models=new ModelProcess(()=>service.settings);
      service=new Service(store,dataDir,workflow,models,options.portable?'portable reference graph (not XState)':'XState v5');
      store.set('miter.installedVersion',APP_VERSION);
      await fs.chmod(path.join(dataDir,'mitter.sqlite'),0o600);
      return service;
    } catch(error) {database?.close();throw error;}
  }
  try {
    needsReset=await resetPending(dataDir);
    // A crash or a partial deletion must never reopen the old DB, recreate a
    // backup, revive a worker or write recovery records before explicit retry.
    if(!needsReset)current=await createService();
    return {
      dataDir,
      get service(){if(!current)throw Error('Data reset is incomplete. Retry Clear all Miter data.');return current;},
      get resetRequired(){return needsReset;},
      prepareReset(confirmation:unknown,stopExternal:()=>Promise<void>=async()=>{},drain:()=>Promise<void>=async()=>{}){
        return exclusiveReset(confirmation,async()=>{await stopForReset(stopExternal,drain);return {prepared:true};});
      },
      reset(confirmation:unknown,stopExternal:()=>Promise<void>=async()=>{},drain:()=>Promise<void>=async()=>{}):Promise<ResetResult>{
        return exclusiveReset(confirmation,async()=>{
          await stopForReset(stopExternal,drain);current=undefined;
          if(closed)throw Error('The host closed during reset preparation. State was not deleted; retry after reconnecting.');
          const result=await removeApplicationState(dataDir,stateRoot,protectedProjects);
          if(!result.cleared)return result;
          if(closed)throw Error('The host closed during cleanup. Reset remains locked; reconnect and retry.');
          current=await createService(false);cleanupComplete=true;
          return result; // locked until browser cleanup is also verified
        });
      },
      completeReset(confirmation:unknown){
        return exclusiveReset(confirmation,async()=>{
          if(!needsReset||!cleanupComplete||!current)throw Error('A complete, confirmed state reset is required before restarting.');
          if(current.projects.size||current.workers.size)throw Error('Fresh state verification failed. Reset remains locked.');
          await assertStateRoot(stateRoot);await validateResetRoot(dataDir,protectedProjects);
          await fs.unlink(path.join(dataDir,RESET_MARKER));needsReset=false;cleanupComplete=false;protectedProjects=[];
          return {cleared:true};
        });
      },
      close():Promise<void>{
        if(closeJob)return closeJob;
        closed=true;
        // Do not release the host lease or close a DB while reset can still
        // delete/recreate it. Concurrent callers share one shutdown result.
        closeJob=(async()=>{await resetDone;try{await current?.close();}finally{await release();}})();
        return closeJob;
      },
    };
  }catch(error){try{await current?.close();}finally{await release();}throw error;}
}
