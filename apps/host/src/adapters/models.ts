import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Settings } from '../../../../packages/protocol/src/index.js';
import type { Models } from '../core/types.js';
/** Model crashes and large native allocations are isolated from the filesystem/SQLite host process. */
export class ModelProcess implements Models {
  private child?:ChildProcess;
  private retiring=new Set<ChildProcess>();
  private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;cleanup:()=>void}>();
  constructor(private getSettings:()=>Settings){}
  private ensure():ChildProcess {
    if(this.child)return this.child;
    const worker=fileURLToPath(new URL('../../../inference/src/worker.js',import.meta.url));
    const child=fork(worker,[],{stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,SystemRoot:process.env.SystemRoot,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});
    // All diagnostics go to stderr, never to Chrome's framed stdout channel.
    child.stderr?.on('data',chunk=>process.stderr.write(chunk));
    child.on('message',(message:any)=>{
      if(this.child!==child)return;
      const pending=this.pending.get(message?.id);if(!pending)return;
      this.pending.delete(message.id);pending.cleanup();
      if(message.ok)pending.resolve(message.result);else pending.reject(new Error(String(message.error)));
    });
    child.on('error',()=>{if(this.child===child)this.close();});child.on('exit',()=>{if(this.child===child){this.child=undefined;this.rejectAll(new Error('Local model process exited. No filesystem action was automatically repeated.'));}});
    this.child=child;return child;
  }
  private rejectAll(error:Error):void {for(const p of this.pending.values()){p.cleanup();p.reject(error);}this.pending.clear();}
  private request(method:string,input:unknown,signal:AbortSignal):Promise<any> {
    signal.throwIfAborted();const child=this.ensure(),id=randomUUID();
    return new Promise((resolve,reject)=>{
      const abort=()=>this.close();const timer=setTimeout(()=>this.close(),300000);timer.unref();
      const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
      this.pending.set(id,{resolve,reject,cleanup});signal.addEventListener('abort',abort,{once:true});
      // IPC can throw synchronously as well as report failure through its
      // callback. Neither path may leave a timer that kills a later worker.
      const failed=(error:Error)=>{this.pending.delete(id);cleanup();reject(error);};
      try{child.send({id,method,input,settings:this.getSettings()},error=>{if(error)failed(error);});}
      catch(error){failed(error instanceof Error?error:new Error(String(error)));}
    });
  }
  propose(prompt:string,signal:AbortSignal):Promise<string>{return this.request('propose',prompt,signal);}
  close():void {
    const child=this.child;this.child=undefined;
    if(child&&child.exitCode===null&&child.signalCode===null){
      this.retiring.add(child);child.once('exit',()=>this.retiring.delete(child));child.kill('SIGKILL');
    }
    this.rejectAll(new Error('Local model stopped or timed out.'));
  }
  async settled():Promise<void> {
    const until=Date.now()+5000;
    while(this.retiring.size){if(Date.now()>until)throw Error('Local model process has not exited; reset refused.');await new Promise(resolve=>setTimeout(resolve,20));}
  }
}
