import { readReplyJSON } from '../../protocol/src/reply-json.js';
import {parseProposalEnvelope as parseEnvelope,type ProposalEnvelope as Envelope} from '../../protocol/src/proposal.js';

/** Hash the validated payload without normalizing characters in source strings.
 * Property ordering outside file contents is immaterial; every content byte is.
 */
export async function replyDigest(envelope:Envelope):Promise<string> {
  const bytes=new TextEncoder().encode(JSON.stringify(envelope));
  const value=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(value),n=>n.toString(16).padStart(2,'0')).join('');
}
export function boundReply(raw:string,workerId:string,projectId:string):Envelope {
  const reply=parseEnvelope(raw);
  if(reply.workerId!==workerId||reply.projectId!==projectId)throw new Error('This reply belongs to a different task or project. Nothing was imported.');
  return reply;
}
/** Correlation headers only. Invalid action schemas remain visible so the
 * runner can request a correction; no execution uses this relaxed reader. */
export function replyHeaders(raw:string,workerId:string,projectId:string):{id:string;workerId:string;projectId:string;replyTo?:string}{
  const v=readReplyJSON(raw) as Record<string,unknown>|null;const valid=(x:unknown)=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(x);
  if(!v||v.protocol!=='mitter/1'||v.workerId!==workerId||v.projectId!==projectId||!valid(v.id)||v.replyTo!==undefined&&!valid(v.replyTo))throw new Error('Reply headers do not match this task.');
  return {id:v.id as string,workerId,projectId,...(v.replyTo===undefined?{}:{replyTo:v.replyTo as string})};
}
export interface ReplyPreview {
  ticket:string;workerId:string;taskName:string;summary:string;source:'chat'|'clipboard';
  actions:string[];expiresAt:number;
}
export function actionSummary(e:Envelope):string[] {
  return e.actions.map(a=>{
    switch(a.type){
      case 'write':return 'Write '+a.path+' ('+new TextEncoder().encode(a.content).length+' bytes)';
      case 'replace':return 'Edit '+a.path;
      case 'read':return 'Read '+a.path;
      case 'list':return 'List '+a.path;
      case 'search':return 'Search project';
      case 'command':return 'Request command: '+a.profileId+' (approval rules apply)';
      case 'finish':return 'Request goal verification';
      case 'ask':return 'Ask for your decision';
      case 'team_message':return 'Send team context';
      case 'team_pause':return 'Request a cooperative task pause';
      case 'team_resume':return 'Release a cooperative pause';
      case 'diff':return 'Read file differences';
    }
  });
}

/** A layout/transport dead end should offer a different action, not another
 * identical Resume attempt. Other pauses (drafts, approvals, limits) retain
 * their own next action. The Tools fallback is always explicitly selectable. */
export function preferReplyRecovery(errorCode?:string):boolean {
  return ['TRANSCRIPT_UNSUPPORTED','TRANSCRIPT_LIMIT','USER_ECHO_UNREADABLE',
    'REPLY_DISAPPEARED','REPLY_RECOVERY_EXHAUSTED','REPLY_LINK_MISSING','REPLY_FORMAT','REPLY_SCHEMA','REPLY_NOT_ADVANCING','REPLY_UNREADABLE','MESSAGE_COLLAPSED',
    'FIRST_SEND_UNCONFIRMED','USER_TURN_UNCONFIRMED','SAVED_SEND_MISMATCH'].includes(errorCode||'');
}
