import { ASSISTANT_READER_VERSION, type ChatView, type DomRequest } from './chat-dom.js';
import { exceedsHandoffBytes } from '../../protocol/src/reply-json.js';
export const PAGE_CHANNEL='mitter-page/4';
export const PAGE_READER=ASSISTANT_READER_VERSION;
export class PageBridgeError extends Error {
  constructor(readonly code:string,message:string,readonly transient=false){super(message);this.name='PageBridgeError';}
}
export interface PageAPI {
  send(tabId:number,message:unknown):Promise<unknown>;
  inject(tabId:number):Promise<void>;
  checkAvailable?(tabId:number):Promise<void>;
}
type Reply={channel:string;id:string;instanceId:string;ok:boolean;value?:any;error?:{code:string;message:string}};
/** Transport exchanges JSON through runtime messaging. Injection only installs
 * a file; its result is never confused with a DOM operation's return value. */
export class PageTransport {
  private attached=new Set<number>();
  private generations=new Map<number,number>();
  private attaching=new Map<number,Promise<void>>();
  constructor(private api:PageAPI,private log:(kind:string,message:string)=>void,private timeoutMs=18000){}
  private async bounded<T>(task:Promise<T>,ms=this.timeoutMs):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PageBridgeError('BRIDGE_TIMEOUT','The chat page did not answer the bridge request.',true)),ms);})]);}finally{if(timer)clearTimeout(timer);}
  }
  private async exchange(tabId:number,kind:string,action?:DomRequest):Promise<any>{
    const id=crypto.randomUUID();let raw:unknown;
    try{// Reads and handshakes must not hold the coordinator behind a dead tab
      // for the much longer composer/Send readiness deadline. A read timeout
      // can reconnect; a mutation timeout is still ambiguous and never replayed.
      const timeout=kind==='hello'?Math.min(this.timeoutMs,3000):
        action&&['control','inspect','probe','reply'].includes(action.op)?Math.min(this.timeoutMs,6000):this.timeoutMs;
      raw=await this.bounded(this.api.send(tabId,{channel:PAGE_CHANNEL,id,kind,...(action?{action}:{})}),timeout);}
    catch(error){if(error instanceof PageBridgeError)throw error;throw new PageBridgeError('BRIDGE_DISCONNECTED',error instanceof Error?error.message:'Could not reach the chat page.',true);}
    const reply=raw as Reply|undefined;
    if(!reply||reply.channel!==PAGE_CHANNEL||reply.id!==id||typeof reply.ok!=='boolean'||typeof reply.instanceId!=='string')throw new PageBridgeError('INVALID_BRIDGE_REPLY','The page bridge returned an invalid response. No action result was accepted.',true);
    if(!reply.ok)throw new PageBridgeError(reply.error?.code||'PAGE_ERROR',reply.error?.message||'A page operation failed.');
    return reply.value;
  }
  async ensure(tabId:number):Promise<void>{
    if(this.attached.has(tabId))return;
    const current=this.attaching.get(tabId);if(current)return current;
    const generation=this.generations.get(tabId)??0;
    const checkGeneration=()=>{if((this.generations.get(tabId)??0)!==generation)throw new PageBridgeError('BRIDGE_NAVIGATED','The chat document changed during connection. Rechecking without repeating Send.',true);};
    const job=(async()=>{
      const handshake=async()=>{
        const value=await this.exchange(tabId,'hello');
        if(value?.version!==PAGE_CHANNEL||value?.reader!==PAGE_READER){
          this.log('bridge.upgrade','Refreshing an older or incompatible page reader. No message is being resent.');
          throw new PageBridgeError('STALE_PAGE_READER','The chat page is using an older reader. The packaged reader must be installed before continuing.',true);
        }
      };
      try{await handshake();}
      catch{
        checkGeneration();
        this.log('bridge.attach',`Installing packaged bridge in tab ${tabId}.`);
        try{await this.bounded(this.api.inject(tabId),Math.min(this.timeoutMs,6000));}
        catch(error){checkGeneration();throw new PageBridgeError('BRIDGE_INJECTION_FAILED',error instanceof Error?error.message:'Chrome refused page access.',true);}
        checkGeneration();await handshake();
      }
      checkGeneration();
      this.attached.add(tabId);this.log('bridge.ready',`Page handshake confirmed in tab ${tabId}; ${PAGE_CHANNEL}; reader=${PAGE_READER}.`);
    })();
    this.attaching.set(tabId,job);try{await job;}finally{if(this.attaching.get(tabId)===job)this.attaching.delete(tabId);}
  }
  forget(tabId:number):void{this.attached.delete(tabId);this.attaching.delete(tabId);this.generations.set(tabId,(this.generations.get(tabId)??0)+1);}
  async request(tabId:number,action:DomRequest):Promise<ChatView>{
    // Sending is never replayed after an ambiguous transport result. Only reads
    // can reconnect/retry. The runner observes message acknowledgement separately.
    const attempts=['control','inspect','probe','reply'].includes(action.op)?2:1;
    for(let attempt=0;attempt<attempts;attempt++){
      try{
        if(!['stop','interrupt'].includes(action.op)&&this.api.checkAvailable){
          try{await this.bounded(this.api.checkAvailable(tabId),Math.min(this.timeoutMs,3000));}
          catch(error){if(error instanceof PageBridgeError)throw error;throw new PageBridgeError('BRIDGE_DISCONNECTED','Could not check the linked chat’s browser state: '+String(error),true);}
        }
        await this.ensure(tabId);
        const generation=this.generations.get(tabId)??0;
        const value=await this.exchange(tabId,'request',action);
        if((this.generations.get(tabId)??0)!==generation)throw new PageBridgeError('BRIDGE_NAVIGATED','The chat document changed while answering. Its old response was ignored; Send was not repeated.',true);
        if(!value||!['url','assistantId','assistantText','lastUserText','lastRole','draftText'].every(key=>typeof value[key]==='string')||!['draft','busy','complete','stopped'].every(key=>typeof value[key]==='boolean')||!['count','userCount'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)||value.ready!==undefined&&typeof value.ready!=='boolean'||value.lastUserTruncated!==undefined&&typeof value.lastUserTruncated!=='boolean'||value.lastUserCollapsed!==undefined&&typeof value.lastUserCollapsed!=='boolean'||value.disclosure!==undefined&&(!value.disclosure||!['none','available','expanded','pending','unavailable','ambiguous'].includes(value.disclosure.state)||!Number.isSafeInteger(value.disclosure.attempts)||value.disclosure.attempts<0||value.disclosure.attempts>3)||value.userIds!==undefined&&(!Array.isArray(value.userIds)||value.userIds.length>256||value.userIds.some((id:unknown)=>typeof id!=='string'||id.length>200)))throw new PageBridgeError('INVALID_PAGE_STATE','The page adapter returned incomplete state.',true);
        if(['prepare','commit','send'].includes(action.op)&&value.outcome===undefined)throw new PageBridgeError('INVALID_PAGE_STATE','The composer operation returned no outcome. No send acknowledgement was accepted.',true);
        if(value.composerSession!==undefined&&(typeof value.composerSession!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(value.composerSession))||value.outcome!==undefined&&!['pending','prepared','clicked','already_clicked','already_sent'].includes(value.outcome)||value.visibility!==undefined&&!['visible','hidden','prerender'].includes(value.visibility))throw new PageBridgeError('INVALID_PAGE_STATE','Invalid composer receipt or page lifecycle state.',true);
        if(value.transcript!==undefined){
          const t=value.transcript;
          if(!t||!['message-discovery/1','message-discovery/2'].includes(t.version)||!['ready','empty','unrecognized','partial'].includes(t.state)||
             !['roleAttributes','alternativeRoles','semanticRoles','turnContainers','unknownTurns','users','assistants','codeBlocks','openShadowRoots','frames'].every(key=>Number.isSafeInteger(t[key])&&t[key]>=0&&t[key]<=24000)||
             typeof t.scanLimited!=='boolean'||typeof t.unclassifiedTail!=='boolean')throw new PageBridgeError('INVALID_PAGE_STATE','The message reader returned invalid structural diagnostics. No reply was accepted.',true);
        }
        if(value.transcript?.receiptDiscovery!==undefined){
          const r=value.transcript.receiptDiscovery;
          if(value.transcript.version!=='message-discovery/2'||value.transcript.strategy!=='receipt'||!r||
             !['searching','missing','mismatch','ambiguous','collapsed','matched','waiting_reply','unknown_tail','limit'].includes(r.state)||
             !['candidates','matches','tailBranches','responseControls'].every(key=>Number.isSafeInteger(r[key])&&r[key]>=0&&r[key]<=24000))
            throw new PageBridgeError('INVALID_PAGE_STATE','Invalid receipt discovery diagnostics. No reply was accepted.',true);
        }
        if(value.transcript?.codeAncestry!==undefined){
          const ancestry=value.transcript.codeAncestry;
          if(!Array.isArray(ancestry)||ancestry.length>2||ancestry.some(chain=>!Array.isArray(chain)||chain.length>7||chain.some(node=>
            !node||typeof node.tag!=='string'||! /^[a-z][a-z0-9-]{0,40}$/.test(node.tag)||!Array.isArray(node.attributes)||node.attributes.length>12||
            node.attributes.some((a:unknown)=>typeof a!=='string'||! /^[a-z][a-z0-9-]{0,64}$/.test(a)))))
            throw new PageBridgeError('INVALID_PAGE_STATE','Invalid reader shape diagnostics. No reply was accepted.',true);
        }
        if(value.codeRead!==undefined){const r=value.codeRead;if(!r||!Number.isSafeInteger(r.characters)||r.characters<0||r.characters>400001||typeof r.fingerprint!=='string'||!/^[0-9a-f]{1,8}$/.test(r.fingerprint)||typeof r.issue!=='string'||r.issue.length>64)throw new PageBridgeError('INVALID_PAGE_STATE','Invalid code-read diagnostics.',true);}
        for(const c of [value.codeReply,value.unlinkedReply]){
          if(c===undefined)continue;
          if(!c||typeof c.text!=='string'||exceedsHandoffBytes(c.text)||!['id','workerId','projectId'].every(key=>typeof c[key]==='string'&&c[key].length<=100)||c.replyTo!==undefined&&(typeof c.replyTo!=='string'||c.replyTo.length>100)||typeof c.hasCopyControl!=='boolean')throw new PageBridgeError('INVALID_PAGE_STATE','Invalid code reply candidate.',true);
        }
        if(value.codeReplyIds!==undefined&&(!Array.isArray(value.codeReplyIds)||value.codeReplyIds.length>64||value.codeReplyIds.some((id:unknown)=>typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(id))))throw new PageBridgeError('INVALID_PAGE_STATE','Invalid code reply baseline.',true);
        if(value.codeReplyTotal!==undefined&&(!Number.isSafeInteger(value.codeReplyTotal)||value.codeReplyTotal<0||value.codeReplyTotal>65))throw new PageBridgeError('INVALID_PAGE_STATE','Invalid code reply count.',true);
        return value;
      }catch(error){
        const e=error instanceof PageBridgeError?error:new PageBridgeError('PAGE_ERROR',String(error));
        this.log('bridge.page.error',`${action.op} / ${e.code}: ${e.message}`);
        if(e.transient&&!['BRIDGE_NAVIGATED','TAB_FROZEN','TAB_DISCARDED'].includes(e.code))this.forget(tabId);
        if(!e.transient||attempt+1===attempts)throw e;
      }
    }
    throw new PageBridgeError('BRIDGE_DISCONNECTED','The page bridge could not reconnect.',true);
  }
}
