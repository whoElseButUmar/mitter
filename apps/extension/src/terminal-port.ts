import {TERMINAL_PORT,TERMINAL_METHODS} from '../../../packages/terminal/src/protocol';
/** Narrow, human UI-only capability. Chat content scripts, file viewers, generic
 * UI RPC, and model actions cannot reach it. No terminal data enters debug logs. */
export function bindTerminalPort(port:chrome.runtime.Port,deps:{extensionId:string;viewURLs:string[];rpc:<T=unknown>(method:string,params:Record<string,unknown>)=>Promise<T>}){
  const sender=port.sender;
  if(port.name!==TERMINAL_PORT||sender?.id!==deps.extensionId||(sender.frameId!==undefined&&sender.frameId!==0)||(sender.origin!==undefined&&sender.origin!=='chrome-extension://'+deps.extensionId)||!sender.url||!deps.viewURLs.includes(sender.url.split(/[?#]/)[0]!))return false;
  const clientId=crypto.randomUUID();let alive=true,pending=0,tail=Promise.resolve();
  const post=(v:unknown)=>{if(alive)try{port.postMessage(v);}catch{alive=false;}};
  port.onMessage.addListener((raw:any)=>{
    if(!alive||!raw||typeof raw.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(raw.id))return;
    if(!TERMINAL_METHODS.has(raw.method)||raw.method==='terminal.disconnect'||!raw.params||typeof raw.params!=='object'||Array.isArray(raw.params)||'clientId' in raw.params){post({id:raw.id,ok:false,error:'Unsupported terminal request.'});return;}
    if(pending>=24){post({id:raw.id,ok:false,error:'Terminal is busy; input was not queued.'});return;}
    pending++;
    const run=async()=>{try{if(!alive)return;const result=await deps.rpc(raw.method,{...raw.params,clientId});post({id:raw.id,ok:true,result});if(!alive)await deps.rpc('terminal.disconnect',{clientId});}catch(error){post({id:raw.id,ok:false,error:error instanceof Error?error.message:'Terminal operation failed.'});}finally{pending--;}};
    if(['terminal.write','terminal.resize','terminal.close','terminal.create','terminal.attach','terminal.release'].includes(raw.method)){tail=tail.then(run,run);}else void run();
  });
  port.onDisconnect.addListener(()=>{alive=false;void tail.finally(()=>deps.rpc('terminal.disconnect',{clientId})).catch(()=>{});});
  return true;
}
