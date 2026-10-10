import type { PreviewRPC } from '../../../packages/ui/src/preview';
/** One lightweight read-only connection. Reconnection never triggers execution. */
export class FilePreviewClient {
 private port?:chrome.runtime.Port;
 private closed=false;
 private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private fail(error:Error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
 private connect(){
  if(this.closed)throw new Error('File window closed.');
  if(this.port)return this.port;
  const port=chrome.runtime.connect({name:'miter-file-preview'});this.port=port;
  port.onMessage.addListener(message=>{if(this.port!==port)return;const p=this.pending.get(message?.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer);message.ok?p.resolve(message.result):p.reject(new Error(message.error||'Could not read this file.'));});
  port.onDisconnect.addListener(()=>{if(this.port!==port)return;this.port=undefined;this.fail(new Error(chrome.runtime.lastError?.message||'File connection closed. Reload to reconnect.'));});
  return port;
 }
 request:PreviewRPC=<T>(method:string,params:Record<string,unknown>):Promise<T>=>{
  if(method!=='worker.asset')return Promise.reject(new Error('Read-only file window.'));
  return new Promise<T>((resolve,reject)=>{
   const id=crypto.randomUUID(),timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('File read timed out. Reload to try again.'));},35000);
   this.pending.set(id,{resolve,reject,timer});
   try{this.connect().postMessage({id,method,params});}catch(e){this.pending.delete(id);clearTimeout(timer);reject(e);}
  });
 };
 close(){this.closed=true;const port=this.port;this.port=undefined;this.fail(new Error('File window closed.'));port?.disconnect();}
}
