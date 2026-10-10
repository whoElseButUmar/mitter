import { chatDom, clearChatDomState, ASSISTANT_READER_VERSION } from './chat-dom.js';

/** Included in the generated, packaged mitter-page.js; not a page MAIN-world script. */
export function installPageEndpoint(runtime:any):void {
  const version='mitter-page/4';
  const scope=globalThis as typeof globalThis & {[key:string]:any};
  const key='__mitterPageEndpointV4';
  for(const oldKey of ['__mitterPageEndpointV3',key]){
    if(scope[oldKey])try{runtime.onMessage.removeListener(scope[oldKey].listener);}catch{}
  }
  const previous=scope.__mitterSessionV4;
  if(previous){
    // Retire in-flight work by object identity without turning a lost listener
    // into a user Stop. Preserve the token and committed-send ledger so reads
    // can reconnect and a retried commit cannot click Send twice. An actual
    // user/page Stop stays stopped; reinjection never resumes it.
    const stopped=previous.stopped===true;
    previous.stopped=true;
    scope.__mitterSessionV4={...previous,stopped};
  }
  if(scope.__mitterSessionV3)scope.__mitterSessionV3.stopped=true;
  const instanceId=crypto.randomUUID();
  const pending=new Map<string,{body:string;promise:Promise<unknown>}>();
  const inFlight=new Set<Promise<unknown>>();
  let retired=false;
  let mutation:Promise<unknown>|undefined;
  const listener=(message:any,sender:any,respond:(reply:unknown)=>void)=>{
    if(sender.id!==runtime.id||sender.tab||message?.channel!==version)return false;
    if(typeof message.id!=='string'||message.id.length>100)return false;
    const header={channel:version,id:message.id,instanceId};
    if(message.kind==='reset'&&message.confirmation==='CLEAR'){
      retired=true;clearChatDomState();
      void Promise.allSettled([...inFlight]).then(()=>{
        pending.clear();inFlight.clear();mutation=undefined;clearChatDomState();
        runtime.onMessage.removeListener(listener);delete scope[key];
        respond({...header,ok:true,value:{cleared:true}});
      });return true;
    }
    if(retired){respond({...header,ok:false,error:{code:'RESET',message:'Miter data was reset.'}});return false;}
    if(message.kind==='hello'){
      respond({...header,ok:true,value:{version,reader:ASSISTANT_READER_VERSION,instanceId,url:location.origin+location.pathname,readyState:document.readyState}});return false;
    }
    const action=message.action;
    if(message.kind!=='request'||!action||!['control','probe','reply','inspect','prepare','commit','send','stop','interrupt'].includes(action.op)||typeof action.token!=='string'||action.token.length>100||action.composerSession!==undefined&&(typeof action.composerSession!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(action.composerSession))||typeof action.url!=='string'||typeof action.expiresAt!=='number'||!Number.isFinite(action.expiresAt)){
      respond({...header,ok:false,error:{code:'BAD_REQUEST',message:'Invalid page bridge request.'}});return false;
    }
    const body=JSON.stringify(action),found=pending.get(message.id);
    if(found&&found.body!==body){respond({...header,ok:false,error:{code:'ID_CONFLICT',message:'Request ID reused with a different operation.'}});return false;}
    const perform=async()=>{
      try{
        if(action.op==='prepare'||action.op==='commit'||action.op==='send'){
          if(mutation)throw Object.assign(new Error('Another task is changing the composer.'),{code:'COMPOSER_BUSY'});
          const job=chatDom(action);mutation=job;
          try{return {...header,ok:true,value:await job};}finally{if(mutation===job)mutation=undefined;}
        }
        return {...header,ok:true,value:await chatDom(action)};
      }catch(error){
        const e=error as {code?:unknown;message?:unknown};
        return {...header,ok:false,error:{code:typeof e?.code==='string'?e.code:'PAGE_OPERATION_FAILED',message:typeof e?.message==='string'?e.message:'The page operation failed.'}};
      }
    };
    const promise=found?.promise||perform();
    if(!found){inFlight.add(promise);void promise.finally(()=>inFlight.delete(promise)).catch(()=>{});pending.set(message.id,{body,promise});while(pending.size>24)pending.delete(pending.keys().next().value!);}
    void promise.then(respond).catch(()=>{});
    // Always use sendResponse + literal true. Works on Chrome versions where
    // async onMessage listeners do not forward their returned Promise.
    return true;
  };
  runtime.onMessage.addListener(listener);
  scope[key]={runtimeId:runtime.id,version,listener};
}
