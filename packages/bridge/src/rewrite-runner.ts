import {PageBridgeError} from './page-transport.js';
import {rewritePrompt,parseRewriteReply,type RewriteRequest} from '../../protocol/src/rewrite.js';
import {conversationURL} from './index.js';
import {sameMessage} from './message-wire.js';
import type {ChatView,DomRequest} from './chat-dom.js';
export interface RewriteResult {id:string;state:'waiting'|'done'|'error'|'cancelled';text?:string;error?:string;tabId:number;at:number}
/** Independent composer-only job. It has NO host RPC/worker/action executor. */
export class RewriteRunner {
 readonly result:RewriteResult;private token=crypto.randomUUID();private cancelled=false;private route='https://chatgpt.com';private committed=false;
 constructor(readonly id:string,readonly tabId:number,private input:RewriteRequest,private page:(id:number,r:DomRequest)=>Promise<ChatView>,private now=Date.now,private wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))){this.result={id,tabId,state:'waiting',at:now()};}
 private check(){if(this.cancelled)throw Error('Rewrite cancelled.');if(this.now()-this.result.at>180000)throw Error('The rewrite timed out. Your original draft is unchanged.');}
 private async call(op:DomRequest['op'],text?:string,messageId?:string,composerSession?:string){this.check();const v=await this.page(this.tabId,{op,token:this.token,url:this.route,text,messageId,composerSession,expiresAt:this.result.at+180000,allowConversationBind:this.committed&&!this.route.includes('/c/')});this.check();if(v.stopped)throw Error('Rewrite paused from the chat page.');if(this.route.includes('/c/')&&v.url!==this.route)throw Error('The rewrite tab changed conversation.');return v;}
 private execution?:Promise<void>;
 run():Promise<void>{return this.execution??=this.execute();}
 async settled():Promise<void>{await this.execution;}
 private async execute():Promise<void>{
  try{
   let v=await this.call('probe');while(v.ready===false){await this.wait(500);v=await this.call('probe');}
   if(v.busy||v.draft||v.count>0)throw Error('The new rewrite chat is not empty. No draft was overwritten.');
   const prompt=rewritePrompt(this.input,this.id),mid=crypto.randomUUID();
   while(true){
    try{v=await this.call('prepare',prompt,mid);if(v.outcome!=='pending')break;}
    catch(e){if(!(e instanceof PageBridgeError&&(e.transient||['COMPOSER_BUSY','COMPOSER_MISSING','EDITOR_REPLACED','BUSY','INSERT_REJECTED'].includes(e.code))))throw e;}
    await this.wait(1200);this.check();
   }
   if(!['prepared','already_sent','already_clicked'].includes(v.outcome||''))throw Error('The rewrite draft could not be prepared.');
   this.committed=true;
   if(v.outcome==='prepared')while(true){
    try{const sent=await this.call('commit',prompt,mid,v.composerSession);if(sent.outcome!=='pending')break;}
    catch(e){
     if(this.cancelled)throw e;
     if(!(e instanceof PageBridgeError)||e.code==='COMMIT_DOCUMENT_CHANGED')break; // unknown outcome: inspect only
     if(!(e instanceof PageBridgeError&&(e.transient||['COMPOSER_BUSY','BUSY','SEND_NOT_READY'].includes(e.code))))throw e;
     // No document-local proof means a lost acknowledgement is read-only.
     if(!v.composerSession)break;
    }
    await this.wait(1200);this.check();
   }
   let candidate='',stableAt=0;
   while(true){await this.wait(1200);v=await this.call('inspect');if(v.draft){
     // React may clear the submitted composer after the click acknowledgement.
     // Wait read-only for our exact text; a different draft is still a barrier.
     if(sameMessage(v.draftText,prompt)){candidate='';stableAt=0;continue;}
     throw Error('A draft appeared in the rewrite chat. Nothing was overwritten.');
    }
    if(v.lastUserText&&!sameMessage(v.lastUserText,prompt)&&!sameMessage(v.lastUserText,'text\n'+prompt))throw Error('The rewrite chat contains a different user message.');
    if(!this.route.includes('/c/'))try{this.route=conversationURL(v.url);}catch{}
    if(v.busy||!v.complete||v.assistantReadIssue||!v.assistantText){candidate='';continue;}
    if(candidate!==v.assistantText){candidate=v.assistantText;stableAt=this.now();continue;}
    if(this.now()-stableAt<1800)continue;
    this.result.text=parseRewriteReply(candidate,this.id);this.result.state='done';break;
   }
  }catch(e){this.result.state=this.cancelled?'cancelled':'error';this.result.error=e instanceof Error?e.message:String(e);}
  finally{try{await this.page(this.tabId,{op:'stop',token:this.token,url:this.route,expiresAt:this.now()+10000});}catch{}}
 }
 cancel(){this.cancelled=true;this.result.state='cancelled';void this.page(this.tabId,{op:'stop',token:this.token,url:this.route,expiresAt:this.now()+10000}).catch(()=>{});}
}
