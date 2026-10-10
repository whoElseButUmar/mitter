import {TERMINAL_PORT} from '../../../packages/terminal/src/protocol';
export class TerminalClient {
 private port:chrome.runtime.Port|undefined;
 private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 constructor(private disconnected:()=>void){}
 private connect(){
   const port=chrome.runtime.connect({name:TERMINAL_PORT});this.port=port;
   port.onMessage.addListener(m=>{if(this.port!==port)return;const p=this.pending.get(m?.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);m.ok?p.resolve(m.result):p.reject(Error(m.error||'Terminal request failed.'));});
   port.onDisconnect.addListener(()=>{if(this.port!==port)return;this.port=undefined;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Terminal disconnected. Input was not replayed.'));}this.pending.clear();this.disconnected();});return port;
 }
 request<T=unknown>(method:string,params:Record<string,unknown>={}):Promise<T>{
   const port=this.port||this.connect(),id=crypto.randomUUID();
   return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Terminal request timed out. Input was not replayed.'));},15000);this.pending.set(id,{resolve,reject,timer});try{port.postMessage({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});
 }
 close(){const p=this.port;this.port=undefined;p?.disconnect();for(const v of this.pending.values()){clearTimeout(v.timer);v.reject(Error('Terminal view closed.'));}this.pending.clear();}
}
