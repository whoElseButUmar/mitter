import type {DataResetState} from '../../../packages/bridge/src/data-reset';
import {RESET_VIEW_PARAM} from '../../../packages/bridge/src/reset-views';
let resetting=false;
const writes=new Set<Promise<unknown>>();
/** All view-owned persistent writes go through this gate. A late import or
 * queued preference callback cannot repopulate storage after quiescence. */
export function persistLocal(data:Record<string,unknown>):Promise<void>{
  if(resetting)return Promise.reject(Error('Miter data reset is in progress. No preferences were saved.'));
  const write=chrome.storage.local.set(data);writes.add(write);
  void write.then(()=>writes.delete(write),()=>writes.delete(write));return write;
}
/** Dedicated reset channel, independent of task/terminal UI disposal. A lost
 * port reconnects for status only: a destructive request is NEVER replayed. */
export function connectResetView(
  onState:(state:DataResetState)=>void,
  quiesce:()=>void|Promise<void>,
  onConnection:(connected:boolean,error?:string)=>void=()=>{},
){
  let port:chrome.runtime.Port|undefined,closed=false,completed=false,retries=0;
  let retryTimer:ReturnType<typeof setTimeout>|undefined,readyTimer:ReturnType<typeof setTimeout>|undefined,reloadTimer:ReturnType<typeof setTimeout>|undefined;
  let stopJob:Promise<void>|undefined,marker='';
  const pending=new Map<string,{resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const stop=()=>{
    resetting=true;
    if(!stopJob)stopJob=Promise.resolve().then(quiesce).catch(error=>{stopJob=undefined;throw error;});
    return stopJob;
  };
  function restoreMarker(id=marker){
    if(!id||marker!==id)return;
    const url=new URL(location.href);
    if(url.searchParams.get(RESET_VIEW_PARAM)===id){url.searchParams.delete(RESET_VIEW_PARAM);history.replaceState(history.state,'',url.href);}
    marker='';
  }
  function rejectPending(detail:string){
    for(const job of pending.values()){clearTimeout(job.timer);job.reject(Error(detail));}pending.clear();
  }
  function disconnected(detail:string){
    if(readyTimer)clearTimeout(readyTimer);readyTimer=undefined;
    onConnection(false,detail);rejectPending(detail);
    try{restoreMarker();}catch{/* The old document may already be unloading. */}
    if(resetting&&!completed)onState({phase:'failed',error:detail+' Reconnecting for status only. No successful reset was confirmed; retry when connected.'});
    if(!closed&&!completed&&!retryTimer){retryTimer=setTimeout(()=>{retryTimer=undefined;connect();},Math.min(5000,250*2**Math.min(retries++,5)));}
  }
  function connect(){
    if(closed||completed||port)return;
    let current:chrome.runtime.Port;
    try{current=chrome.runtime.connect({name:'miter-data-view'});port=current;}
    catch(error){disconnected(String(error));return;}
    readyTimer=setTimeout(()=>{if(port!==current)return;port=undefined;try{current.disconnect();}catch{}disconnected('The reset coordinator did not respond.');},10000);
    current.onDisconnect.addListener(()=>{
      const detail=chrome.runtime.lastError?.message||'Reset coordinator disconnected.';
      if(port!==current||closed)return;port=undefined;disconnected(detail);
    });
    current.onMessage.addListener(message=>{
      if(port!==current||closed)return;
      if(message?.type==='reset-state'){
        const state=message.state as DataResetState;
        if(!state||!['idle','stopping','clearing','failed','complete'].includes(state.phase))return;
        if(readyTimer)clearTimeout(readyTimer);readyTimer=undefined;retries=0;onConnection(true);
        if(state.phase==='idle'&&resetting){onState({phase:'failed',error:'This view previously stopped for a reset. Retry clearing all data to verify both stores; work has not resumed.'});return;}
        if(state.phase!=='idle')void stop().catch(error=>{if(port===current&&!closed)onState({phase:'failed',error:'Could not stop this view: '+String(error)});});
        onState(state);
        if(state.phase==='complete'&&!completed){completed=true;reloadTimer=setTimeout(()=>location.reload(),500);}
      }else if(message?.type==='reset-quiesce'&&typeof message.id==='string'&&message.id.length>0&&message.id.length<=100){
        resetting=true;onState({phase:'stopping'});
        void (async()=>{
          try{
            await stop();await Promise.allSettled([...writes]);
            if(port!==current||closed)return;
            localStorage.clear();sessionStorage.clear();
            if(localStorage.length||sessionStorage.length)throw Error('Web Storage is not empty.');
            if(message.identify===true){
              const url=new URL(location.href);url.searchParams.set(RESET_VIEW_PARAM,message.id);
              history.replaceState(history.state,'',url.href);marker=message.id;
            }
            current.postMessage({type:'reset-ack',id:message.id,ok:true});
          }catch(error){
            if(port!==current||closed)return;
            try{current.postMessage({type:'reset-ack',id:message.id,ok:false,error:String(error)});}
            catch{onState({phase:'failed',error:'The view stopped but could not confirm cleanup. Reopen Miter and retry.'});}
          }
        })();
      }else if(message?.type==='reset-identified'&&typeof message.id==='string'){
        try{restoreMarker(message.id);}catch{/* The marker has no persisted data or authority after its one-time challenge. */}
      }else if(typeof message?.id==='string'){
        const job=pending.get(message.id);if(!job)return;
        clearTimeout(job.timer);pending.delete(message.id);message.ok===true?job.resolve():job.reject(Error(message.error||'Reset failed.'));
      }
    });
  }
  connect();
  return {
    clear(confirmation:string):Promise<void>{
      if(confirmation!=='CLEAR')return Promise.reject(Error('Type exactly CLEAR to delete all Miter application data.'));
      if(closed||!port)return Promise.reject(Error('The reset coordinator is reconnecting. Wait for the connection, then retry.'));
      if(pending.size)return Promise.reject(Error('A reset request is already waiting for confirmation.'));
      return new Promise((resolve,reject)=>{
        const id=crypto.randomUUID();
        // Native preparation, browser cleanup and commit have their own bounded
        // deadlines. Do not declare a UI timeout while those phases can run.
        const timer=setTimeout(()=>{pending.delete(id);reject(Error('No complete reset acknowledgement. Reopen Miter and retry; it stays locked.'));},600000);
        pending.set(id,{resolve,reject,timer});
        try{port!.postMessage({type:'reset-start',id,confirmation});}
        catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
      });
    },
    close(){
      closed=true;for(const timer of [retryTimer,readyTimer,reloadTimer])if(timer)clearTimeout(timer);
      rejectPending('The Miter view closed before a complete reset acknowledgement.');
      try{restoreMarker();}catch{}
      const old=port;port=undefined;try{old?.disconnect();}catch{/* Chrome may have already closed the port. */}
    },
  };
}
