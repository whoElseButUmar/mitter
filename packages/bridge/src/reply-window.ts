import type { ChatView } from './chat-dom.js';
import { readReplyJSON } from '../../protocol/src/reply-json.js';

/** Receive-side classification only. It never supplies an envelope, rewrites a
 * nonce, or permits execution. Keep pre-send history out of current-turn error
 * timers even when the provider hides its user/assistant role attributes. */
export function isHistoricalReply(view: ChatView, priorReplyIds: readonly string[]): boolean {
  if (
    !priorReplyIds.length ||
    view.replyEvidence ||
    view.codeRead?.incomplete ||
    ['REPLY_IN_PROGRESS', 'NEWER_REPLY_UNREADABLE'].includes(view.codeReplyIssue || '')
  ) {
    return false;
  }

  const priorReplies = new Set(priorReplyIds);

  // A newer ordinary transcript takes precedence over older parseable code.
  if (view.lastRole === 'assistant' && view.assistantText.trim()) {
    try {
      const assistantReply: unknown = readReplyJSON(view.assistantText);
      if (
        !assistantReply ||
        typeof assistantReply !== 'object' ||
        !('id' in assistantReply) ||
        typeof assistantReply.id !== 'string' ||
        !priorReplies.has(assistantReply.id)
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }

  if (view.codeRead && view.codeRead.issue !== 'candidate' && !view.codeRead.replyId) {
    return false;
  }

  const latestReplyId = view.codeRead?.replyId || view.unlinkedReply?.id || view.codeReply?.id;
  if (latestReplyId) {
    return priorReplies.has(latestReplyId);
  }

  return !!view.codeReplyIds?.length && view.codeReplyIds.every((replyId) => priorReplies.has(replyId));
}

/** A fragment starts at the newest JSON widget, not when its workerId finally
 * arrives. Its fingerprint is a change signal only, never an integrity hash. */
export function isReplyFragment(view: ChatView): boolean {
  return !view.replyEvidence && view.codeRead?.incomplete === true;
}
