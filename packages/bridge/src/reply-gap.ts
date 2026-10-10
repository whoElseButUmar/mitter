import type {ChatView} from './chat-dom.js';
import {isHistoricalReply,isReplyFragment} from './reply-window.js';

export const REPLY_GAP_IDLE_MS=120000;
export interface ReplyGapObservation {missing:boolean;elapsedMs:number;started:boolean}

/** Per-exchange observation, not a payload cache. Missing DOM is never promoted
 * into a completed reply. Keep this separate from parse/correlation timers so
 * an old block cannot erase evidence that a newer response already started.
 * Only counts/times are retained; no model text, source or private DOM is saved. */
export class ReplyGapTracker {
  private exchange='';
  private started=false;
  private idleAt:number|undefined;
  observe(view:ChatView,exchange:string,priorIds:readonly string[],now:number):ReplyGapObservation {
    if(exchange!==this.exchange){this.exchange=exchange;this.started=false;this.idleAt=undefined;}
    const history=isHistoricalReply(view,priorIds);
    const current=!history&&(isReplyFragment(view)||!!view.replyEvidence||
      !!view.codeRead?.characters||!!view.codeReply||!!view.unlinkedReply||
      view.lastRole==='assistant'&&!!view.assistantText.trim());
    if(current)this.started=true;
    const missing=!current&&!view.busy&&view.ready!==false;
    if(!missing)this.idleAt=undefined;
    else this.idleAt??=now;
    return {missing,elapsedMs:missing?Math.max(0,now-this.idleAt!):0,started:this.started};
  }
}

/** Structural preconditions for a recovery QUESTION, never file execution.
 * Caller must additionally verify the full saved receipt, exact route, current
 * epoch and empty native queue, then re-inspect immediately before sending.
 * A hidden/ambiguous response, edited prompt or unknown tail fails closed. */
export function hasEmptyResponseTail(view:ChatView):boolean {
  const t=view.transcript;
  if(view.stopped||view.busy||view.draft||view.ready!==true||view.replyEvidence||
    view.lastRole!=='user'||!view.lastUserText||view.lastUserCollapsed||view.lastUserTruncated||
    !t?.users||t.scanLimited||t.unclassifiedTail||t.state!=='ready'||
    ['AMBIGUOUS_REPLIES','NEWER_TASK_REPLY','REPLY_IN_PROGRESS','NEWER_REPLY_UNREADABLE'].includes(view.codeReplyIssue||''))return false;
  if(t.strategy==='receipt')return t.receiptDiscovery?.matches===1&&
    ['matched','waiting_reply'].includes(t.receiptDiscovery.state)&&t.receiptDiscovery.tailBranches===0;
  return true;
}
