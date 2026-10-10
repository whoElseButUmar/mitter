import {WORKSPACE_KEY,LEGACY_WORKSPACE_KEY,restoreWorkspace,reconcileWorkspace,reduceWorkspace,validateWorkspaceAction,type WorkspaceState,type Catalog} from './workspace.js';
export interface WorkspaceStorage {get(keys:string[]):Promise<Record<string,unknown>>;set(values:Record<string,unknown>):Promise<unknown>;}
/** A single background authority serializes actions from every UI view. A failed
 * durable write is reported, not broadcast as though the action had succeeded. */
export class WorkspaceStore {
 private stopped=false;
 private state?:WorkspaceState;private stored?:Record<string,unknown>;private tail:Promise<unknown>=Promise.resolve();
 constructor(private backend:WorkspaceStorage,private publish:(s:WorkspaceState)=>void){}
 private queue<T>(job:()=>Promise<T>):Promise<T>{const next=this.tail.then(()=>{if(this.stopped)throw Error('Data reset in progress.');return job();});this.tail=next.catch(()=>{});return next;}
 private async load(c:Catalog){if(!this.stored)this.stored=await this.backend.get([WORKSPACE_KEY,LEGACY_WORKSPACE_KEY,'selectedWorker']);return this.state??restoreWorkspace(this.stored[WORKSPACE_KEY],this.stored[LEGACY_WORKSPACE_KEY],this.stored.selectedWorker,c);}
 private async save(next:WorkspaceState){
  const changed=!this.state||JSON.stringify(next)!==JSON.stringify(this.state);
  if(changed){next={...next,revision:Math.max(this.state?.revision||0,next.revision)+1};await this.backend.set({[WORKSPACE_KEY]:next});this.state=next;this.publish(next);}
  return structuredClone(this.state!);
 }
 sync(c:Catalog):Promise<WorkspaceState>{return this.queue(async()=>this.save(reconcileWorkspace(await this.load(c),c)));}
 dispatch(value:unknown,c:Catalog):Promise<WorkspaceState>{const action=validateWorkspaceAction(value);return this.queue(async()=>this.save(reduceWorkspace(await this.load(c),action,c,Date.now(),crypto.randomUUID())));}
 async quiesce(){this.stopped=true;await this.tail;}
 peek(){return this.state?structuredClone(this.state):undefined;}
}
