import {ReplyGapTracker,REPLY_GAP_IDLE_MS,hasEmptyResponseTail,type ReplyGapObservation} from './reply-gap.js';
import {isHistoricalReply,isReplyFragment} from './reply-window.js';
import { NativeRequestTimeout } from './native-request.js';
import { isReadOnlyReply, isIncompleteReplyJSON } from '../../protocol/src/reply-json.js';
import { boundReply, replyDigest, replyHeaders } from './reply-recovery.js';
import { parseProposalEnvelope as parseEnvelope } from '../../protocol/src/proposal.js';
import {ReplyValidationError,correctionAdvice,type ReplyIssue} from '../../protocol/src/validation.js';
import type { Snapshot, Worker } from '../../protocol/src/index.js';
import { ASSISTANT_READER_VERSION, type ChatView, type DomRequest } from './chat-dom.js';
import { PageBridgeError } from './page-transport.js';
import {parseTaskProgress,type TaskProgress} from './progress.js';
import { messagePayload, wrapMessage, unwrapMessage, sameMessage, messageDigest, parseReceipt, matchesReceipt, type OutboundReceipt } from './message-wire.js';
export interface BridgeStatus {receiving?:boolean;monitoring?:boolean;watchUntil?:number;workerId:string;tabId:number;url:string;active:boolean;phase:string;reason:string;turns:number;maxTurns:number;startedAt:number;errorCode?:string;bindingPending?:boolean;lowerBound?:boolean;activeMs?:number;maxMinutes?:number}
export interface BridgeOptions {workerId:string;projectId:string;tabId:number;url:string;maxTurns:number;maxMinutes:number;token:string;newChat?:boolean;resumeExisting?:boolean;lastReceipt?:OutboundReceipt;previousProgress?:{turns:number;maxTurns:number;lowerBound:boolean;startedAt:number;activeMs:number;maxMinutes:number}}
export interface BridgeDependencies {
  rpc<T=unknown>(method:string,params:Record<string,unknown>):Promise<T>;
  page(tabId:number,request:DomRequest):Promise<ChatView>;
  snapshot():Snapshot|undefined;
  publish(status:BridgeStatus):void;
  log(kind:string,message:string):void;
  saveReceipt?(receipt:OutboundReceipt):Promise<void>;
  loadProgress?():Promise<{progress:TaskProgress|null;importedCount:number}>;
  saveProgress?(progress:TaskProgress,epoch?:number):Promise<TaskProgress>;
  now?():number;
}
const supportedOrigins=new Set(['https://chatgpt.com','https://chat.openai.com']);
export function conversationURL(raw:string):string {
  const u=new URL(raw);
  if(!supportedOrigins.has(u.origin)||!/^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+\/?$/.test(u.pathname))throw new Error('Choose a ChatGPT conversation, or let Mitter open a new one.');
  return u.origin+u.pathname.replace(/\/$/,'');
}
export function chatStartURL(raw:string,allowNewChat=false):string {
  try{return conversationURL(raw);}catch(e){const u=new URL(raw);if(allowNewChat&&supportedOrigins.has(u.origin)&&(u.pathname==='/'||u.pathname===''))return u.origin;throw e;}
}
const norm=(s:string)=>s.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').trim();
/** Absolute read-only deadline for watching a pending exchange after a receive
 * failure. One value schedules and checks the deadline; it is not renewed by
 * polling. */
export const LATE_REPLY_WATCH_MS=15*60_000;
/** An older Mitter build may have emitted a different bootstrap template. Match
 * its task envelope and verbatim goal, not the version-dependent whole prompt. */
