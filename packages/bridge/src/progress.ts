import {parseReceipt, type OutboundReceipt} from './message-wire.js';

/** Durable task bookkeeping. No prompt/reply bodies, credentials, session token,
 * command approvals, or permission grants are stored in this record. Version is
 * deliberately independent of the application version. Old releases leave the
 * additive host KV entry alone; new releases must migrate rather than reset it. */
export interface TaskProgress {
  version:1; revision:number; workerId:string; projectId:string; goalHash:string;
  turns:number; maxTurns:number; lowerBound:boolean;
  activeMs:number; maxMinutes:number; startedAt:number; updatedAt:number;
  stage:'ready'|'prepared'|'commit_intent'|'waiting_reply'|'local_batch'|'report_due'|'review'|'complete';
  // A route observed immediately after Send is pinned separately from proof
  // of message ownership. Optional, additive v1 field for older checkpoints.
  conversationUrl?:string;
  lastReceipt?:OutboundReceipt;
  // Explicit user-approved recovery: exact validated envelope, not a task-wide bypass.
  approvedReply?:{id:string;hash:string;url:string;at:number};
  lastImportedId?:string; lastActionsHash?:string; repeats:number;
  formatRepairs:number;
  phase:string; reason:string; errorCode?:string;
}
const identifier=(x:unknown):x is string=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(x);
const hash=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const integer=(x:unknown,max=Number.MAX_SAFE_INTEGER):x is number=>Number.isSafeInteger(x)&&Number(x)>=0&&Number(x)<=max;
export function parseTaskProgress(raw:unknown):TaskProgress|undefined {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
  const v=raw as Record<string,unknown>;
  if(v.version!==1||!integer(v.revision)||!identifier(v.workerId)||!identifier(v.projectId)||!hash(v.goalHash))return;
  if(!integer(v.turns,100000)||!integer(v.maxTurns,100000)||Number(v.maxTurns)<1)return;
  if(!integer(v.activeMs)||!integer(v.maxMinutes,100000)||Number(v.maxMinutes)<1||!integer(v.startedAt)||!integer(v.updatedAt))return;
  if(!['ready','prepared','commit_intent','waiting_reply','local_batch','report_due','review','complete'].includes(String(v.stage))||typeof v.lowerBound!=='boolean'||!integer(v.repeats,100)||!integer(v.formatRepairs,100))return;
  const p:TaskProgress={version:1,revision:v.revision,workerId:v.workerId,projectId:v.projectId,goalHash:v.goalHash,
    turns:v.turns,maxTurns:v.maxTurns,lowerBound:v.lowerBound,activeMs:v.activeMs,maxMinutes:v.maxMinutes,
    startedAt:v.startedAt,updatedAt:v.updatedAt,stage:v.stage as TaskProgress['stage'],repeats:v.repeats,formatRepairs:v.formatRepairs,
    phase:typeof v.phase==='string'?v.phase.slice(0,40):'stopped',reason:typeof v.reason==='string'?v.reason.slice(0,500):'Progress saved.'};
  if(typeof v.errorCode==='string'&&/^[A-Z0-9_]{1,64}$/.test(v.errorCode))p.errorCode=v.errorCode;
  if(v.conversationUrl!==undefined){
    if(typeof v.conversationUrl!=='string'||v.conversationUrl.length>600)return;
    try{const u=new URL(v.conversationUrl);if(!['https://chatgpt.com','https://chat.openai.com'].includes(u.origin)||!/^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+$/.test(u.pathname)||u.search||u.hash)return;p.conversationUrl=u.origin+u.pathname;}catch{return;}
  }
  if(v.approvedReply!==undefined){
    const a=v.approvedReply as Record<string,unknown>;
    if(!a||!identifier(a.id)||!hash(a.hash)||!integer(a.at)||typeof a.url!=='string'||a.url.length>600)return;
    try{const u=new URL(a.url);if(!['https://chatgpt.com','https://chat.openai.com'].includes(u.origin)||!/^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+$/.test(u.pathname)||u.search||u.hash)return;}catch{return;}
    p.approvedReply={id:a.id,hash:a.hash,url:a.url,at:a.at};
  }
  if(v.lastReceipt!==undefined){const r=parseReceipt(v.lastReceipt);if(!r||r.workerId!==p.workerId||r.projectId!==p.projectId||r.goalHash!==p.goalHash)return;p.lastReceipt=r;}
  if(v.lastImportedId!==undefined){if(!identifier(v.lastImportedId))return;p.lastImportedId=v.lastImportedId;}
  if(v.lastActionsHash!==undefined){if(!hash(v.lastActionsHash))return;p.lastActionsHash=v.lastActionsHash;}
  return p;
}
export const progressKey=(workerId:string)=>'mitter.taskProgress.v1.'+workerId;
export function progressSummary(p:TaskProgress){
  return {workerId:p.workerId,turns:p.turns,maxTurns:p.maxTurns,lowerBound:p.lowerBound,
    activeMs:p.activeMs,maxMinutes:p.maxMinutes,startedAt:p.startedAt,phase:p.phase,reason:p.reason,errorCode:p.errorCode};
}
