import { z } from 'zod';
import type { ChatView } from './chat-dom.js';
import { isHistoricalReply, isReplyFragment } from './reply-window.js';

export const REPLY_GAP_IDLE_MS = 120000;

export const replyGapObservationSchema = z
  .object({
    missing: z.boolean().describe('Whether the page has no visible reply to the current message.'),
    elapsedMs: z.number().nonnegative().describe('How long the reply has been missing, in milliseconds.'),
    started: z.boolean().describe('Whether any part of a reply has appeared for this message.'),
  })
  .describe('Whether a reply disappeared and how long it has been missing.');
export type ReplyGapObservation = z.infer<typeof replyGapObservationSchema>;

/** Per-exchange observation, not a payload cache. Missing DOM is never promoted
 * into a completed reply. Keep this separate from parse/correlation timers so
 * an old block cannot erase evidence that a newer response already started.
 * Only counts/times are retained; no model text, source or private DOM is saved. */
export class ReplyGapTracker {
  private exchangeId = '';
  private started = false;
  private idleAt: number | undefined;

  observe(
    view: ChatView,
    exchangeId: string,
    priorReplyIds: readonly string[],
    now: number,
  ): ReplyGapObservation {
    if (exchangeId !== this.exchangeId) {
      this.exchangeId = exchangeId;
      this.started = false;
      this.idleAt = undefined;
    }

    const isHistorical = isHistoricalReply(view, priorReplyIds);
    const hasCurrentReply =
      !isHistorical &&
      (isReplyFragment(view) ||
        !!view.replyEvidence ||
        !!view.codeRead?.characters ||
        !!view.codeReply ||
        !!view.unlinkedReply ||
        (view.lastRole === 'assistant' && !!view.assistantText.trim()));
    if (hasCurrentReply) {
      this.started = true;
    }

    const missing = !hasCurrentReply && !view.busy && view.ready !== false;
    let elapsedMs = 0;
    if (missing) {
      this.idleAt ??= now;
      elapsedMs = Math.max(0, now - this.idleAt);
    } else {
      this.idleAt = undefined;
    }

    return { missing, elapsedMs, started: this.started };
  }
}

/** Structural preconditions for a recovery QUESTION, never file execution.
 * Caller must additionally verify the full saved receipt, exact route, current
 * epoch and empty native queue, then re-inspect immediately before sending.
 * A hidden/ambiguous response, edited prompt or unknown tail fails closed. */
export function hasEmptyResponseTail(view: ChatView): boolean {
  const transcript = view.transcript;
  if (
    view.stopped ||
    view.busy ||
    view.draft ||
    view.ready !== true ||
    view.replyEvidence ||
    view.lastRole !== 'user' ||
    !view.lastUserText ||
    view.lastUserCollapsed ||
    view.lastUserTruncated ||
    !transcript?.users ||
    transcript.scanLimited ||
    transcript.unclassifiedTail ||
    transcript.state !== 'ready' ||
    ['AMBIGUOUS_REPLIES', 'NEWER_TASK_REPLY', 'REPLY_IN_PROGRESS', 'NEWER_REPLY_UNREADABLE'].includes(
      view.codeReplyIssue || '',
    )
  ) {
    return false;
  }

  if (transcript.strategy === 'receipt') {
    return (
      transcript.receiptDiscovery?.matches === 1 &&
      ['matched', 'waiting_reply'].includes(transcript.receiptDiscovery.state) &&
      transcript.receiptDiscovery.tailBranches === 0
    );
  }
  return true;
}