export function isTaskBootstrap(text:string,w:Pick<Worker,'id'|'projectId'|'goal'>):boolean {
  text=messagePayload(text);
  if(!text.startsWith('You are collaborating with Mitter,')||!text.includes('GOAL: '+w.goal+'\n'))return false;
  const field=(key:string,value:string)=>new RegExp('"'+key+'"\\s*:\\s*"'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"').test(text);
  return field('protocol','mitter/1')&&field('workerId',w.id)&&field('projectId',w.projectId)&&text.includes('For THIS ChatGPT handoff');
}
const inFlight=new Set(['queued','planning','waiting_model','waiting_lock','executing','verifying']);
export class BridgeRunner {
  readonly status:BridgeStatus;
  private busy=false;
  private expectedUser='';
  private expectedRenderedUser='';
  private userCount=0;
  private baseline=0;
  private acknowledged=false;
  private expectedUserId='';
  private adoptedAssistantReceipt='';
  private priorUserIds=new Set<string>();
  private userObservation='';
  private conflictSince=0;
  private visibilitySince:number|undefined;
  private generationSeenAt:number|undefined;
  private lastUserDiagnostic='';
  private lastDisclosureDiagnostic='';
  private userBefore='';
  private userIdBefore='';
  private assistantBefore='';
  private assistantTextBefore='';
  private sentAt=0;
  private candidate='';
  private stableSince=0;
  private repeats=0;
  private pendingConversationBind:boolean;
  private prompt='';
  private nextPrompt='';
  private recoverySince:number|undefined;
  private recoveryPhase='connecting';
  private formatRepairs=0;
  private lastReadObservation='';
  private lastDirectObservation='';
  private lastCodeDiagnostic='';
  private unlinkedCandidate='';
  private unlinkedSince=0;
  private unlinkedWaitSince:number|undefined;
  private readonly bootstrapOrigin:string;
  private lastObservedURL='';
  private lastTranscriptDiagnostic='';
  private unreadableSince:number|undefined;
  private pinnedConversation='';
  private sendAttempted=false;
  private pendingSend?:{text:string;messageId:string;startedAt:number;commitIntent:boolean;composerSession?:string};
  private lastSendReadiness='';
  private localPauseCheck?:Promise<void>;
  private pendingDelivery?:{envelope:ReturnType<typeof parseEnvelope>;hash:string;imported:boolean;failures:number;retryAt:number};
  private readonly now:()=>number;
  private expiresAt:number;
  private progress?:TaskProgress;
  private activeBase=0;
  private resumedAt=0;
  private finishedAt?:number;
  private writes:Promise<void>=Promise.resolve();
  private checkpointError:unknown;
  private lastSavedShape='';
  private lastSavedAt=0;
  private lastActionsHash='';
  private restoringPendingSend=false;
  private executionEpoch=0;
  private operationDone?:()=>void;
  private operationIdle:Promise<void>=Promise.resolve();
  private watchCandidate='';
  private watchStableAt=0;
  private watchPollAt=0;
  private watchRunning=false;
  private watchRetryAt=0;
  private watchFailures=0;
  private watchErrorCode='';
  private watchReason='';
  private replyGap=new ReplyGapTracker();
  private gapObservation:ReplyGapObservation={missing:false,elapsedMs:0,started:false};
  private gapLogged='';
  private waitObservation='';
  private waitUnchangedAt=0;
  constructor(private options:BridgeOptions,private deps:BridgeDependencies) {
    // Automatic turns are capped lower than the host's worker loop (see
    // service.ts) because each automatic turn is a heavyweight browser handoff;
    // manual/continue use keeps the host's own bounds.
    if(!Number.isInteger(options.maxTurns)||options.maxTurns<1||options.maxTurns>20)throw new Error('Automatic mode supports 1–20 turns.');
    if(!Number.isInteger(options.maxMinutes)||options.maxMinutes<1||options.maxMinutes>60)throw new Error('Automatic mode supports 1–60 minutes.');
    this.now=deps.now||Date.now;this.expiresAt=this.now()+options.maxMinutes*60000;
    this.pendingConversationBind=options.newChat===true;
    this.bootstrapOrigin=new URL(options.url).origin;
    this.status={bindingPending:this.pendingConversationBind,workerId:options.workerId,tabId:options.tabId,url:chatStartURL(options.url,this.pendingConversationBind),active:true,phase:'connecting',reason:'Connecting to ChatGPT…',turns:options.previousProgress?.turns??0,maxTurns:options.previousProgress?.maxTurns??options.maxTurns,startedAt:options.previousProgress?.startedAt??this.now(),lowerBound:options.previousProgress?.lowerBound,activeMs:options.previousProgress?.activeMs,maxMinutes:options.previousProgress?.maxMinutes};
  }
  private async restoreProgress():Promise<void> {
    if(this.progress)return;
    const w=this.worker();this.executionEpoch=w.control?.epoch??0;
    if(w.control?.mode==='stopped')throw new PageBridgeError('TASK_STOPPED','Task stopped. Use Continue fresh; completed files and history are kept.');
    const loaded=this.deps.loadProgress?await this.deps.loadProgress():{progress:null,importedCount:0};
    const goalHash=await messageDigest(w.goal),raw=loaded.progress;
    let p=raw?parseTaskProgress(raw):undefined;
    if(raw&&!p)throw new PageBridgeError('PROGRESS_VERSION','Saved task progress is not compatible. It was not reset.');
    if(p&&(p.workerId!==w.id||p.projectId!==w.projectId||p.goalHash!==goalHash))throw new PageBridgeError('PROGRESS_BINDING','Saved progress belongs to a different task or goal.');
    if(!p){
      const oldReceipt=w.control?undefined:parseReceipt(this.options.lastReceipt);
      const receipt=oldReceipt?.workerId===w.id&&oldReceipt.projectId===w.projectId&&oldReceipt.goalHash===goalHash?oldReceipt:undefined;
      const known=Math.max(0,loaded.importedCount,receipt?.turn??0);
      p={version:1,revision:0,workerId:w.id,projectId:w.projectId,goalHash,turns:known,maxTurns:Math.max(known,this.options.maxTurns),
        lowerBound:!!known||this.options.resumeExisting===true,activeMs:0,maxMinutes:this.options.maxMinutes,startedAt:this.now(),updatedAt:this.now(),
        stage:w.control?.mode==='fresh'?'report_due':receipt?'waiting_reply':'ready',lastReceipt:receipt,repeats:0,formatRepairs:0,phase:'stopped',reason:'Progress recovered.'};
      if(p.lowerBound)this.deps.log('bridge.migrate','Recovered legacy task history. Earlier unrecorded sends cannot be counted exactly; the displayed total is a known minimum.');
    }
    // A user may temporarily run an older release, which updates the legacy
    // browser receipt but knows nothing about this KV schema. Retain counters
    // and prefer a newer, fully task-bound receipt; never roll history back.
    const browserReceipt=w.control?undefined:parseReceipt(this.options.lastReceipt);
    if(browserReceipt&&browserReceipt.workerId===w.id&&browserReceipt.projectId===w.projectId&&browserReceipt.goalHash===goalHash&&browserReceipt.at>(p.lastReceipt?.at??-1)){
      p.lastReceipt=browserReceipt;p.stage='waiting_reply';p.lowerBound=true;
      p.turns=Math.max(p.turns,browserReceipt.turn??0);
    }
    if(loaded.importedCount>p.turns){p.turns=loaded.importedCount;p.lowerBound=true;}
    // Import and progress acknowledgement cross two process boundaries. A
    // crash/lost response after the host accepted a batch must not strand its
    // queue or cause a fresh model send. Recover ONLY the exact accepted head
    // linked to this saved exchange (or the explicit selected-reply receipt).
    const head=w.queue[0];
    if(head&&p.stage!=='local_batch'&&['waiting_reply','commit_intent'].includes(p.stage)&&
       head.workerId===w.id&&head.projectId===w.projectId&&
       ((!!head.replyTo&&head.replyTo===p.lastReceipt?.exchangeId)||head.id===p.approvedReply?.id)) {
      const owned=await this.deps.rpc<{seen:boolean}>('worker.handoffSeen',{workerId:w.id,envelopeId:head.id});
      if(owned.seen){
        p.lastImportedId=head.id;p.stage='local_batch';
        this.deps.log('bridge.reconcile','Recovered the host-accepted batch after a lost import acknowledgement. No action or Send was replayed.');
      }
    }
    this.progress=p;
    if(p.conversationUrl){this.pinnedConversation=p.conversationUrl;this.status.url=p.conversationUrl;}
    this.resumedAt=this.now();this.activeBase=p.activeMs;
    this.options.lastReceipt=p.lastReceipt??(w.control?undefined:this.options.lastReceipt);
    this.status.turns=p.turns;this.status.maxTurns=p.maxTurns;this.status.lowerBound=p.lowerBound;this.status.startedAt=p.startedAt;
    this.status.activeMs=p.activeMs;this.status.maxMinutes=p.maxMinutes;
    this.lastActionsHash=p.lastActionsHash||'';this.repeats=p.repeats;this.formatRepairs=p.formatRepairs;
    this.expiresAt=this.now()+Math.max(0,p.maxMinutes*60000-p.activeMs);
    await this.checkpoint();
  }
  /** Serialized durable boundary. Host CAS rejects stale writers; save before
   * Send/import/next-turn transitions, never recreate a counter on Resume. */
  private async checkpoint(stage?:TaskProgress['stage'],force=true):Promise<void> {
    if(!this.progress)return;
    if(stage)this.progress.stage=stage;
    this.writes=this.writes.then(async()=>{
      const p=this.progress!;
      const value:TaskProgress={...p,turns:this.status.turns,maxTurns:this.status.maxTurns,lowerBound:!!this.status.lowerBound,
        activeMs:Math.max(p.activeMs,this.activeBase+Math.max(0,(this.finishedAt??this.now())-this.resumedAt)),
        lastReceipt:parseReceipt(this.options.lastReceipt),repeats:this.repeats,formatRepairs:this.formatRepairs,
        lastActionsHash:this.lastActionsHash||undefined,phase:this.status.phase,reason:this.status.reason,errorCode:this.status.errorCode,updatedAt:this.now()};
      const {revision:_revision,activeMs:_activeMs,updatedAt:_updatedAt,...meaningful}=value;
      const shape=JSON.stringify(meaningful);
      // Every send/import/control boundary remains immediate. Unchanged polling
      // only needs a five-second heartbeat, not a FULL SQLite fsync + broadcast
      // to every view on every timer tick. Stop always saves the exact elapsed
      // time; abrupt failure can retain only the last completed idle heartbeat.
      if(!force&&shape===this.lastSavedShape&&this.now()-this.lastSavedAt<5000){
        this.status.activeMs=value.activeMs;return;
      }
      this.progress=this.deps.saveProgress?await this.deps.saveProgress(value,this.executionEpoch):value;
      this.lastSavedShape=shape;this.lastSavedAt=this.now();
      this.status.activeMs=this.progress.activeMs;this.checkpointError=undefined;
    }).catch(error=>{this.checkpointError=error;});
    await this.writes;
    if(this.checkpointError)throw new PageBridgeError('PROGRESS_SAVE_FAILED','Task progress could not be saved. No further action will run. '+message(this.checkpointError));
  }
  async flushed():Promise<void>{await this.writes;}
  async settled():Promise<void>{await this.operationIdle;await this.writes;}
  async interruptGeneration():Promise<void>{
    try{const view=await this.page('interrupt');this.deps.log('bridge.interrupt','Chat generation: '+(view.interruptOutcome||'not confirmed')+'. No user draft was altered.');}
    catch(e){this.deps.log('bridge.interrupt',message(e)+' Local work is still stopped.');}
  }
  private update(phase:string,reason:string){
    if(this.status.phase!==phase||this.status.reason!==reason)this.deps.log('bridge.phase',`[${this.options.workerId.slice(0,8)}] ${phase}: ${reason}`);
    this.status.phase=phase;this.status.reason=reason;this.deps.publish({...this.status});
  }
  private worker():Worker {const w=this.deps.snapshot()?.workers.find(w=>w.id===this.options.workerId);if(!w||w.projectId!==this.options.projectId)throw new Error('Worker or project binding changed.');return w;}
  private matchesExpected(text:string){return !!this.expectedUser&&sameMessage(text,this.expectedUser)||!!this.expectedRenderedUser&&sameMessage(text,this.expectedRenderedUser);}
  private check(){if(this.worker().control?.mode==='stopped'||(this.worker().control?.epoch??0)!==this.executionEpoch)throw new PageBridgeError('RUN_SUPERSEDED','This execution plan was stopped or replaced. No further action will run.');if(!this.status.active)throw new Error('Session stopped.');if(this.now()>=this.expiresAt)throw new PageBridgeError('TIME_LIMIT','The task’s active-time limit is reached. Progress is saved; add more time to continue.');}
  private replyFingerprint(view:ChatView):string {
    // Rendering can settle without changing text. A changed extraction status
    // must receive the same stability window as changed reply text.
    return [view.assistantId,view.assistantFormat||'',view.assistantReadIssue||'',view.assistantText].join('\n');
  }
  private logReadShape(view:ChatView):void {
    const stats=view.assistantReadStats;if(!stats)return;
    const n=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?Math.min(value,10000000):0;
    const lengths=Array.isArray(stats.payloadCharacters)?stats.payloadCharacters.slice(0,8).map(n):[];
    const issue=['MULTIPLE_BLOCKS','EXTRA_CONTENT','MARKDOWN_TRANSFORMED','CODE_NOT_VISIBLE','EMPTY_CODE_BLOCK','PLAIN_STRING_LAYOUT','PLAIN_HIDDEN_CONTENT','PAYLOAD_TOO_LARGE'].includes(view.assistantReadIssue||'')?view.assistantReadIssue:'none';
    const shape=`reader=${ASSISTANT_READER_VERSION}; pre=${n(stats.preElements)}; visible=${n(stats.visiblePreElements)}; wrappers=${n(stats.nestedWrappers)}; hidden=${n(stats.ignoredHiddenBlocks)}; empty=${n(stats.emptyBlocks)}; payloads=${n(stats.logicalBlocks)}; sizes=${lengths.join(',')}; issue=${issue}.`;
    const key=view.assistantId+'\n'+shape;
    if(key!==this.lastReadObservation){this.lastReadObservation=key;this.deps.log('bridge.reply.structure',shape);}
  }
  private parseReply(view:ChatView):ReturnType<typeof parseEnvelope>{
    this.logReadShape(view);
    if(view.assistantReadIssue){
      const reasons:Record<string,string>={
        MULTIPLE_BLOCKS:'Mitter detected multiple separate code payloads in the latest reply (MULTIPLE_BLOCKS). It will not choose one or merge them.',
        EXTRA_CONTENT:'Mitter found text outside the JSON code payload (EXTRA_CONTENT). The reply must contain only one fenced JSON object.',
        MARKDOWN_TRANSFORMED:'The reply contains rendered Markdown rather than raw fenced code (MARKDOWN_TRANSFORMED). Source characters may have changed.',
        CODE_NOT_VISIBLE:'Mitter found code containers but no visible code payload (CODE_NOT_VISIBLE). Hidden content was not used.',
        EMPTY_CODE_BLOCK:'Mitter found a code container without a complete payload (EMPTY_CODE_BLOCK).',
        PLAIN_STRING_LAYOUT:'A rendered line break splits a JSON string (PLAIN_STRING_LAYOUT). Return literal fenced JSON; Miter will not guess the missing source characters.',
        PLAIN_HIDDEN_CONTENT:'The plain reply contains hidden content (PLAIN_HIDDEN_CONTENT). Return one visible fenced JSON block.',
        PAYLOAD_TOO_LARGE:'The reply exceeds the transport size limit. Return smaller fenced batches.',
      };
      throw new PageBridgeError('REPLY_FORMAT',reasons[view.assistantReadIssue]||'Mitter could not safely extract this reply. No actions were imported.');
    }
    const reply=parseEnvelope(view.assistantText);
    if(view.assistantFormat==='plain'&&!isReadOnlyReply(reply))throw new PageBridgeError('REPLY_FORMAT','An unfenced reply can be used only for read-only inspection (PLAIN_REPLY_REQUIRES_FENCE). Return edits, commands and completion inside one fenced json block so source bytes are preserved.');
    this.checkReplyExchange(reply,view.assistantFormat);
    return reply;
  }
  /** The ordinary transcript must not override a contradictory explicit nonce.
   * Legacy fenced replies without replyTo retain their full-user-receipt path;
   * the new plain-text fallback always requires the current exchange nonce. */
  private checkReplyExchange(reply:ReturnType<typeof parseEnvelope>,format?:ChatView['assistantFormat']):void{
    const receipt=parseReceipt(this.options.lastReceipt);
    if(!receipt?.expectsReplyTo||!receipt.exchangeId)return;
    if((reply.replyTo!==undefined||format==='plain')&&reply.replyTo!==receipt.exchangeId)throw new PageBridgeError('REPLY_LINK_MISSING',reply.replyTo?
      'This reply names an older or different exchange. Use a new reply id and the latest CURRENT REPLY CONTRACT; no rejected actions ran.':
      'This plain reply is missing replyTo. Return the current exchange link in one fenced json block; no actions were imported.');
  }
  /** A literal code candidate is NOT an execution grant. The old recovery is
   * scoped to an exact user-approved hash; future replies must echo the exact
   * nonce in the current durable send record. Normal schema/policy checks and
   * the stable-completed-reply window are still applied before import.
   */
  private async selectDirectReply(view:ChatView):Promise<void>{
    if(!view.codeReply||view.busy||view.draft||view.ready===false||isReplyFragment(view)||['REPLY_IN_PROGRESS','NEWER_REPLY_UNREADABLE'].includes(view.codeReplyIssue||''))return;
    let envelope:ReturnType<typeof replyHeaders>;
    try{envelope=replyHeaders(view.codeReply.text,this.options.workerId,this.options.projectId);}catch{return;}
    const receipt=parseReceipt(this.options.lastReceipt),approval=this.progress?.approvedReply;
    const manual=!!approval&&approval.url===view.url&&approval.id===envelope.id&&approval.hash===await replyDigest(boundReply(view.codeReply.text,this.options.workerId,this.options.projectId));
    const correlated=!!receipt&&receipt.expectsReplyTo===true&&!!receipt.exchangeId&&receipt.exchangeId===envelope.replyTo&&receipt.workerId===envelope.workerId&&receipt.projectId===envelope.projectId&&receipt.goalHash===await messageDigest(this.worker().goal);
    if(!manual&&!correlated)return;
    if(!manual&&view.lastUserText&&!view.lastUserCollapsed&&!view.lastUserTruncated&&!await this.matchesSavedReceipt(view.lastUserText))return;
    // Known contradictory user turns remain barriers. Lack of role metadata is
    // no longer fatal when the reply itself can be correlated independently.
    if(view.transcript?.users&&(!manual&&(view.lastRole!=='assistant'||(!view.lastUserCollapsed&&!view.lastUserTruncated&&!await this.matchesSavedReceipt(view.lastUserText)))))return;
    if(view.transcript?.unclassifiedTail&&view.transcript.users)return;
    view.replyEvidence=manual?'user':'exchange';
    view.assistantText=view.codeReply.text;view.assistantId=envelope.id;
    view.assistantFormat=view.codeReply.format||'code';delete view.assistantReadIssue;
    view.complete=true;view.lastRole='assistant';view.count=Math.max(1,view.count);
    const observation=envelope.id+':'+view.replyEvidence;
    if(observation!==this.lastDirectObservation){
      this.lastDirectObservation=observation;
      this.deps.log('bridge.reply.code',manual?'Using the exact reply explicitly selected by you. No bootstrap or turn is repeated.':view.codeReply.format==='plain'?'Matched a complete read-only plain JSON reply from an identified assistant message to the pending exchange.':'Matched a literal JSON code reply to the pending exchange. Transcript-role detection was not needed.');
    }
  }
  /** Normalize only by a full saved receipt match, including during late watch. */
  private async normalizeUserEcho(view:ChatView):Promise<void>{
    // Different highlighters encode line boundaries as text nodes, BRs, or
    // block elements. Only select a lossless candidate if its COMPLETE message
    // matches the known outgoing text/receipt. Never repair code or accept a
    // shared exchange marker as proof by itself.
    if(view.lastUserCandidates?.length&&!(this.matchesExpected(view.lastUserText)||await this.matchesSavedReceipt(view.lastUserText))){
      for(const candidate of view.lastUserCandidates.slice(0,6)){
        if(candidate.length<=160000&&(this.matchesExpected(candidate)||await this.matchesSavedReceipt(candidate))){
          view.lastUserText=candidate;view.lastUserTruncated=false;
          this.deps.log('bridge.user.read','Verified the complete sent message against its saved receipt using a full-message representation.');break;
        }
      }
    }
  }
  private async page(op:DomRequest['op'],text?:string,messageId?:string,composerSession?:string):Promise<ChatView> {
    // The new-chat route can be provisional. Only inspections may look across
    // that transition; writes remain pinned to the last proven exact URL.
    const expected=op==='inspect'&&this.pendingConversationBind?this.bootstrapOrigin:this.status.url;
    const result=await this.deps.page(this.options.tabId,{op,token:this.options.token,url:expected,text,messageId,composerSession,expiresAt:this.expiresAt,allowConversationBind:this.pendingConversationBind,includeHistory:op==='inspect'&&this.status.phase==='connecting',receipt:op==='inspect'?parseReceipt(this.options.lastReceipt):undefined,workerId:this.options.workerId,projectId:this.options.projectId,replyId:this.progress?.approvedReply?.id,replyTo:!this.progress?.approvedReply&&this.options.lastReceipt?.expectsReplyTo?this.options.lastReceipt.exchangeId:undefined});
    delete result.replyEvidence; // Only this coordinator may grant read evidence.
    if(op!=='stop'&&op!=='interrupt')await this.normalizeUserEcho(result);
    if(op==='inspect'){
      await this.selectDirectReply(result);
      const issue=result.codeReplyIssue||'none';
      const summary=JSON.stringify({pendingExchange:!!this.options.lastReceipt?.exchangeId,issue,
        total:result.codeReplyTotal??0,matches:result.codeReplyCount??0,busy:result.busy,
        draft:result.draft,selected:!!result.replyEvidence,unlinked:!!result.unlinkedReply});
      if(summary!==this.lastCodeDiagnostic){this.lastCodeDiagnostic=summary;this.deps.log('bridge.reply.observe',summary);}
    }
    if(op==='stop'||op==='interrupt')return result;
    if(result.disclosure){
      const shape=`state=${result.disclosure.state}; attempts=${result.disclosure.attempts}; collapsed=${!!result.lastUserCollapsed}.`;
      if(shape!==this.lastDisclosureDiagnostic){this.lastDisclosureDiagnostic=shape;this.deps.log('bridge.user.disclosure',shape);}
    }
    this.check();if(result.stopped)throw new Error('Stopped from the chat page.');
    if(result.url!==this.lastObservedURL){
      this.deps.log('bridge.location',`Tab ${this.options.tabId}: expected ${expected}; observed ${result.url}; bootstrap=${this.pendingConversationBind}.`);
      this.lastObservedURL=result.url;
    }
    if(this.pendingConversationBind){
      const actual=new URL(result.url);
      if(actual.origin!==this.bootstrapOrigin)throw new PageBridgeError('NAVIGATED','The linked tab left ChatGPT. Nothing else will be sent.');
      let bound='';try{bound=conversationURL(result.url);}catch{}
      if(bound){
        // Pin the first FINAL route as soon as it is observed after a Send.
        // It is not authentication and grants no permission to import; full
        // receipt checks still follow. Pinning prevents a missing DOM selector
        // from leaving bootstrap free to wander into another conversation.
        const committed=this.sendAttempted||!!this.progress?.lastReceipt&&['commit_intent','waiting_reply'].includes(this.progress.stage);
        if(committed&&!this.pinnedConversation){
          this.pinnedConversation=bound;
          if(this.progress)this.progress.conversationUrl=bound;
          await this.checkpoint();this.deps.publish({...this.status});
          this.deps.log('bridge.route.pinned','Saved the first conversation route after Send. Message ownership still requires the saved receipt.');
        }
        let assistantOwned=false;
        if(result.lastRole==='assistant'&&result.complete&&!result.busy){
          try{const e=this.parseReply(result);assistantOwned=e.workerId===this.options.workerId&&e.projectId===this.options.projectId;}catch{}
        }
        const userOwned=!!result.replyEvidence||!!result.lastUserText&&!result.lastUserTruncated&&(this.matchesExpected(result.lastUserText)||norm(messagePayload(result.lastUserText))===norm(this.prompt)||await this.matchesSavedReceipt(result.lastUserText)||this.options.resumeExisting===true&&isTaskBootstrap(result.lastUserText,this.worker()));
        if(this.pinnedConversation&&bound!==this.pinnedConversation){
          // Some page shells use a non-final /c/ alias. It can settle only
          // before the first imported reply, and only with a FULL matching
          // outgoing message. A stable UUID or missing role/text never permits
          // wandering into the other task's conversation seen in the log.
          const finalId=/\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(this.pinnedConversation);
          if(finalId||!userOwned)throw new PageBridgeError('NAVIGATED','The linked tab opened another conversation. Your progress is saved. Resume returns to the task’s recorded chat.');
          this.pinnedConversation=bound;if(this.progress)this.progress.conversationUrl=bound;await this.checkpoint();
        }
        const hasCommittedSend=this.sendAttempted||!!this.progress?.lastReceipt&&['commit_intent','waiting_reply'].includes(this.progress.stage);
        if(!hasCommittedSend&&!userOwned&&!(this.options.resumeExisting&&assistantOwned))throw new PageBridgeError('NAVIGATED','The new tab changed before the task was sent. Nothing was changed.');
        if(result.lastUserText&&!userOwned){
          // A post-Send snapshot may be partial or use a different literal-text
          // layout. Do not run a second, harsher ownership check here. The SAME
          // receipt confirmation path used by normal replies waits read-only,
          // logs the comparison, and bounds uncertainty below in confirmUserTurn.
          if(hasCommittedSend){if(op==='inspect')this.checkTranscript(result);return result;}
          throw new PageBridgeError('CHAT_OWNERSHIP','The selected conversation could not be matched to this task. Nothing was imported or sent.');
        }
        if(userOwned||assistantOwned&&!result.lastUserText){
          if(this.status.url!==bound){this.status.url=bound;this.deps.log('bridge.bind','Verified this task in its conversation. The route remains provisional until the first reply is validated.');this.deps.publish({...this.status});}
          if(assistantOwned&&!this.acknowledged){this.adoptedAssistantReceipt=this.replyFingerprint(result);this.acknowledged=true;this.userCount=result.userCount;this.expectedUserId=result.lastUserId||'';this.deps.log('bridge.ack','Owned assistant reply confirmed the task while its user turn was virtualized.');}
        }
        // No ownership yet: acknowledge/wait logic below must see the actual
        // task message or reply before executing anything. Never adopt by URL.
      }else if(actual.pathname!=='/'&&actual.pathname!==''){
        if(!this.sendAttempted)throw new PageBridgeError('NAVIGATED','The new tab changed before the task was sent. Nothing was changed.');
        throw new PageBridgeError('CHAT_BINDING_PENDING','ChatGPT is creating the conversation. Waiting without sending again.',true);
      }
    }else if(result.url!==this.status.url){
      const actual=new URL(result.url);
      if(op==='inspect'&&actual.origin===new URL(this.status.url).origin&&actual.pathname==='/'&&!result.lastUserText&&!result.assistantText&&!result.draft){
        throw new PageBridgeError('CHAT_RELOADING','The linked conversation is reloading. Waiting without sending again.',true);
      }
      throw new PageBridgeError('NAVIGATED','The linked tab navigated to a different conversation. Resume returns to this task’s saved chat.');
    }
    if(op==='inspect')this.checkTranscript(result);
    return result;
  }
  /** Count-based, content-free evidence. A page handshake cannot tell us that
   * message selectors still work. Report a reader failure, not a fictitious
   * model wait or user edit, if the page has messages we cannot classify. */
  private checkTranscript(view:ChatView):void {
    const t=view.transcript;if(!t||view.replyEvidence)return;
    if(this.progress?.approvedReply&&['local_batch','report_due'].includes(this.progress.stage)&&this.progress.approvedReply.url===view.url)return;
    // New sends carry a reply nonce. While waiting for it, absent role markers
    // are no longer a failure. Nothing is imported until a correlated complete
    // code payload appears; the normal task/reply timeout still applies.
    const n=(v:number)=>Number.isSafeInteger(v)&&v>=0?Math.min(v,24000):0;
    const shape=`state=${t.state}; roles=${n(t.roleAttributes)}; alternatives=${n(t.alternativeRoles)}; headings=${n(t.semanticRoles)}; turns=${n(t.turnContainers)}; users=${n(t.users)}; assistants=${n(t.assistants)}; unknown=${n(t.unknownTurns)}; code=${n(t.codeBlocks)}; shadows=${n(t.openShadowRoots)}; frames=${n(t.frames)}; limited=${!!t.scanLimited}.`;
    const r=t.receiptDiscovery;
    const receiptShape=r?` receipt=${r.state}; candidates=${n(r.candidates)}; matches=${n(r.matches)}; tail=${n(r.tailBranches)}; controls=${n(r.responseControls)}.`:'';
    if(shape+receiptShape!==this.lastTranscriptDiagnostic){
      this.lastTranscriptDiagnostic=shape+receiptShape;this.deps.log('bridge.transcript',shape+receiptShape);
      if(t.codeAncestry?.length)this.deps.log('bridge.reader.shape',JSON.stringify({strategy:t.strategy,codeAncestry:t.codeAncestry.map(chain=>chain.map(node=>({tag:node.tag,attributes:node.attributes})))}));
    }
    // A verified send followed by an in-progress unlabelled response is not an
    // unsupported page yet. Wait read-only for its response controls to render;
    // task limits still apply and no action can pass the completion gate here.
    if(r?.state==='waiting_reply'&&r.matches===1&&(view.busy||isReplyFragment(view))){this.unreadableSince=undefined;return;}
    if(this.options.lastReceipt?.expectsReplyTo&&!t.users&&!t.scanLimited)return;
    if(t.scanLimited)throw new PageBridgeError('TRANSCRIPT_LIMIT','The page is too large to inspect safely. No reply was imported. Open the linked chat near its latest messages, then Resume.');
    const pending=this.sendAttempted||!!this.progress?.lastReceipt&&['commit_intent','waiting_reply'].includes(this.progress.stage);
    const missingAfterSend=pending&&view.ready!==false&&view.count===0&&view.url.includes('/c/');
    if(t.state==='unrecognized'||t.unclassifiedTail||missingAfterSend){
      if(this.unreadableSince===undefined)this.unreadableSince=this.now();
      const waiting=this.now()-this.unreadableSince<12000;
      throw new PageBridgeError(waiting?'TRANSCRIPT_LOADING':'TRANSCRIPT_UNSUPPORTED',waiting?'Waiting for the chat’s message structure to load. Nothing is being sent again.':'Automatic matching could not read this layout. Use reply lets you select the existing JSON directly, without resending the task. Your files and progress are saved.',waiting);
    }
    this.unreadableSince=undefined;
  }
  /** Invoked ONLY after the extension UI has shown and confirmed this exact
   * handoff. Unlike Resume, importing that chosen handoff does not depend on
   * reconstructing the old user bubble. Same host import/run/dedup gates.
   */
  async startWithReply(raw:string,url:string):Promise<void>{
    if(this.busy)throw new Error('The task is already starting.');
    this.busy=true;this.operationIdle=new Promise(resolve=>{this.operationDone=resolve;});
    try{
      const w=this.worker(),envelope=boundReply(raw,w.id,w.projectId);
      await this.restoreProgress();this.check();
      if(w.mode!=='handoff'||!['idle','review','paused','blocked'].includes(w.state)||w.queue.length||w.pending||w.humanAcceptanceReady)throw new Error('Resolve this task’s pending local work first.');
      this.status.url=conversationURL(url);this.pinnedConversation=this.status.url;
      this.pendingConversationBind=false;this.status.bindingPending=false;
      this.progress!.conversationUrl=this.status.url;
      this.progress!.approvedReply={id:envelope.id,hash:await replyDigest(envelope),url:this.status.url,at:this.now()};
      await this.checkpoint('waiting_reply');
      this.prompt=await this.deps.rpc<string>('worker.prompt',{workerId:w.id,kind:'bootstrap'});
      this.nextPrompt=await this.deps.rpc<string>('worker.prompt',{workerId:w.id,kind:'next'});
      this.check();
      const page:ChatView={url:this.status.url,count:1,userCount:0,lastRole:'assistant',assistantId:envelope.id,assistantText:raw,lastUserText:'',busy:false,complete:true,draft:false,draftText:'',stopped:false,ready:true,assistantFormat:'code',replyEvidence:'user'};
      await this.importEnvelope(envelope,w,page);
      this.deps.log('bridge.reply.accepted','Applied the reply you selected. Saved turns and task identity were not reset.');
    }catch(error){await this.stop(message(error),'error',code(error));throw error;}
    finally{this.busy=false;this.operationDone?.();}
  }
  async start():Promise<void> {
    if(this.busy)return;
    this.busy=true;this.operationIdle=new Promise(resolve=>{this.operationDone=resolve;});
    try{
      const w=this.worker();
      await this.restoreProgress();
      const continueBatch=this.options.resumeExisting===true&&!!w.queue.length&&this.progress?.stage==='local_batch'&&this.progress.lastImportedId===w.queue[0]?.id;
      if(w.mode!=='handoff'||!['idle','review','paused','blocked'].includes(w.state)||(w.queue.length&&!continueBatch)||w.pending)throw new Error('This task has unfinished local work. Review its activity before starting another chat session.');
      if(w.humanAcceptanceReady)throw new Error('The result is ready for your review. Another chat is not needed.');
      this.update('connecting','Connecting to ChatGPT…');
      this.prompt=await this.deps.rpc<string>('worker.prompt',{workerId:w.id,kind:'bootstrap'});
      this.nextPrompt=await this.deps.rpc<string>('worker.prompt',{workerId:w.id,kind:'next'});this.check();
      if(continueBatch){
        // Continue the previously imported local action IDs at the host's saved
        // cursor. Never re-import this batch or request another bootstrap.
        this.update('running','Continuing saved local edits…');
        await this.deps.rpc('worker.resume',{workerId:w.id,epoch:this.executionEpoch});this.check();
        this.deps.log('bridge.resume.local','Continued the saved imported batch. Turn count retained; no new message sent.');
        return;
      }
      await this.initialise();
    }catch(error){if(!this.recover(error,'connecting')){await this.stop(message(error),'error',code(error));throw error;}}
    finally{this.busy=false;this.operationDone?.();}
  }
  private async initialise():Promise<void>{
    this.check();const w=this.worker();
    if(!w.activeFollowupId&&this.progress?.approvedReply&&['local_batch','report_due'].includes(this.progress.stage)){
      this.update('running','Continuing the reply you selected…');return;
    }
    if(w.control?.mode==='fresh'&&this.progress?.stage==='report_due'){
      const current=await this.page('probe');this.check();
      if(current.draft)throw new PageBridgeError('DRAFT_CONFLICT','Your draft is safe. Move or send it before continuing.');
      if(current.ready===false||current.busy){
        if(this.now()-this.resumedAt>60000)throw new PageBridgeError('CHAT_BUSY','The previous reply is still running or the composer is not ready. No new request was sent.');
        this.update('connecting','Waiting for the previous reply to stop before continuing fresh…');return;
      }
      await this.send(this.prompt+'\n\nFRESH CONTINUATION FROM SAVED WORK\n'+await this.reportPrompt(w),current);return;
    }
    const page=await this.page('inspect');
    if(page.ready===false){this.update('connecting','Waiting for the ChatGPT page to be ready…');if(this.now()-this.resumedAt>60000)throw new Error('ChatGPT’s composer did not load. Sign in to the open chat, then resume this task.');return;}
    const receipt=parseReceipt(this.options.lastReceipt);
    const receiptBound=!!receipt&&receipt.workerId===w.id&&receipt.projectId===w.projectId&&receipt.goalHash===await messageDigest(w.goal);
    const receiptMatches=async(text:string)=>receiptBound&&await matchesReceipt(text,receipt!);
    const ownedReceipt=!!page.replyEvidence||this.options.resumeExisting===true&&!page.lastUserTruncated&&!!page.lastUserText&&await receiptMatches(page.lastUserText);
    this.check();
    if(page.draft&&await receiptMatches(page.draftText)){
      if(this.progress&&['commit_intent','waiting_reply'].includes(this.progress.stage))throw new PageBridgeError('SEND_UNCERTAIN_DRAFT','A prior Send may have happened, but its draft is still present. It was not sent twice. Check the linked chat before continuing.');
      await this.send(messagePayload(page.draftText),page);return;
    }
    const ownedText=messagePayload(page.lastUserText);
    const ownedUser=ownedReceipt||norm(ownedText)===norm(this.prompt)||ownedText.startsWith(this.nextPrompt+'\n\nBEGIN UNTRUSTED MITTER REPORT')||this.options.resumeExisting===true&&isTaskBootstrap(page.lastUserText,w);
    let ownedAssistant=false;
    if(this.options.resumeExisting&&page.complete&&!page.busy&&page.lastRole==='assistant'){
      try{const envelope=this.parseReply(page);ownedAssistant=envelope.workerId===w.id&&envelope.projectId===w.projectId;}catch{}
    }
    if(w.activeFollowupId&&this.progress?.stage==='report_due'){
      if(page.draft)throw new PageBridgeError('DRAFT_CONFLICT','Your draft is safe. Send or move it before continuing the follow-up.');
      if(page.busy){this.update('connecting','Waiting for the current reply before sending your follow-up…');return;}
      if(!ownedUser&&!ownedReceipt)throw new PageBridgeError('CHAT_OWNERSHIP','The saved conversation could not be verified. Your follow-up is queued, not lost.');
      await this.send(await this.reportPrompt(w),page);return;
    }
    const pendingSend=!!receiptBound&&!!this.progress&&['commit_intent','waiting_reply'].includes(this.progress.stage);
    // A restart can briefly show the PREVIOUS owned exchange while the latest
    // committed send is absent. Never interpret that older reply as permission
    // to resend the latest report. Await its saved receipt, read-only.
    if(pendingSend&&!ownedReceipt&&!page.draft){
      this.restoringPendingSend=true;this.expectedUser='';this.expectedRenderedUser='';this.acknowledged=false;
      this.expectedUserId='';this.priorUserIds=new Set(receipt?.priorUserId?[receipt.priorUserId]:[]);
      this.userBefore=ownedUser?page.lastUserText:'';this.sentAt=this.now();this.visibilitySince=undefined;
      this.status.turns=Math.max(this.status.turns,receipt?.turn??0);
      this.update('waiting_reply','Confirming the saved send… Nothing will be sent twice.');await this.checkpoint();return;
    }
    if(this.options.resumeExisting&&!ownedUser&&!ownedAssistant&&!page.draft){
      if(page.count===0||page.busy&&!page.lastUserText){
        this.update('connecting','Reopening the saved chat… Waiting for this task’s messages.');
        if(this.now()-this.resumedAt>60000)throw new PageBridgeError('CHAT_NOT_LOADED','The saved chat did not load this task. Sign in or choose its original chat. Nothing was sent.');
        return;
      }
      throw new PageBridgeError('CHAT_OWNERSHIP','This chat does not show the current task. Nothing was sent; choose its original chat.');
    }
    if(page.draft&&norm(messagePayload(page.draftText||''))!==norm(this.prompt)){
      // A pending report from this same run is safe to reuse, never a user draft.
      const next=await this.reportPrompt(w);
      if(norm(messagePayload(page.draftText||''))!==norm(next))throw new PageBridgeError('DRAFT_CONFLICT','Your draft is safe. Send or move it, then resume Mitter.');
      await this.send(next,page);return;
    }
    if(ownedAssistant&&!ownedUser&&page.lastUserText){
      throw new PageBridgeError('USER_ECHO_UNREADABLE','The reply belongs to this task, but Mitter could not verify the preceding report. Progress is saved; copy diagnostics instead of sending again.');
    }
    if((ownedUser||ownedAssistant)&&!page.draft){
      this.adoptedAssistantReceipt=ownedAssistant&&!page.lastUserText?this.replyFingerprint(page):'';
      this.expectedUser=ownedUser?page.lastUserText:this.prompt;this.userCount=page.userCount;this.acknowledged=true;this.expectedUserId=ownedUser?page.lastUserId||'':'';
      this.priorUserIds=new Set((page.userIds||[]).filter(id=>id!==this.expectedUserId));
      this.baseline=page.lastRole==='assistant'?Math.max(0,page.count-1):page.count;
      this.sentAt=this.now();
      const observed=page.observedTaskTurns?.find(e=>e.workerId===w.id&&e.projectId===w.projectId)?.count??0;
      this.status.turns=Math.max(this.status.turns,receipt?.turn??0,observed,1);
      // Old builds did not record every outgoing send. Preserve a known lower
      // bound rather than presenting a fabricated exact history.
      await this.checkpoint('waiting_reply');
      this.update('waiting_reply',page.busy?'ChatGPT is working…':'Checking the existing reply…');
      this.deps.log('bridge.adopt','Reusing the existing task exchange; the initial prompt was not resent.');
      if(page.complete&&!page.busy&&page.lastRole==='assistant'){
        if(receipt?.priorAssistantHash&&await messageDigest(this.replyFingerprint(page))===receipt.priorAssistantHash){this.candidate='';return;}
        let envelope:ReturnType<typeof parseEnvelope>;
        try{envelope=this.parseReply(page);}catch{
          // Resume follows the SAME bounded format-repair path as a live turn,
          // instead of throwing on the old reply before recovery can run.
          this.candidate=this.replyFingerprint(page);this.stableSince=this.now();return;
        }
        if(envelope.workerId!==w.id||envelope.projectId!==w.projectId)throw new Error('The existing reply has the wrong worker/project IDs. No actions were imported.');
        const seen=await this.deps.rpc<{seen:boolean}>('worker.handoffSeen',{workerId:w.id,envelopeId:envelope.id});this.check();
        if(seen.seen){this.deps.log('bridge.resume','This batch was already imported; requesting the next step without replaying it.');await this.send(await this.reportPrompt(w),page);return;}
        // Even an adopted reply is observed twice before execution.
        this.candidate=this.replyFingerprint(page);this.stableSince=this.now();
      }
      return;
    }
    if(page.busy){this.update('connecting','Waiting for ChatGPT to finish its current reply…');return;}
    await this.send(w.state==='review'?await this.reportPrompt(w):this.prompt,page);
  }
  private async reportPrompt(w:Worker):Promise<string>{
    const report=await this.deps.rpc<string>('worker.report',{workerId:w.id});this.check();
    return `${this.nextPrompt}\n\nBEGIN UNTRUSTED MITTER REPORT\n${report}\nEND UNTRUSTED MITTER REPORT\n\nReturn only the next complete mitter/1 JSON object inside one fenced code block labeled json. No commentary outside the block.`;
  }
  private async send(text:string,page:ChatView,exactResend=false):Promise<void> {
    this.check();if(this.status.turns>=this.status.maxTurns)throw new PageBridgeError('TURN_LIMIT','The task’s turn budget is used. Progress is saved; add more turns to continue.');
    if(page.busy)throw new Error('ChatGPT is busy. Nothing was sent.');
    if(page.draft&&norm(messagePayload(page.draftText||''))!==norm(text))throw new PageBridgeError('DRAFT_CONFLICT','Your draft is safe. Mitter will not overwrite it.');
    // Never rewrite an existing, exact Mitter draft. Fresh messages use a
    // literal transport block so report/code Markdown cannot corrupt the echo.
    const savedPrepared=this.progress?.stage==='prepared'?parseReceipt(this.options.lastReceipt):undefined;
    let expectsReplyTo=false;
    if(page.draft){
      text=page.draftText;
      const saved=parseReceipt(this.options.lastReceipt),frame=unwrapMessage(text),w=this.worker();
      // An interrupted prepare already contains its replyTo contract. Reusing
      // those exact bytes must retain correlation, not downgrade to a legacy
      // unlinked send. This is allowed only against the saved full receipt.
      expectsReplyTo=!!frame&&saved?.expectsReplyTo===true&&frame.exchangeId===saved.exchangeId&&
        saved.workerId===w.id&&saved.projectId===w.projectId&&saved.goalHash===await messageDigest(w.goal)&&await matchesReceipt(text,saved);
    }
    else if(exactResend){
      if(!await this.matchesSavedReceipt(text))throw new PageBridgeError('RESEND_MISMATCH','The saved prompt is unavailable or changed. Nothing was resent.');
      expectsReplyTo=this.options.lastReceipt?.expectsReplyTo===true;
    }
    else {
      const exchangeId=savedPrepared?.exchangeId||crypto.randomUUID();expectsReplyTo=true;
      const w=this.worker();
      const contract='CURRENT REPLY CONTRACT (this exchange only)\n'+
        JSON.stringify({protocol:'mitter/1',id:'NEW_UNIQUE_REPLY_ID',replyTo:exchangeId,workerId:w.id,projectId:w.projectId},null,2)+
        '\nThese are required envelope headers, not a complete action batch. Add the required summary string and actions array using the action schema below. Return exactly one fenced json block. Include "replyTo": "'+exchangeId+'" at the top level. Do not reuse a replyTo from an earlier turn. Use a new unique id. Use ordinary ASCII indentation; do not HTML-encode JSON whitespace or add Markdown backslashes at line endings. The action schema, permissions and checks are unchanged.';
      // Update our own example only. Never rewrite file contents, user goals,
      // report text, or a draft the user prepared.
      const example=JSON.stringify({protocol:'mitter/1',id:'REPLACE_WITH_A_NEW_UNIQUE_ID_EVERY_TURN',workerId:w.id,projectId:w.projectId,summary:'What this batch does',actions:[{type:'list',path:'.'}]},null,2);
      const linkedExample=JSON.stringify({protocol:'mitter/1',id:'REPLACE_WITH_A_NEW_UNIQUE_ID_EVERY_TURN',replyTo:exchangeId,workerId:w.id,projectId:w.projectId,summary:'What this batch does',actions:[{type:'list',path:'.'}]},null,2);
      const templateEnd=text.indexOf('BEGIN UNTRUSTED MITTER REPORT');
      const template=templateEnd<0?text:text.slice(0,templateEnd),report=templateEnd<0?'':text.slice(templateEnd);
      text=wrapMessage(contract+'\n\n'+template.replace(example,linkedExample)+report+'\n\n'+contract,exchangeId);
    }
    if(text.length>160000)throw new PageBridgeError('MESSAGE_TOO_LARGE','The task report is too large to send safely. No message was inserted.');
    this.waitObservation='';this.waitUnchangedAt=this.now();this.restoringPendingSend=false;this.expectedUser=text;this.expectedRenderedUser='';this.userCount=page.userCount;this.baseline=page.count;this.userBefore=page.lastUserText;this.userIdBefore=page.lastUserId||'';this.assistantBefore=page.assistantId;this.assistantTextBefore=page.assistantText;this.acknowledged=false;this.adoptedAssistantReceipt='';this.expectedUserId='';this.priorUserIds=new Set(page.userIds||[]);if(page.lastUserId)this.priorUserIds.add(page.lastUserId);
    this.userObservation='';this.visibilitySince=undefined;this.lastUserDiagnostic='';this.candidate='';this.unlinkedCandidate='';this.unlinkedWaitSince=undefined;this.sentAt=this.now();
    if(savedPrepared&&!await this.matchesSavedReceipt(text))throw new PageBridgeError('PREPARED_MESSAGE_CHANGED','The saved unsent message cannot be reconstructed exactly. Its draft was left untouched; review it before continuing.');
    const messageId=savedPrepared?.messageId||crypto.randomUUID();
    this.update('sending',this.status.turns===0?'Preparing your task…':'Preparing the next step…');
    const w=this.worker(),frame=unwrapMessage(text);
    const receipt:OutboundReceipt={workerId:w.id,projectId:w.projectId,goalHash:await messageDigest(w.goal),textHash:await messageDigest(text),renderedHash:await messageDigest(text),at:this.now(),messageId,
      priorReplyIds:page.codeReplyIds?.slice(-64),exchangeId:frame?.exchangeId,...(expectsReplyTo?{expectsReplyTo:true}:{}),payloadHash:frame?await messageDigest(frame.payload):undefined,turn:this.status.turns+1,
      priorUserId:page.lastUserId||undefined,priorUserHash:page.lastUserText?await messageDigest(page.lastUserText):undefined,priorAssistantHash:page.assistantText?await messageDigest(this.replyFingerprint(page)):undefined};
    // Save the receipt BEFORE changing the page, not after a readiness timer.
    // The host is authoritative: browser migration metadata must never get
    // ahead of a prepared checkpoint and make an unsent draft look submitted.
    this.options.lastReceipt=receipt;await this.checkpoint('prepared');this.check();
    try{await this.deps.saveReceipt?.(receipt);}catch{throw new PageBridgeError('RECEIPT_SAVE_FAILED','Resume information could not be saved. No new Send was attempted.');}
    this.check();this.pendingSend={text,messageId,startedAt:this.now(),commitIntent:false};this.lastSendReadiness='';
    await this.advanceSend();
  }
  /** Short, background-driven steps. A hidden page never owns our readiness
   * deadline. Retrying preparation is non-sending; commit retries require a
   * document-local proof and the same message ID/bytes/ledger. */
  private async advanceSend():Promise<void>{
    const pending=this.pendingSend;if(!pending)return;
    this.check();
    if(this.now()-pending.startedAt>=120000){
      if(pending.commitIntent){await this.finishSendObservation('Send confirmation is delayed. Checking this chat without clicking again.');return;}
      throw new PageBridgeError('SEND_NOT_READY','ChatGPT’s composer did not become ready within two minutes. The saved draft is intact; no Send was attempted. Check sign-in, network, or browser suspension, then Resume.');
    }
    let prepared:ChatView|undefined;
    try{
      if(!pending.commitIntent){
        prepared=await this.page('prepare',pending.text,pending.messageId);this.check();
        if(prepared.outcome==='pending'){this.sendReadiness(prepared.readiness||'send_not_ready');return;}
        if(!['prepared','already_clicked','already_sent'].includes(prepared.outcome||''))throw new PageBridgeError('INVALID_PAGE_STATE','The page did not confirm preparation. Nothing was sent.',true);
        pending.composerSession=prepared.composerSession;
        this.expectedRenderedUser=prepared.renderedDraftText||'';
        if(this.options.lastReceipt){
          const receipt={...this.options.lastReceipt,renderedHash:await messageDigest(this.expectedRenderedUser||pending.text)};this.check();
          this.options.lastReceipt=receipt;await this.checkpoint('prepared');this.check();
          try{await this.deps.saveReceipt?.(receipt);}catch{throw new PageBridgeError('RECEIPT_SAVE_FAILED','Resume information could not be saved. Your draft is safe; no Send was attempted.');}
          this.check();
        }
        this.update('sending',this.status.turns===0?'Sending your task…':'Sending the results to ChatGPT…');
        if(this.progress)delete this.progress.approvedReply;
        this.sendAttempted=true;this.status.turns++;
        await this.checkpoint('commit_intent');this.check();pending.commitIntent=true;
      }
      const result=prepared&&['already_clicked','already_sent'].includes(prepared.outcome||'')?prepared:
        await this.page('commit',pending.text,pending.messageId,pending.composerSession);
      this.check();
      if(result.outcome==='pending'){this.sendReadiness(result.readiness||'send_not_ready');return;}
      // The production transport requires an outcome. Direct dependency test
      // doubles from older adapters may omit it, but cannot bypass transport.
      if(result.outcome!==undefined&&!['clicked','already_clicked','already_sent'].includes(result.outcome))throw new PageBridgeError('INVALID_PAGE_STATE','Invalid commit acknowledgement.',true);
      await this.finishSendObservation('Waiting for ChatGPT…');
    }catch(error){
      this.check();
      const e=error instanceof PageBridgeError?error:undefined;
      const notClicked=['COMPOSER_MISSING','SEND_NOT_READY','EDITOR_REPLACED','BUSY','COMPOSER_BUSY','INSERT_REJECTED'];
      if(pending.commitIntent&&e?.code==='COMMIT_DOCUMENT_CHANGED'){
        await this.finishSendObservation('The chat document changed. Checking for the saved message; nothing is being sent twice.');return;
      }
      if(e&&(e.transient||notClicked.includes(e.code))){
        if(pending.commitIntent&&e.transient&&!notClicked.includes(e.code)&&this.lastSendReadiness!==e.code)this.deps.log('bridge.send.uncertain','A commit acknowledgement was interrupted. Same-document verification is required; no new send ID will be created.');
        if(pending.commitIntent&&!pending.composerSession&&!notClicked.includes(e.code)){
          // An older page cannot prove its commit ledger survived. Read only.
          await this.finishSendObservation('Checking the send acknowledgement. Nothing is being sent twice.');return;
        }
        this.sendReadiness(e.code);return;
      }
      throw error;
    }
  }
  private sendReadiness(readiness:string):void{
    if(readiness!==this.lastSendReadiness){
      this.lastSendReadiness=readiness;this.deps.log('bridge.send.readiness',readiness+'; background retry; no new exchange or blind resend.');
    }
    const blocked=readiness==='TAB_FROZEN'||readiness==='TAB_DISCARDED';
    this.update('sending',blocked?'Chrome suspended the linked chat. Waiting for it to become available; the saved prompt is not being resent.':
      readiness==='generating'||readiness==='BUSY'?'Waiting for ChatGPT to finish before sending the saved prompt…':
      this.pendingSend?.commitIntent?'Confirming this prepared send in the same document…':'Waiting for ChatGPT’s Send button… The saved prompt will be sent when ready; no click is needed.');
  }
  private async finishSendObservation(reason:string):Promise<void>{
    this.check();this.pendingSend=undefined;this.lastSendReadiness='';this.sentAt=this.now();
    await this.checkpoint('waiting_reply');this.check();
    this.deps.log('bridge.send',`Turn ${this.status.turns} reserved; checking the actual sent message. No new send ID was created during recovery.`);
    this.update('waiting_reply',reason);
  }
  private async importEnvelope(envelope:ReturnType<typeof parseEnvelope>,w:Worker,page:ChatView):Promise<void> {
    if(envelope.workerId!==w.id||envelope.projectId!==w.projectId)throw new Error('Reply has the wrong worker/project IDs. No actions were imported.');
    this.checkReplyExchange(envelope,page.assistantFormat);
    const seen=await this.deps.rpc<{seen:boolean}>('worker.handoffSeen',{workerId:w.id,envelopeId:envelope.id});this.check();
    if(seen.seen){this.deps.log('bridge.resume','Already imported; requesting the next step without repeating actions.');await this.send(await this.reportPrompt(w),page);return;}
    // Read-reference admission is a non-mutating host operation. A failed
    // reference gets read/replan feedback, not an import retry or another Send
    // of the old request. Import independently revalidates before queuing.
    if(envelope.actions.some(a=>'base' in a)) {
      const admission=await this.deps.rpc<{valid:boolean;issue?:ReplyIssue}>('worker.validateReply',{workerId:w.id,text:JSON.stringify(envelope),epoch:this.executionEpoch});this.check();
      if(admission.valid!==true){
        if(!admission.issue)throw new Error('The local host returned an invalid reply-admission result.');
        if(page.replyEvidence==='user')throw new ReplyValidationError(admission.issue);
        await this.repairReply(w,page,new ReplyValidationError(admission.issue));return;
      }
    }
    if(this.pendingConversationBind){
      // Wait for a final conversation URL, not just a completed reply rendered
      // on the transient root. The next report must not go into an unbound chat.
      conversationURL(this.status.url);this.pendingConversationBind=false;this.status.bindingPending=false;this.deps.publish({...this.status});
      this.deps.log('bridge.bind','Conversation binding finalized after an owned, complete reply.');
    }
    const content=await messageDigest(JSON.stringify(envelope.actions));this.repeats=content===this.lastActionsHash?this.repeats+1:0;this.lastActionsHash=content;
    if(this.repeats>=2)throw new Error('Three identical proposals. Stopped to avoid an endless loop.');
    this.check();this.update('running','Accepting the verified reply locally…');
    this.pendingDelivery={envelope,hash:await replyDigest(envelope),imported:false,failures:0,retryAt:0};
    await this.advanceDelivery();
  }
  /** Only retry a missing native acknowledgement, using the SAME canonical
   * envelope and host receipt. Never resend a prompt, re-import a different
   * proposal, retry a failed file operation or auto-resume a stopped command. */
  private async advanceDelivery():Promise<void>{
    const delivery=this.pendingDelivery;if(!delivery||this.now()<delivery.retryAt)return;
    this.check();const w=this.worker(),e=delivery.envelope;
    try{
      if(!delivery.imported){
        await this.deps.rpc('worker.import',{workerId:w.id,text:JSON.stringify(e),epoch:this.executionEpoch,reconcile:true});this.check();
        delivery.imported=true;
        if(this.progress)this.progress.lastImportedId=e.id;
        await this.checkpoint('local_batch');this.check();
      }
      await this.deps.rpc('worker.run',{workerId:w.id,epoch:this.executionEpoch,envelopeId:e.id,envelopeHash:delivery.hash});this.check();
      this.pendingDelivery=undefined;this.formatRepairs=0;
      this.update('running','Applying the accepted batch locally…');
      this.deps.log('bridge.import',`Imported ${e.id}; ${e.actions.length} validated actions.`);
    }catch(error){
      this.check();
      if(!(error instanceof NativeRequestTimeout)||!['worker.import','worker.run'].includes(error.method))throw error;
      delivery.failures++;
      if(delivery.failures>=4)throw new PageBridgeError('LOCAL_ACK_TIMEOUT','The local host is not acknowledging this saved batch. Progress is retained. Reconnect and Resume local work; do not resend the chat prompt.');
      delivery.retryAt=this.now()+Math.min(8000,1000*2**(delivery.failures-1));
      this.deps.log('bridge.local.reconcile',`${error.method}: checking the same batch receipt; attempt ${delivery.failures}/3. No prompt resent.`);
      this.update('running','Confirming the saved local batch… Edits will not be imported or started twice.');
    }
  }
  private async repairReply(w:Worker,page:ChatView,error:unknown):Promise<void>{
    const issue=error instanceof ReplyValidationError?error.issue:undefined;
    const reason=message(error),diagnosis=issue?correctionAdvice(issue):reason;
    this.deps.log('bridge.reply.invalid',`${diagnosis} Format=${page.assistantFormat||'unknown'}; characters=${page.assistantText.length}. Rejected reply content is not logged.`);
    if(this.formatRepairs>=2)throw new PageBridgeError(issue?'REPLY_SCHEMA':'REPLY_FORMAT',issue?
      `Miter received the reply, but its action data is invalid (${issue.code}${issue.actionIndex===undefined?'':', action '+(issue.actionIndex+1)}). Two correction attempts did not resolve it. No rejected actions ran. Resume rechecks the reply; Stop then Continue fresh requests current file reads.`:
      'Mitter could not safely read the reply after two correction attempts. No actions from those replies ran. Resume rechecks the current reply; details are in the console.');
    this.formatRepairs++;
    this.deps.log('bridge.repair',`Requesting ${issue?'action-data':'format'} correction ${this.formatRepairs}/2. No actions from the rejected reply were imported.`);
    this.update('repairing',issue?'Reply received, but its action data needs correction. No rejected changes ran.':'Correcting the reply format… No file changes from that reply.');
    const report=await this.reportPrompt(w);this.check();
    await this.send(`${report}\n\n${issue?'ACTION DATA CORRECTION':'TRANSPORT CORRECTION'} ${this.formatRepairs}/2: Your latest response was not imported. ${diagnosis}\nReturn a new complete mitter/1 envelope inside ONE fenced code block labeled json. No prose outside it. Use ordinary ASCII spaces for JSON indentation, not HTML entities, and actual line breaks, not backslash-newline Markdown. Use a new id and the CURRENT replyTo, not the rejected envelope IDs. Use JSON.stringify-equivalent escaping for all file contents. Preserve JavaScript backticks and backslashes literally inside JSON strings. Do not use inline Markdown. Use smaller batches if needed. Do not repeat already successful actions in the report above. Do not claim the rejected batch executed.`,page);
    if(!this.pendingSend)this.update('waiting_reply',issue?'Waiting for the corrected action data or requested file reads…':'Waiting for ChatGPT to correct its reply…');
  }
  /** Recover a *transport* mistake, never execute an unlinked payload.
   * Rewriting the replyTo locally would approve an unproven action batch. Instead
   * request a fresh linked response only when a single new task reply follows a
   * recorded pre-send reply on the same pinned conversation. Legacy checkpoints
   * may use their persisted last-imported ID as the baseline. Ambiguity/drafts
   * stop the attempt. Correction sends use the ordinary saved budget and receipt.
   */
  private async recoverUnlinkedReply(page:ChatView,w:Worker):Promise<boolean>{
    const receipt=parseReceipt(this.options.lastReceipt);
    if(!receipt?.expectsReplyTo||page.replyEvidence)return false;
    if(page.busy||page.ready===false){this.unlinkedCandidate='';return false;}
    if(page.draft)throw new PageBridgeError('DRAFT_CONFLICT','Your draft is safe. Miter paused while you are writing.');
    if(page.codeReplyIssue==='NEWER_USER_MESSAGE'){
      // The direct-code lane can still see the PRIOR reply while our next report
      // is now the latest user turn. That is normal waiting, not an intervention.
      // Only a complete, exact saved receipt may take this path. Returning false
      // grants no reply authority: normal user-ID/duplicate and completion checks
      // still run, and an unrelated/truncated/unknown message still stops below.
      const prior=receipt.priorReplyIds??(this.progress?.lastImportedId?[this.progress.lastImportedId]:[]);
      const onlyPriorReplies=page.codeReplyCount===0&&!page.unlinkedReply&&!!page.codeReplyIds?.length&&
        page.codeReplyIds.every(id=>prior.includes(id));
      // Once the next assistant starts streaming, the last role is no longer
      // 'user'. The only parseable code can STILL be the previous reply. An
      // exact current user receipt plus exclusively pre-send code IDs permits
      // waiting/normal parsing, not executing any of those old code blocks.
      const growingOwnedReply=page.lastRole==='assistant'&&onlyPriorReplies&&!page.transcript?.unclassifiedTail;
      const ownLatestReport=!!page.transcript?.users&&(page.lastRole==='user'||growingOwnedReply)&&
        !page.lastUserTruncated&&!!page.lastUserText&&await this.matchesSavedReceipt(page.lastUserText);
      if(ownLatestReport)return false;
      throw new PageBridgeError('CHAT_INTERVENED','A later user message is visible. Miter paused without importing or sending.');
    }
    const candidate=page.unlinkedReply;
    if(!candidate)return false;
    // Do not interfere with an authenticated ordinary transcript, which has its
    // own completion/format-repair path and may support an older reply format.
    if(page.transcript?.users){
      if(page.lastRole!=='assistant'||!await this.matchesSavedReceipt(page.lastUserText))return false;
      if(page.complete&&page.assistantText)return false;
    }
    const prior=receipt.priorReplyIds??(this.progress?.lastImportedId?[this.progress.lastImportedId]:[]);
    const isNew=!prior.includes(candidate.id)&&candidate.id!==this.progress?.lastImportedId;
    if(!isNew)return false;
    // This is only a freshness observation, not permission to execute. Keep
    // action-schema errors visible for the corrected exchange instead of
    // throwing before the bounded task-link correction can run.
    replyHeaders(candidate.text,w.id,w.projectId);
    const fingerprint=await messageDigest(candidate.text);
    const observation=candidate.id+':'+fingerprint;
    if(observation!==this.unlinkedCandidate){
      this.unlinkedCandidate=observation;this.unlinkedSince=this.now();
      this.unlinkedWaitSince??=this.now();
      this.update('waiting_reply','Reply received. Checking its task link…');return true;
    }
    if(this.now()-this.unlinkedSince<3000)return true;
    const safe=await this.canCorrectUnlinkedReply(page,w);
    if(!safe){
      if(this.now()-(this.unlinkedWaitSince??this.now())>12000)throw new PageBridgeError('REPLY_LINK_MISSING','A code reply is visible, but its task link cannot be verified. Use reply to review it. No actions ran and no Send was repeated.');
      return true;
    }
    const seen=await this.deps.rpc<{seen:boolean}>('worker.handoffSeen',{workerId:w.id,envelopeId:candidate.id});this.check();
    if(seen.seen)throw new PageBridgeError('REPLY_LINK_MISSING','This reply was already imported. No actions were repeated. Use reply or review the task history.');
    if(this.formatRepairs>=2)throw new PageBridgeError('REPLY_LINK_MISSING','The visible reply still has no valid task link after two corrections. Use reply to review it. Progress is saved.');
    this.formatRepairs++;
    this.deps.log('bridge.reply.relink',`Requesting task-link correction ${this.formatRepairs}/2 for one new, unimported reply. No actions from it ran.`);
    const report=await this.reportPrompt(w);this.check();
    await this.send(report+'\n\nTASK-LINK CORRECTION: Your immediately previous JSON reply was NOT imported. It omitted replyTo or used an earlier value. Return that unexecuted next step in a NEW envelope using the CURRENT REPLY CONTRACT above and below. Preserve code literally. Do not repeat actions recorded as successful in the report. Do not claim the rejected batch ran.',page);
    if(!this.pendingSend)this.update('waiting_reply','Waiting for the corrected task-linked reply…');return true;
  }
  /** Shared by active and late receive paths. This grants only a bounded
   * correction request, NEVER execution of the stale envelope. A prior reply,
   * ambiguous/new user turn, draft or changed route cannot qualify. */
  private async canCorrectUnlinkedReply(page:ChatView,w:Worker):Promise<boolean>{
    const r=parseReceipt(this.options.lastReceipt),c=page.unlinkedReply;
    if(!r?.expectsReplyTo||!r.exchangeId||!c||page.busy||page.draft||page.ready===false||page.stopped||isReplyFragment(page)||
      page.transcript?.scanLimited||page.transcript?.unclassifiedTail||
      ['NEWER_USER_MESSAGE','NEWER_TASK_REPLY','AMBIGUOUS_REPLIES','REPLY_IN_PROGRESS','NEWER_REPLY_UNREADABLE'].includes(page.codeReplyIssue||''))return false;
    const prior=r.priorReplyIds??(this.progress?.lastImportedId?[this.progress.lastImportedId]:[]);
    if(prior.includes(c.id)||c.id===this.progress?.lastImportedId||c.replyTo===r.exchangeId)return false;
    try{const h=replyHeaders(c.text,w.id,w.projectId);if(h.id!==c.id||h.replyTo!==c.replyTo)return false;}catch{return false;}
    const route=this.progress?.conversationUrl||this.pinnedConversation||this.status.url;
    if(page.url!==route||!route.includes('/c/')||r.workerId!==w.id||r.projectId!==w.projectId||r.goalHash!==await messageDigest(w.goal))return false;
    const ids=page.codeReplyIds||[],index=ids.indexOf(c.id),fresh=ids.filter(id=>!prior.includes(id)&&id!==this.progress?.lastImportedId);
    if(fresh.length!==1||index<0||!c.hasCopyControl)return false;
    if(page.transcript?.users){
      return page.lastRole==='assistant'&&!page.lastUserTruncated&&!!page.lastUserText&&await this.matchesSavedReceipt(page.lastUserText);
    }
    return index>0&&ids.slice(0,index).some(id=>prior.includes(id));
  }
  private async matchesSavedReceipt(text:string):Promise<boolean> {
    const r=parseReceipt(this.options.lastReceipt),w=this.worker();
    if(!r||r.workerId!==w.id||r.projectId!==w.projectId||r.goalHash!==await messageDigest(w.goal))return false;
    return matchesReceipt(text,r);
  }
  private isPriorUser(page:ChatView):boolean {
    return (!!page.lastUserId&&this.priorUserIds.has(page.lastUserId))||
      (!!page.lastUserText&&norm(page.lastUserText)===norm(this.userBefore));
  }
  private async confirmUserTurn(page:ChatView):Promise<boolean> {
    // A long model generation is not a failed send. Give the page its normal
    // hydration/expansion grace after generation ends; the persisted overall
    // task budget still bounds this wait. Never authorize from busy alone.
    if(page.replyEvidence){
      if(page.draft)throw new PageBridgeError('DRAFT_CONFLICT','Your draft is safe. Mitter paused while you are writing.');
      if(page.busy)return false;
      this.acknowledged=true;return true;
    }
    if(this.options.lastReceipt?.expectsReplyTo&&(page.transcript?.users===0||
       page.transcript?.strategy==='receipt'&&page.transcript.receiptDiscovery?.state==='collapsed')){
      // Revealing a roleless bubble is presentation only. Until its full hash
      // matches, retain the modern code-correlation wait rather than applying
      // the legacy 45-second user-echo timeout to a still-collapsed candidate.
      if(['AMBIGUOUS_REPLIES','NEWER_TASK_REPLY'].includes(page.codeReplyIssue||''))throw new PageBridgeError('REPLY_LINK_MISSING','Several replies conflict with the pending task link. Use reply to select the intended one. Nothing was imported or resent.');
      if(page.draft&&!this.matchesExpected(page.draftText||''))throw new PageBridgeError('DRAFT_CONFLICT','Your draft is safe. Mitter paused while you are writing.');
      if(!page.busy&&this.now()-Math.max(this.sentAt,this.waitUnchangedAt)>300000)throw new PageBridgeError('REPLY_LINK_MISSING','The reply could not be linked automatically. Use reply to choose the existing code; no Send was repeated.');
      return false;
    }
    if(page.busy)this.generationSeenAt=this.now();
    const idleElapsed=(since:number)=>this.now()-Math.max(since,this.generationSeenAt??since);
    const exact=!page.lastUserTruncated&&(this.matchesExpected(page.lastUserText)||await this.matchesSavedReceipt(page.lastUserText));
    const visible=!!page.lastUserText||!!page.lastUserId;
    const prior=this.isPriorUser(page)||!!this.options.lastReceipt?.priorUserHash&&await messageDigest(page.lastUserText)===this.options.lastReceipt.priorUserHash;
    const idChanged=!!this.expectedUserId&&!!page.lastUserId&&page.lastUserId!==this.expectedUserId;
    // Two distinct current user turns with the same text still mean a second
    // send. An optimistic -> persisted ID replacement is allowed only when the
    // old turn is gone and the complete body is identical.
    const duplicate=exact&&idChanged&&(page.userIds||[]).includes(this.expectedUserId);
    const shape=`ack=${this.acknowledged}; match=${exact}; visible=${visible}; prior=${prior}; duplicate=${duplicate}; truncated=${!!page.lastUserTruncated}; observedChars=${page.lastUserText.length}; expectedChars=${this.expectedUser.length}; ids=${(page.userIds||[]).length}; reader=${page.userReader==='user-turn/6'?'user-turn/6':page.userReader==='user-turn/5'?'user-turn/5':page.userReader==='user-turn/4'?'user-turn/4':page.userReader==='user-turn/3'?'user-turn/3':page.userReader==='user-turn/2'?'user-turn/2':'legacy'}.`;
    if(shape!==this.lastUserDiagnostic){
      this.lastUserDiagnostic=shape;this.deps.log('bridge.user.observe',shape);
      if(!exact&&visible){
        const r=parseReceipt(this.options.lastReceipt),frame=unwrapMessage(page.lastUserText),stats=page.lastUserReadStats;
        const observed=await messageDigest(page.lastUserText);
        const details={restoring:this.restoringPendingSend,stage:this.progress?.stage||'legacy',
          receiptAvailable:!!r,observedMatchesText:r?.textHash===observed,observedMatchesRendered:r?.renderedHash===observed,
          observedMatchesAcknowledged:r?.acknowledgedHash===observed,framed:!!frame,
          sameExchange:!!frame&&frame.exchangeId===r?.exchangeId,
          payloadMatches:!!frame&&!!r?.payloadHash&&await messageDigest(frame.payload)===r.payloadHash,
          candidates:page.lastUserCandidates?.length||0,
          structure:stats?{roles:stats.roleElements,pres:stats.preElements,codes:stats.codeElements,frames:stats.framedCandidates}:undefined};
        this.deps.log('bridge.user.compare',JSON.stringify(details));
      }
    }
    if(page.draft&&!this.matchesExpected(page.draftText||''))throw new PageBridgeError('DRAFT_CONFLICT','Your draft is safe. Automatic mode paused while you are writing.');
    if(exact&&!duplicate){
      if(!this.acknowledged){this.deps.log('bridge.ack','Exact outgoing user message confirmed. DOM message counts are not used as identity.');}
      else if(idChanged)this.deps.log('bridge.user.rebind','The page replaced a user-message ID; its full text still matches.');
      if(this.restoringPendingSend||this.status.reason.startsWith('Confirming the task’s first message')||this.status.reason.startsWith('Reading the full sent message'))this.update('waiting_reply',page.busy?'ChatGPT is working…':'Checking the existing reply…');
      this.restoringPendingSend=false;this.expectedUser=page.lastUserText;this.acknowledged=true;this.userCount=page.userCount;this.expectedUserId=page.lastUserId||this.expectedUserId;
      this.userObservation='';this.visibilitySince=undefined;
      const receipt=parseReceipt(this.options.lastReceipt);
      if(receipt){
        const hash=await messageDigest(page.lastUserText);
        if(receipt.acknowledgedHash!==hash||receipt.acknowledgedUserId!==this.expectedUserId){
          this.options.lastReceipt={...receipt,acknowledgedHash:hash,acknowledgedUserId:this.expectedUserId||undefined};
          await this.deps.saveReceipt?.(this.options.lastReceipt);await this.checkpoint();
        }
      }
      if(page.draft)return false; // Own sent draft is still clearing; do not execute yet.
      return true;
    }
    if(page.lastUserCollapsed){
      // The page is withholding text behind its own disclosure, not showing a
      // different human instruction. The reader expands only our known latest
      // user bubble. Until the COMPLETE receipt matches, never send or import.
      this.userObservation='';
      if(this.visibilitySince===undefined)this.visibilitySince=this.now();
      if(!page.busy&&idleElapsed(this.visibilitySince)>30000){
        throw new PageBridgeError('MESSAGE_COLLAPSED','ChatGPT kept the sent message collapsed, so Mitter could not verify its full text. No message was sent again. Open chat and expand Show more, then Resume; your saved progress is unchanged.');
      }
      this.update('waiting_reply','Reading the full sent message… Your progress is saved.');
      return false;
    }
    // Preserve the established safe-resume path when the user turn is absent:
    // only the exact, already-validated owned assistant reply adopted at startup.
    if(!visible&&this.acknowledged&&this.adoptedAssistantReceipt&&this.replyFingerprint(page)===this.adoptedAssistantReceipt&&!page.busy&&page.complete)return true;
    if(this.pendingConversationBind&&!this.acknowledged&&visible&&!prior&&!page.lastUserTruncated){
      // Before the first acknowledgement there is no confirmed baseline from
      // which to infer a human edit. Wait for the exact saved message instead
      // of accusing the user or requesting another model reply. This does not
      // authorize adoption by matching IDs/markers alone.
      if(this.visibilitySince===undefined)this.visibilitySince=this.now();
      if(!page.busy&&(idleElapsed(this.sentAt)>45000||idleElapsed(this.visibilitySince)>45000)){
        throw new PageBridgeError('FIRST_SEND_UNCONFIRMED','Mitter could not verify the first task message on the page. No send was repeated and no reply was imported. Resume checks the same chat; Copy diagnostics shows the comparison.');
      }
      this.update('waiting_reply','Confirming the task’s first message… Nothing will be sent twice.');
      return false;
    }
    if(!visible||prior||page.lastUserTruncated){
      // Virtualization, hydration and truncation are lack of evidence, not a
      // foreign message. Wait read-only; never click Send again or import a reply.
      this.userObservation='';if(this.visibilitySince===undefined)this.visibilitySince=this.now();
      if(!page.busy&&((!this.acknowledged&&idleElapsed(this.sentAt)>45000)||idleElapsed(this.visibilitySince)>45000)){
        throw new PageBridgeError('USER_TURN_UNCONFIRMED','The send could not be confirmed in the page. No send was repeated. Resume rechecks the existing conversation.');
      }
      return false;
    }
    // A partially hydrated bubble must be observed unchanged twice before it is
    // called an intervention. Nothing executes during this bounded grace period.
    const observation=(page.lastUserId||'')+'\n'+page.lastUserText;
    if(observation!==this.userObservation){this.userObservation=observation;this.conflictSince=this.now();return false;}
    if(this.now()-this.conflictSince<1800)return false;
    // On a legacy Resume, a stable hash mismatch alone does not prove that the
    // user changed anything. Keep the same task/chat, but report missing proof
    // honestly rather than blaming an edit. Do not bypass the check or resend.
    if(this.restoringPendingSend)throw new PageBridgeError('SAVED_SEND_MISMATCH','Mitter could not match this older chat message to its saved send. Nothing was resent or replayed. Your task and files are preserved; Copy diagnostics shows the comparison.');
    throw new PageBridgeError('CHAT_INTERVENED','The latest chat message no longer matches Mitter’s confirmed exchange. Automatic mode paused. Your files are preserved.');
  }
  private recover(error:unknown,phase:string):boolean{
    if(!this.status.active||!(error instanceof PageBridgeError)||!error.transient||phase==='sending')return false;
    if(['TAB_FROZEN','TAB_DISCARDED'].includes(error.code)){
      if(phase!=='reconnecting')this.recoveryPhase=phase;
      this.update('reconnecting','Chrome suspended this chat. Waiting for the document to resume; nothing is being resent.');return true;
    }
    if(this.recoverySince===undefined){this.recoverySince=this.now();this.recoveryPhase=phase==='reconnecting'?this.recoveryPhase:phase;}
    const savedReport=this.progress?.stage==='report_due'&&['running','waiting_approval'].includes(this.recoveryPhase);
    if(this.now()-this.recoverySince>=(savedReport?300000:30000))return false;
    if(savedReport){this.update('reconnecting','Local batch saved. Reconnecting to send its report; no files or prompts are being repeated.');return true;}
    this.update('reconnecting',error.code==='TRANSCRIPT_LOADING'?'Reading the chat messages… Nothing is being sent again.':'Reconnecting to the chat… Your progress is saved.');return true;
  }
  /** A sent prompt and an absent response are different from an uncertain
   * Send. Ask once for a fresh answer only after two idle minutes, a full exact
   * user receipt, an empty response tail and a second live check. The existing
   * durable repair budget caps this at two per accepted batch, even on restart.
   * Never click the provider's Retry, replay the original send or cached JSON. */
  private async recoverAbsentReply(page:ChatView,w:Worker):Promise<boolean> {
    const receipt=parseReceipt(this.options.lastReceipt);
    if(!receipt?.expectsReplyTo||!receipt.exchangeId||this.progress?.stage!=='waiting_reply')return false;
    const prior=receipt.priorReplyIds??(this.progress.lastImportedId?[this.progress.lastImportedId]:[]);
    this.gapObservation=this.replyGap.observe(page,receipt.exchangeId,prior,this.now());
    const gap=this.gapObservation;
    if(!gap.missing){this.gapLogged='';return false;}
    if(gap.started&&this.gapLogged!==receipt.exchangeId){
      this.gapLogged=receipt.exchangeId;
      this.deps.log('bridge.reply.gap','The current response was observed, then its readable content disappeared. Retaining the pending exchange; no partial or cached reply will be applied.');
    }
    if(gap.elapsedMs<REPLY_GAP_IDLE_MS||!hasEmptyResponseTail(page)||
       !await this.matchesSavedReceipt(page.lastUserText))return false;
    const route=this.progress.conversationUrl||this.status.url;
    if(page.url!==route||!route.includes('/c/')||this.pendingConversationBind||this.pendingDelivery||this.pendingSend)return false;
    const snapshot=await this.deps.rpc<Snapshot>('state',{});this.check();
    const current=snapshot.workers.find(item=>item.id===w.id&&item.projectId===w.projectId);
    if(!current||current.mode!=='handoff'||!['idle','review'].includes(current.state)||current.queue.length||current.pending||
      current.humanAcceptanceReady||(current.control?.epoch??0)!==this.executionEpoch||current.control?.mode==='stopped')return false;
    // The DOM may have recovered, a draft may have been entered or Pause may
    // have been clicked while the native check was in flight. No stale snapshot
    // can authorize even a recovery message. Defer to the next ordinary tick.
    const fresh=await this.page('inspect');this.check();
    if(this.options.lastReceipt?.exchangeId!==receipt.exchangeId||fresh.url!==route||
       !hasEmptyResponseTail(fresh)||!await this.matchesSavedReceipt(fresh.lastUserText))return true;
    if(this.formatRepairs>=2)throw new PageBridgeError('REPLY_RECOVERY_EXHAUSTED',
      'ChatGPT has not supplied a readable response after two recovery requests. No missing reply was executed. Check the linked chat; Miter will not keep sending messages.');
    this.formatRepairs++;await this.checkpoint();this.check();
    this.deps.log('bridge.reply.recovery',`Verified the exact sent message and empty response tail twice. Requesting a fresh response (${this.formatRepairs}/2); no prior batch or Send is replayed.`);
    await this.send(`${this.nextPrompt}

MISSING RESPONSE RECOVERY
The previous exchange was sent, but no complete response remains readable. Miter did not import any actions for that pending exchange. Earlier accepted batches remain applied. Do not repeat them. Inspect the current project with a small read/list batch before proposing more changes. Use a NEW reply id and this message's CURRENT REPLY CONTRACT. Return one complete fenced json block.`,fresh);
    return true;
  }
  /** Bounded no-progress guard. A completed-but-unusable code widget must not
   * disappear into a generic model wait. This never grants import permission. */
  private observeReplyWait(page:ChatView):boolean {
    // Empty, confirmed ordinary exchanges need a no-progress guard too.
    // Before confirmation, keep the more specific receipt/identity diagnosis;
    // a missing sent-message proof is not a model response-format failure.
    const prior=this.options.lastReceipt?.priorReplyIds??(this.progress?.lastImportedId?[this.progress.lastImportedId]:[]);
    const history=isHistoricalReply(page,prior),fragment=isReplyFragment(page);
    const codeLane=page.codeRead||page.codeReplyIssue||page.codeReply||page.unlinkedReply;
    if(!codeLane&&page.assistantText&&!history)return false;
    if(page.busy||page.ready===false){this.waitUnchangedAt=this.now();this.waitObservation='';return history;}
    // Historical blocks do not reset the current reply's idle deadline, and do
    // not supply its error reason. A fresh fragment does reset that deadline.
    const observation=history?'history':JSON.stringify([page.assistantId,page.assistantText,page.complete,page.codeReply?.id,page.codeReply?.text.length,page.codeReplyIssue,page.codeReplyIds,page.codeRead?.fingerprint,page.codeRead?.issue]);
    if(observation!==this.waitObservation){
      this.waitObservation=observation;this.waitUnchangedAt=this.now();
      if(fragment)this.generationSeenAt=this.now();
    }
    if(!codeLane&&!this.acknowledged)return history;
    const visible=!history&&(!!page.codeReply||!!page.unlinkedReply||!!page.assistantText||!!page.codeRead?.characters);
    const elapsed=this.now()-this.waitUnchangedAt;
    if(!page.replyEvidence&&elapsed>=(visible&&!fragment?45000:120000)){
      this.deps.log('bridge.wait.blocked',JSON.stringify({issue:history?'WAITING_CURRENT_REPLY':page.codeReplyIssue,read:history?undefined:page.codeRead,complete:page.complete,busy:page.busy,elapsedMs:elapsed}));
      const explanations:Record<string,string>={
        INVALID_JSON:'The visible reply is not valid complete JSON. Ask for one fenced json block, not an escaped Markdown copy.',
        STALE_REPLY_TO:'The reply still names an older exchange. It cannot answer the current pending message; ask for a new id and the latest CURRENT REPLY CONTRACT.',
        MISSING_REPLY_TO:'The reply is missing replyTo, so its pending exchange cannot be verified.',
        PLAIN_REPLY_REQUIRES_FENCE:'The unfenced reply includes actions beyond read-only inspection. Request the complete reply in a fenced json block.',
        MARKDOWN_TRANSFORMED:'Markdown formatting changed the visible reply. Request literal fenced JSON; Miter will not reconstruct source code.',
        PLAIN_STRING_LAYOUT:'A rendered line break splits a JSON string. Request literal fenced JSON.',
        PLAIN_HIDDEN_CONTENT:'The plain reply contains hidden content. Request one visible fenced json block.',
      };
      const explanation=fragment?'The new reply stopped arriving before its JSON was complete.':explanations[page.codeReplyIssue||'']||explanations[page.codeRead?.issue||'']||'Its full JSON or task link could not be verified.';
      if(!visible&&this.gapObservation.started)throw new PageBridgeError('REPLY_DISAPPEARED',
        'The current response started, then disappeared from the readable page. No partial response was applied. Its sent-message/response boundary could not be verified for automatic recovery. Still checking the same chat.');
      throw new PageBridgeError(visible?'REPLY_UNREADABLE':'REPLY_NOT_ADVANCING',visible?
        'A reply is visible. '+explanation+' Use reply to inspect it, or Stop then Continue fresh. No rejected actions ran.':
        'No new readable reply appeared. Progress is saved. Use reply or Stop then Continue fresh instead of waiting indefinitely.');
    }
    if(history)this.update('waiting_reply',this.gapObservation.started?'The current reply disappeared. Checking for its return before requesting a fresh response…':'Waiting for the current reply… Earlier replies are already accounted for.');
    else if(fragment)this.update('waiting_reply','Receiving the current JSON reply… Waiting for it to finish.');
    else if(visible&&!page.replyEvidence&&elapsed>=8000)this.update('waiting_reply','Reply detected. Checking its full JSON and task link…');
    // Still run draft/user-turn checks in the caller before honoring this hold.
    return history||page.codeReplyIssue==='REPLY_IN_PROGRESS'||page.codeReplyIssue==='NEWER_REPLY_UNREADABLE';
  }
  /** Best-effort independent Pause observation. A missing page cannot hold
   * local edits hostage, but the floating page Pause control must still work.
   * At most one bounded transport request is in flight. An obsolete response
   * cannot stop a new phase or a new coordinator, and never mutates a receipt. */
  private pollLocalPause():void {
    if(this.localPauseCheck)return;
    const current=()=>this.status.active&&['running','waiting_approval'].includes(this.status.phase);
    const pause=async()=>{if(current())await this.stop('Paused from the chat page.','stopped','STOPPED');};
    const job=this.deps.page(this.options.tabId,{op:'control',token:this.options.token,
      url:this.progress?.conversationUrl||this.status.url,expiresAt:this.now()+15000})
      .then(async view=>{if(view.stopped)await pause();})
      .catch(async error=>{if(error instanceof PageBridgeError&&error.code==='STOPPED')await pause();})
      .finally(()=>{if(this.localPauseCheck===job)this.localPauseCheck=undefined;});
    this.localPauseCheck=job;
    // Stop itself normally resolves errors into status. Keep a final rejection
    // handler nevertheless; no background timer may create an unhandled error.
    void job.catch(()=>{});
  }
  private teamPhase:string|undefined;
  async tick():Promise<void> {
    if(this.status.monitoring){await this.watchForReply();return;}
    // The watcher becomes active before its durable resume checkpoint ends.
    // Do not overlap a normal poll with that handover or replace its idle barrier.
    if(this.busy||this.watchRunning||!this.status.active)return;
    this.busy=true;this.operationIdle=new Promise(resolve=>{this.operationDone=resolve;});
    let phase=this.status.phase==='reconnecting'?this.recoveryPhase:this.status.phase;
    try{
      // Snapshot loss and held teammates are still inside the same guarded
      // lifecycle. Neither is allowed to throw an unhandled timer rejection or
      // bypass the stopped epoch / active-time budget.
      this.check();let w=this.worker();
      if(w.teamPaused){this.teamPhase??=phase;this.update('waiting_team',w.teamPaused);return;}
      if(this.teamPhase){phase=this.teamPhase;this.teamPhase=undefined;this.update(phase,'Continuing after team coordination…');}
      // UI snapshots are deliberately debounced by the native host. Never use
      // an older batch's 'review' event to decide that the current batch ended.
      if(['running','waiting_approval'].includes(phase)){
        const fresh=await this.deps.rpc<Snapshot>('state',{});this.check();
        const current=fresh.workers.find(item=>item.id===this.options.workerId&&item.projectId===this.options.projectId);
        if(!current)throw new Error('The task is no longer available.');w=current;
      }
      if(['running','waiting_approval'].includes(phase))this.pollLocalPause();
      if(this.pendingDelivery){await this.advanceDelivery();return;}
      if(w.state==='complete'){await this.stop(w.checks.length?'Goal complete — checks passed':'Finished — no automated checks configured','complete');return;}
      if(w.humanAcceptanceReady){await this.stop('Ready for your review','review');return;}
      if(this.pendingSend){await this.advanceSend();return;}
      if(phase==='connecting'){await this.initialise();this.recoverySince=undefined;return;}
      if(['running','waiting_approval'].includes(phase)){
        // The accepted batch already passed the chat authority checks. Its
        // filesystem/approval lifecycle must not depend on a hidden chat's
        // DOM, a changing code widget, or the provider being reachable.
        if(w.state==='awaiting_approval'){this.update('waiting_approval','A command needs your approval');return;}
        if(['blocked','paused','cancelled'].includes(w.state))throw new Error(w.error||`Worker ${w.state}. Review before continuing.`);
        if(w.state!=='review'){
          this.update('running',w.state==='waiting_lock'?'Waiting for another local task to release these files…':'Applying the accepted batch locally…');return;
        }
        if(w.queue.length)throw new Error('Unexpected queued work. Stopped rather than mixing batches.');
        await this.checkpoint('report_due');
        // Preserve the existing visible phase and durable stage, but recovery
        // now knows local files are saved and only the report remains to send.
      }
      const page=await this.page('inspect');this.check();
      if(this.status.phase==='reconnecting'){this.update(phase,phase==='running'?'Working on your project…':'Waiting for ChatGPT…');}this.recoverySince=undefined;
      if(page.ready===false){throw new PageBridgeError('PAGE_LOADING','The chat is reloading.',true);}
      // React may clear its composer after the click response has returned.
      // The exact saved outgoing draft is not evidence of a human intervention.
      // Wait read-only; never run a correction or import while it is present.
      if(phase==='waiting_reply'&&page.draft&&(this.matchesExpected(page.draftText)||await this.matchesSavedReceipt(page.draftText))){
        if(!page.busy&&this.now()-this.sentAt>45000)throw new PageBridgeError('SEND_UNCERTAIN_DRAFT','The prepared prompt is still in ChatGPT’s input. Send was requested but not confirmed; watching for it to clear without a duplicate click.');
        this.update('waiting_reply','Waiting for ChatGPT to clear the submitted prompt… Nothing is being sent twice.');return;
      }
      if(phase==='waiting_reply'&&await this.recoverUnlinkedReply(page,w))return;
      if(phase==='waiting_reply'&&await this.recoverAbsentReply(page,w))return;
      const holdReply=phase==='waiting_reply'&&this.observeReplyWait(page);
      if((this.expectedUser||this.restoringPendingSend)&&!await this.confirmUserTurn(page))return;
      if(holdReply){this.candidate='';return;}
      if(this.pendingConversationBind&&page.url!==this.status.url)return;
      if(page.draft&&(['running','waiting_approval'].includes(phase)||this.acknowledged))throw new PageBridgeError('DRAFT_CONFLICT','You started a draft. Automatic mode paused and left it untouched.');
      if(['running','waiting_approval'].includes(phase)){
        if(w.state==='awaiting_approval'){this.update('waiting_approval','A command needs your approval');return;}
        if(['blocked','paused','cancelled'].includes(w.state))throw new Error(w.error||`Worker ${w.state}. Review before continuing.`);
        if(w.state!=='review')return;
        if(w.queue.length)throw new Error('Unexpected queued work. Stopped rather than mixing batches.');
        if(page.busy){this.update('running','Local batch saved. Waiting for ChatGPT to be ready for its report…');return;}
        await this.send(await this.reportPrompt(w),page);return;
      }
      if(phase!=='waiting_reply')return;
      // A thinking model can take longer than the old fixed three-minute limit.
      // Keep waiting while generation is visible, bounded by the session budget.
      if(this.now()-this.sentAt>300000&&!page.busy&&!page.complete)throw new PageBridgeError('REPLY_NOT_ADVANCING','ChatGPT has not returned a reply. Open the linked chat to check it.');
      if((page.count<=this.baseline&&page.assistantId===this.assistantBefore&&page.assistantText===this.assistantTextBefore)||page.lastRole!=='assistant'||page.busy||!page.complete){this.candidate='';return;}
      const candidate=this.replyFingerprint(page);
      const receipt=parseReceipt(this.options.lastReceipt);
      if(receipt?.priorAssistantHash&&await messageDigest(candidate)===receipt.priorAssistantHash){this.candidate='';return;}
      if(candidate!==this.candidate){this.candidate=candidate;this.stableSince=this.now();return;}
      if(this.now()-this.stableSince<1800)return;
      if(this.pendingConversationBind&&!this.status.url.includes('/c/')){
        if(this.now()-this.sentAt>60000)throw new PageBridgeError('CHAT_BIND_TIMEOUT','ChatGPT has not supplied this task’s conversation link. The reply was not executed.');
        this.update('waiting_reply','Waiting for the conversation to be saved…');return;
      }
      let envelope:ReturnType<typeof parseEnvelope>;
      try{envelope=this.parseReply(page);}catch(error){
        // A code widget can stream without a detectable Stop button. Never
        // interrupt an open file-content string just because the DOM stayed
        // unchanged for the normal 1.8-second complete-reply stability check.
        // No source is reconstructed; after 15 quiet seconds the existing
        // bounded correction path handles a genuinely truncated reply.
        if(isIncompleteReplyJSON(page.assistantText)&&this.now()-this.stableSince<15000){
          this.update('waiting_reply','Receiving the file changes… Waiting for the complete JSON reply.');return;
        }
        await this.repairReply(w,page,error);return;
      }
      await this.importEnvelope(envelope,w,page);
    }catch(error){if(this.status.active&&!this.recover(error,phase))await this.stop(message(error),'error',code(error));}
    finally{
      if(this.status.active)try{await this.checkpoint(undefined,false);}catch(error){await this.stop(message(error),'error',code(error));}
      this.busy=false;this.operationDone?.();
    }
  }
  /** Inspect only the recorded task tab. No send/import happens in this method. */
  private async watchView():Promise<ChatView>{
    const route=this.progress?.conversationUrl||this.status.url;
    return this.deps.page(this.options.tabId,{op:'inspect',token:this.options.token,url:route,expiresAt:this.now()+15000,
      allowConversationBind:this.pendingConversationBind&&!route.includes('/c/'),workerId:this.options.workerId,projectId:this.options.projectId,
      receipt:parseReceipt(this.options.lastReceipt),replyTo:this.options.lastReceipt?.exchangeId});
  }
  private async watchCandidateText(view:ChatView):Promise<string|undefined>{
    const r=this.options.lastReceipt;
    if(!r?.expectsReplyTo||!r.exchangeId||view.stopped||view.busy||view.draft||view.ready===false||view.transcript?.scanLimited||view.transcript?.unclassifiedTail)return;
    const route=this.progress?.conversationUrl||this.status.url;
    if(route.includes('/c/')&&view.url!==route)return;
    try{conversationURL(view.url);}catch{return;}
    if(view.codeReplyCount!==undefined&&view.codeReplyCount>1)return;
    if(['NEWER_USER_MESSAGE','AMBIGUOUS_REPLIES','NEWER_TASK_REPLY'].includes(view.codeReplyIssue||''))return;
    // Reuse the normal read-only authority checks. A collapsed/virtualized
    // sent bubble must not make late recovery stricter than the active reader,
    // but a complete contradictory user turn still blocks both paths.
    delete view.replyEvidence;
    await this.normalizeUserEcho(view);
    if(view.lastUserText&&!view.lastUserCollapsed&&!view.lastUserTruncated&&!await this.matchesSavedReceipt(view.lastUserText))return;
    await this.selectDirectReply(view);
    const raw=view.replyEvidence?view.assistantText:
      view.complete&&!view.assistantReadIssue?view.assistantText:'';
    if(!raw||!view.complete)return;
    try{
      const e=boundReply(raw,this.options.workerId,this.options.projectId);
      if(view.assistantFormat==='plain'&&!isReadOnlyReply(e))return;
      if(e.replyTo!==r.exchangeId||e.id===this.progress?.lastImportedId)return;
      if(e.actions.some(a=>'base' in a)){
        const admission=await this.deps.rpc<{valid:boolean}>('worker.validateReply',{workerId:this.options.workerId,text:JSON.stringify(e),epoch:this.executionEpoch});
        if(admission.valid!==true)return;
      }
      if(!view.replyEvidence&&view.lastUserText&&(view.lastUserTruncated||!await this.matchesSavedReceipt(view.lastUserText)))return;
      return raw;
    }catch{return;}
  }
  private resumeWatchClock():void {
    if(!this.status.monitoring)throw Error('Reply monitoring was stopped.');
    if(!this.progress)throw Error('Saved task progress is unavailable.');
    const w=this.worker();if((w.control?.epoch??0)!==this.executionEpoch||w.control?.mode==='stopped')throw new PageBridgeError('RUN_SUPERSEDED','Task stopped or replaced.');
    const used=Math.max(this.progress.activeMs,this.status.activeMs||0);
    if(used>=this.progress.maxMinutes*60000)throw new PageBridgeError('TIME_LIMIT','The active-time budget is exhausted. Add time before continuing.');
    this.activeBase=used;this.resumedAt=this.now();this.finishedAt=undefined;this.expiresAt=this.now()+this.progress.maxMinutes*60000-used;
    this.status.monitoring=false;delete this.status.receiving;delete this.status.watchUntil;this.status.active=true;this.status.errorCode=undefined;
    this.recoverySince=undefined;this.waitObservation='';this.waitUnchangedAt=this.now();this.visibilitySince=undefined;this.unlinkedCandidate='';this.unlinkedWaitSince=undefined;
  }
  private async watchForReply():Promise<void>{
    if(this.busy||this.watchRunning)return;
    if(this.now()>=(this.status.watchUntil||0)){await this.stop(`The ${LATE_REPLY_WATCH_MS/60000}-minute reply watch ended. Use Resume to check again.`,'stopped');return;}
    if(this.now()-this.watchPollAt<1500||this.now()<this.watchRetryAt)return;
    this.watchRunning=true;this.watchPollAt=this.now();
    this.operationIdle=new Promise(resolve=>{this.operationDone=resolve;});
    try{
      const w=this.worker();if(w.control?.mode==='stopped'||(w.control?.epoch??0)!==this.executionEpoch){await this.stop('This execution plan was stopped or replaced.');return;}
      if(w.state==='complete'){await this.stop('Task complete.','complete');return;}
      const view=await this.watchView();if(!this.status.monitoring)return;
      if(this.now()>=(this.status.watchUntil||0)){await this.stop(`The ${LATE_REPLY_WATCH_MS/60000}-minute reply watch ended. Use Resume to check again.`,'stopped');return;}
      if(this.watchErrorCode){this.deps.log('bridge.watch.reconnected','The reply reader is responding again. No prompt was resent.');this.update('error',this.watchReason);}
      this.watchErrorCode='';this.watchFailures=0;this.watchRetryAt=0;
      if(view.stopped){await this.stop('Paused from the chat page.');return;}
      const route=this.progress?.conversationUrl||this.status.url;
      if(route.includes('/c/')&&view.url!==route){await this.stop('The linked tab left this task’s conversation. Resume returns to its saved chat.','stopped','NAVIGATED');return;}
      if(!view.draft&&(view.busy||isReplyFragment(view))){
        this.watchCandidate='';this.status.receiving=true;
        this.update('waiting_reply',view.busy?'ChatGPT is generating a reply. Miter will verify its task link before continuing; nothing is being resent.':'Receiving a new JSON reply. Miter is waiting for a complete, verified answer; nothing is being resent.');
        return;
      }
      const text=await this.watchCandidateText(view);if(!this.status.monitoring)return;
      const correction=!text&&this.formatRepairs<2&&await this.canCorrectUnlinkedReply(view,w);
      if(!this.status.monitoring)return;
      if(!text&&!correction){
        if(this.status.receiving){delete this.status.receiving;this.update('error',this.watchReason);}
        this.watchCandidate='';return;
      }
      const fingerprint=(correction?'correction:':'reply:')+await messageDigest(text||view.unlinkedReply!.text);if(!this.status.monitoring)return;
      if(this.watchCandidate!==fingerprint){this.watchCandidate=fingerprint;this.watchStableAt=this.now();return;}
      if(this.now()-this.watchStableAt<(correction?3000:1800))return;
      if(this.now()>=(this.status.watchUntil||0)){await this.stop(`The ${LATE_REPLY_WATCH_MS/60000}-minute reply watch ended. Use Resume to check again.`,'stopped');return;}
      // Resume the SAME coordinator; it runs its ordinary receipt/schema/hash/
      // duplicate checks on the next tick. The watch never imports directly.
      this.resumeWatchClock();
      const exactEcho=view.lastUserText&&await this.matchesSavedReceipt(view.lastUserText);this.check();
      if(exactEcho){
        this.expectedUser=view.lastUserText;this.expectedUserId=view.lastUserId||'';this.userCount=view.userCount;this.acknowledged=true;
      }
      this.sentAt=this.now();this.candidate='';this.update('waiting_reply','Reply received. Checking it before continuing…');
      this.deps.log('bridge.attention.resolved',correction?'A fresh unimported reply needs a task-link correction. Re-entering the same bounded correction path; the stale actions are not authorized.':'A stable task-linked reply appeared. Re-entering normal validation without resending the prompt.');await this.checkpoint();
    }catch(error){
      if(this.status.active){await this.stop(message(error),'error',code(error));return;}
      if(!this.status.monitoring)return;
      if(error instanceof PageBridgeError&&['STOPPED','NAVIGATED','RUN_SUPERSEDED','TIME_LIMIT','PROGRESS_SAVE_FAILED'].includes(error.code)){await this.stop(message(error),'stopped',error.code);return;}
      // Missing observations break reply stability. Back off only reads, not
      // the saved absolute deadline, and surface the actual recovery state.
      delete this.status.receiving;this.watchCandidate='';this.watchStableAt=0;
      this.watchFailures=Math.min(this.watchFailures+1,4);
      this.watchRetryAt=this.now()+Math.min(15000,1500*2**this.watchFailures);
      const errorCode=code(error)||'PAGE_READ_FAILED';
      if(this.watchErrorCode!==errorCode){
        this.watchErrorCode=errorCode;this.deps.log('bridge.watch.retry',errorCode+': '+message(error));
        this.update('error','The chat reader is not responding. Rechecking this same chat automatically; nothing is being resent. Open chat to check its connection, or Stop to end the watch.');
      }
    }finally{this.watchRunning=false;this.operationDone?.();}
  }
  async recoveryPrompt():Promise<string>{
    if(!this.status.monitoring)throw Error('This task is not waiting for a missing reply.');
    if(this.expectedUser&&await this.matchesSavedReceipt(this.expectedUser))return this.expectedUser;
    const view=await this.watchView();if(view.lastUserText&&!view.lastUserTruncated&&await this.matchesSavedReceipt(view.lastUserText))return view.lastUserText;
    throw Error('The exact sent text is not available locally. Open the chat and copy its last Miter message. Nothing was reconstructed.');
  }
  async resendPrompt(confirm:boolean):Promise<{sent:boolean;replyFound?:boolean;pending?:boolean}>{
    if(confirm!==true||!this.status.monitoring||this.busy||this.watchRunning)throw Error('Resend is only available after your confirmation while waiting for a reply.');
    this.busy=true;this.operationIdle=new Promise(resolve=>{this.operationDone=resolve;});
    try{
      const view=await this.watchView();if(!this.status.monitoring)throw Error('Task stopped during resend.');
      if(view.busy||view.draft||isReplyFragment(view))throw Error('ChatGPT is answering, receiving JSON, or has a draft. Nothing was resent.');
      if(await this.watchCandidateText(view)){return {sent:false,replyFound:true};}
      if(view.lastUserText&&(view.lastUserTruncated||!await this.matchesSavedReceipt(view.lastUserText)))throw Error('The chat contains a different user message. Nothing was resent.');
      const text=await this.recoveryPrompt();this.resumeWatchClock();this.check();
      // Explicit human retry only; retains the exact bytes and reply nonce,
      // reserves another turn, and never repeats an imported action batch.
      await this.send(text,view,true);const pending=!!this.pendingSend;this.deps.log('bridge.resend',pending?'User requested one resend; the background coordinator is waiting for the composer.':'User explicitly resent the exact pending prompt. No action history was replayed.');return {sent:!pending,...(pending?{pending:true}:{})};
    }catch(error){if(this.status.active)await this.stop(message(error),'error',code(error));throw error;}
    finally{this.busy=false;this.operationDone?.();}
  }
  async stop(reason='Stopped by you',phase='stopped',errorCode?:string):Promise<void>{
    if(!this.status.active&&!this.status.monitoring)return;
    const recoverable=new Set(['REPLY_DISAPPEARED','REPLY_RECOVERY_EXHAUSTED','SEND_UNCERTAIN_DRAFT','REPLY_UNREADABLE','REPLY_NOT_ADVANCING','REPLY_LINK_MISSING','REPLY_FORMAT','USER_ECHO_UNREADABLE','USER_TURN_UNCONFIRMED','FIRST_SEND_UNCONFIRMED','MESSAGE_COLLAPSED','TRANSCRIPT_UNSUPPORTED',
      'BRIDGE_TIMEOUT','BRIDGE_DISCONNECTED','BRIDGE_INJECTION_FAILED','BRIDGE_NAVIGATED','INVALID_BRIDGE_REPLY','INVALID_PAGE_STATE','STALE_PAGE_READER','TAB_FROZEN','TAB_DISCARDED']);
    // A receive-side error is not a user Stop. Suspend sending/execution while
    // keeping a narrowly scoped read-only watcher on the pending exchange.
    if(phase==='error'&&errorCode&&recoverable.has(errorCode)&&this.options.lastReceipt?.expectsReplyTo&&this.progress&&['waiting_reply','commit_intent'].includes(this.progress.stage)&&!this.status.monitoring){
      this.status.active=false;this.status.monitoring=true;this.status.watchUntil=this.now()+LATE_REPLY_WATCH_MS;
      this.finishedAt=this.now();this.status.errorCode=errorCode;this.watchCandidate='';this.watchPollAt=0;this.watchRetryAt=0;this.watchFailures=0;this.watchErrorCode='';
      this.watchReason=reason+' Still watching this chat for a verified reply. Open chat to intervene, or use Resend prompt.';
      this.update('error',this.watchReason);
      this.deps.log('bridge.attention',`Sending paused. Read-only late-reply watch is active for ${LATE_REPLY_WATCH_MS/60000} minutes; no prompt is automatically resent.`);
      try{await this.checkpoint();}catch(error){this.status.monitoring=false;this.status.errorCode='PROGRESS_SAVE_FAILED';this.update('error',message(error));}
      return;
    }
    this.pendingSend=undefined;this.pendingDelivery=undefined;
    const wasMonitoring=this.status.monitoring;delete this.status.receiving;this.status.monitoring=false;delete this.status.watchUntil;
    const priorPhase=this.status.phase==='reconnecting'?this.recoveryPhase:this.status.phase;
    this.status.active=false;if(!wasMonitoring)this.finishedAt=this.now();this.status.errorCode=errorCode;this.update(phase,reason);this.deps.log('bridge.stop',reason);
    // Publish Stop before waiting for local work or a page reply.
    const w=this.deps.snapshot()?.workers.find(w=>w.id===this.options.workerId);
    const tasks:Promise<unknown>[]=[];
    if(w&&!['complete','review'].includes(phase)&&(inFlight.has(w.state)||['running','waiting_approval'].includes(priorPhase)))tasks.push(this.deps.rpc('worker.pause',{workerId:w.id,epoch:this.executionEpoch}).catch(()=>{}));
    tasks.push(this.page('stop').catch(()=>{}));
    tasks.push(this.checkpoint(phase==='complete'?'complete':phase==='review'?'review':undefined).catch(error=>this.deps.log('bridge.storage.error',message(error))));
    await Promise.all(tasks);
  }
}
function message(error:unknown):string{return error instanceof Error?error.message:String(error);}
function code(error:unknown):string|undefined{return error instanceof PageBridgeError?error.code:undefined;}

export { DataResetCoordinator, DATA_RESET_KEY, type DataResetState } from './data-reset.js';

export { ResetViewBarrier, RESET_VIEW_PARAM } from './reset-views.js';

export { ChatTabLiveness, assertChatTabAvailable } from './tab-liveness.js';
