import { parseFileTarget,validateFileTarget } from '../../../packages/ui/src/file-target';
import type { PreviewRPC } from '../../../packages/ui/src/preview';
/** No workspace subscription and no mutation RPCs for a standalone viewer. */
export function bindFilePreviewPort(port:chrome.runtime.Port,deps:{extensionId:string;viewerURL:string;rpc:PreviewRPC}):boolean {
 const url=port.sender?.url;
 if(port.name!=='miter-file-preview'||port.sender?.id!==deps.extensionId||!url||url.split(/[?#]/)[0]!==deps.viewerURL){try{port.disconnect();}catch{}return false;}
 let target;try{target=parseFileTarget(url);}catch{port.disconnect();return false;}
 const workerId=target.workerId;
 let closed=false;
 const inFlight=new Set<string>();
 const post=(message:unknown)=>{if(!closed)try{port.postMessage(message);}catch{closed=true;}};
 port.onDisconnect.addListener(()=>{closed=true;});
 port.onMessage.addListener(message=>{
  if(closed||!message||typeof message.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(message.id))return;
  const id=message.id;
  if(inFlight.has(id))return; // Do not emit a duplicate response for the same operation.
  try{
   if(message.method!=='worker.asset'||!message.params||message.params.workerId!==workerId)throw new Error('This viewer can only read files from its original task.');
   validateFileTarget({workerId,path:message.params.path});
   if(inFlight.size>=4)throw new Error('Too many pending preview reads. Retry after the current load.');
   // Copy only the bounded read parameters, never arbitrary properties.
   const {path,offset,length,stamp}=message.params;
   inFlight.add(id);
   void deps.rpc('worker.asset',{workerId,path,offset,length,...(stamp===undefined?{}:{stamp})})
    .then(result=>post({id,ok:true,result}))
    .catch(error=>post({id,ok:false,error:error instanceof Error?error.message:String(error)}))
    .finally(()=>inFlight.delete(id));
  }catch(error){post({id,ok:false,error:error instanceof Error?error.message:String(error)});}
 });
 return true;
}
