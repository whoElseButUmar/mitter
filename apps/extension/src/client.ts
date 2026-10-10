import { APP_VERSION, type Snapshot } from '../../../packages/protocol/src/index';
export class HostClient {
  private port?:chrome.runtime.Port;
  private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:number}>();
  private closed=false;
  private retryTimer?:number;
  private heartbeatTimer?:number;
  private heartbeatDeadline?:number;
  private heartbeatId='';
  private retries=0;
  constructor(private onSnapshot:(s:Snapshot)=>void,private onConnection:(ok:boolean,error?:string)=>void,private onAux:(message:any)=>void=()=>{}){}
  private rejectPending(error:Error){
    for(const p of this.pending.values()){window.clearTimeout(p.timer);p.reject(error);}
    this.pending.clear();
  }
  private clearRetry(){if(this.retryTimer!==undefined)window.clearTimeout(this.retryTimer);this.retryTimer=undefined;}
  private clearHeartbeat(){
    if(this.heartbeatTimer!==undefined)window.clearTimeout(this.heartbeatTimer);
    if(this.heartbeatDeadline!==undefined)window.clearTimeout(this.heartbeatDeadline);
    this.heartbeatTimer=undefined;this.heartbeatDeadline=undefined;this.heartbeatId='';
  }
  private scheduleReconnect(error:string){
    if(this.closed||this.retryTimer!==undefined)return;
    // Reconnect the view, never replay an outstanding RPC or start a task.
    // Stop trying after six failed connections; a missing/updated extension
    // should not leave a hot retry loop behind an apparently frozen panel.
    if(this.retries>=6){this.onConnection(false,error+' Automatic reconnection paused. Use Reconnect or reopen Miter.');return;}
    const delay=Math.min(8000,250*2**this.retries++);
    this.onConnection(false,error+' Reconnecting the panel… Pending actions are not retried.');
    this.retryTimer=window.setTimeout(()=>{this.retryTimer=undefined;if(!this.closed&&!this.port)this.open();},delay);
  }
  private disconnected(port:chrome.runtime.Port,error:string){
    if(this.port!==port)return;
    this.port=undefined;this.clearHeartbeat();
    this.rejectPending(new Error(error+' The operation may already have reached Miter; it was not replayed.'));
    try{port.disconnect();}catch(error){console.warn('Miter native port failed to close.',error);}
    this.scheduleReconnect(error);
  }
  private scheduleHeartbeat(port:chrome.runtime.Port){
    this.clearHeartbeat();
    if(this.closed||this.port!==port)return;
    this.heartbeatTimer=window.setTimeout(()=>{
      this.heartbeatTimer=undefined;if(this.closed||this.port!==port)return;
      const id=crypto.randomUUID();this.heartbeatId=id;
      this.heartbeatDeadline=window.setTimeout(()=>{
        if(this.port===port&&this.heartbeatId===id)this.disconnected(port,'The extension connection stopped responding.');
      },5000);
      try{port.postMessage({type:'ping',id});}
      catch{this.disconnected(port,'The extension connection closed.');}
    },15000);
  }
  private open(){
    if(this.closed)return;
    let port:chrome.runtime.Port;
    try{port=chrome.runtime.connect({name:'mitter-ui'});}
    catch(error){this.scheduleReconnect(error instanceof Error?error.message:'The extension could not be reached.');return;}
    this.port=port;
    port.onMessage.addListener(message=>{
      if(this.port!==port||this.closed)return;
      if(message?.type==='pong'){
        if(message.id===this.heartbeatId){this.retries=0;this.scheduleHeartbeat(port);}
        return;
      }
      if(message?.event==='snapshot'&&message.data?.protocol==='mitter/1'){
        this.retries=0;this.onSnapshot(message.data);const version=message.data.runtime?.version;
        this.onConnection(version===APP_VERSION,version===APP_VERSION?undefined:'Reload Miter after setup to connect the matching local host.');return;
      }
      if(message?.event==='connection'){this.onConnection(message.connected,message.error);return;}
      if(message?.event==='taskNotification'||message?.event==='notificationSettings'||message?.event==='ding'||message?.event==='debug'||message?.event==='bridges'||message?.event==='workspace'||message?.event==='workspaceError'){this.onAux(message);return;}
      const p=this.pending.get(message?.id);if(!p)return;window.clearTimeout(p.timer);this.pending.delete(message.id);
      if(message.ok)p.resolve(message.result);else p.reject(new Error(message.error));
    });
    port.onDisconnect.addListener(()=>{
      if(this.port!==port)return;
      this.disconnected(port,chrome.runtime.lastError?.message??'Extension connection closed.');
    });
    this.scheduleHeartbeat(port);
  }
  connect(){
    // Detach logically before disconnecting: late old-port callbacks must not
    // reject new requests or disconnect the newly established view.
    const previous=this.port;this.port=undefined;this.closed=false;
    this.clearRetry();this.clearHeartbeat();this.retries=0;
    this.rejectPending(new Error('Extension connection replaced. The previous operation was not replayed.'));
    try{previous?.disconnect();}catch(error){console.warn('Miter previous native port failed to close.',error);}
    this.open();
  }
  request<T=unknown>(method:string,params:Record<string,unknown>={}):Promise<T>{
    if(this.closed)return Promise.reject(new Error('Miter view closed. No operation was sent.'));
    if(!this.port){this.clearRetry();this.open();}
    const port=this.port;
    if(!port)return Promise.reject(new Error('The extension is reconnecting. No operation was sent.'));
    const id=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=window.setTimeout(()=>{
        this.pending.delete(id);
        reject(new Error((method.startsWith('bridge.')?'The chat connection did not respond.':'The local host did not respond.')+' The operation may still finish; it was not retried. Open Console for details.'));
      },method==='project.pickFolder'?135000:45000);
      this.pending.set(id,{resolve,reject,timer});
      try{port.postMessage({id,method,params});}
      catch{this.disconnected(port,'The extension connection closed while sending.');}
    });
  }
  reconnect(){
    if(this.closed)return;
    if(!this.port)this.connect();
    const port=this.port;if(!port)return;
    try{port.postMessage({type:'reconnect'});}catch{this.disconnected(port,'The extension connection closed.');}
  }
  close(){
    this.closed=true;this.clearRetry();this.clearHeartbeat();
    const port=this.port;this.port=undefined;
    this.rejectPending(new Error('Miter view closed. Pending operations were not replayed.'));
    try{port?.disconnect();}catch(error){console.warn('Miter native port failed to close.',error);}
  }
}
export async function userReadClipboard():Promise<string>{
  const granted=await chrome.permissions.request({permissions:['clipboardRead']});
  if(!granted)throw new Error('Clipboard permission was not granted. Paste into the text box instead.');
  return navigator.clipboard.readText();
}
