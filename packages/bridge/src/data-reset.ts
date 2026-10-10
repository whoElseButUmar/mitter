/** Two-store reset transaction. There is deliberately no rollback of deletion:
 * a failed stage leaves both coordinators locked for explicit, idempotent retry. */
export const DATA_RESET_KEY='miter.reset.pending.v1';
export type DataResetPhase='idle'|'stopping'|'clearing'|'failed'|'complete';
export interface DataResetState {phase:DataResetPhase;error?:string;preserved?:string[];step?:'native'|'browser'|'commit'}
export interface DataResetDependencies {
 storage:{get(key:string):Promise<Record<string,unknown>>;set(data:Record<string,unknown>):Promise<unknown>;remove(key:string):Promise<unknown>};
 quiesceViews():Promise<void>;
 stop():Promise<void>;
 hostPrepare():Promise<{prepared:boolean}>;
 hostClear():Promise<{cleared:boolean;failures:{path:string;error:string}[];preserved:string[]}>;
 clearBrowser():Promise<void>;
 hostComplete():Promise<{cleared:boolean}>;
 publish(state:DataResetState):void;
 restart():void;
}
export class DataResetCoordinator {
 readonly ready:Promise<void>;
 blocked=false;busy=false;state:DataResetState={phase:'idle'};
 constructor(private deps:DataResetDependencies){
  this.ready=deps.storage.get(DATA_RESET_KEY).then(data=>{if(data[DATA_RESET_KEY])this.recover('A previous data reset did not finish. Type CLEAR to retry.');}).catch(e=>this.recover('Could not check the reset lock: '+String(e)));
 }
 recover(error:string){this.blocked=true;if(!this.busy)this.publish({phase:'failed',error});}
 private publish(state:DataResetState){this.state=state;this.deps.publish(state);}
 async clear(confirmation:unknown):Promise<void>{
  if(confirmation!=='CLEAR')throw Error('Type exactly CLEAR to delete all Miter application data.');
  await this.ready;if(this.busy)throw Error('A reset is already running.');
  this.busy=true;this.blocked=true;this.publish({phase:'stopping'});
  try{
   await this.deps.storage.set({[DATA_RESET_KEY]:true});
   // First STOP every writer. A refused document barrier must not delete the
   // native database in parallel. Preparation gates native RPC, drains workers
   // and writes its recovery marker, but does not remove application records.
   const settled=await Promise.allSettled([this.deps.quiesceViews(),this.deps.stop(),this.deps.hostPrepare()]);
   const failures=settled.flatMap((s,i)=>s.status==='rejected'?[( ['Open views','Background workers','Native preparation'][i])+': '+String(s.reason)]:[]);
   if(failures.length)throw Error(failures.join('\n'));
   const preparation=settled[2];
   if(preparation?.status!=='fulfilled'||preparation.value?.prepared!==true)throw Error('The native host did not confirm reset preparation. No native cleanup was authorized.');
   this.publish({phase:'clearing',step:'native'});
   const host=await this.deps.hostClear();
   if(!host||host.cleared!==true)throw Error((host?.failures||[]).map(f=>`${f.path}: ${f.error}`).join('\n')||'Native state could not be fully deleted.');
   this.publish({phase:'clearing',step:'browser'});
   await this.deps.clearBrowser();
   this.publish({phase:'clearing',step:'commit'});
   if((await this.deps.hostComplete())?.cleared!==true)throw Error('The native host did not confirm final reset verification. Reset remains locked.');
   await this.deps.storage.remove(DATA_RESET_KEY);
   if((await this.deps.storage.get(DATA_RESET_KEY))[DATA_RESET_KEY])throw Error('The browser reset lock could not be removed.');
   this.publish({phase:'complete',preserved:host.preserved});this.deps.restart();
  }catch(error){
   const detail=error instanceof Error?error.message:String(error);
   // Native marker remains until browser cleanup completes. Re-create the
   // browser lock as well when a failure happens after storage.clear().
   let lockError='';try{await this.deps.storage.set({[DATA_RESET_KEY]:true});}catch(e){lockError='\nBrowser reset lock: '+String(e);}
   this.publish({phase:'failed',error:detail+lockError});throw Error(detail+lockError);
  }finally{this.busy=false;}
 }
}
