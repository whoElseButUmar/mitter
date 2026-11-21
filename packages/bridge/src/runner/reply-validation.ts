import { parseProposalEnvelope, type ProposalEnvelope } from '../../../protocol/src/proposal.js';
import { isReadOnlyReply } from '../../../protocol/src/reply-json.js';
import type { ChatView } from '../chat-dom.js';
import { parseReceipt, type OutboundReceipt } from '../message-wire.js';
import { PageBridgeError } from '../page-transport.js';

const extractionReasons: Record<string, string> = {
  MULTIPLE_BLOCKS:
    'Mitter detected multiple separate code payloads in the latest reply (MULTIPLE_BLOCKS). It will not choose one or merge them.',
  EXTRA_CONTENT:
    'Mitter found text outside the JSON code payload (EXTRA_CONTENT). The reply must contain only one fenced JSON object.',
  MARKDOWN_TRANSFORMED:
    'The reply contains rendered Markdown rather than raw fenced code (MARKDOWN_TRANSFORMED). Source characters may have changed.',
  CODE_NOT_VISIBLE:
    'Mitter found code containers but no visible code payload (CODE_NOT_VISIBLE). Hidden content was not used.',
  EMPTY_CODE_BLOCK: 'Mitter found a code container without a complete payload (EMPTY_CODE_BLOCK).',
  PLAIN_STRING_LAYOUT:
    'A rendered line break splits a JSON string (PLAIN_STRING_LAYOUT). Return literal fenced JSON; Miter will not guess the missing source characters.',
  PLAIN_HIDDEN_CONTENT:
    'The plain reply contains hidden content (PLAIN_HIDDEN_CONTENT). Return one visible fenced JSON block.',
  PAYLOAD_TOO_LARGE: 'The reply exceeds the transport size limit. Return smaller fenced batches.',
};

export function replyFingerprint(view: ChatView): string {
  // Rendering can settle without changing text. Changed extraction status must
  // receive the same stability window as changed reply text.
  return [
    view.assistantId,
    view.assistantFormat || '',
    view.assistantReadIssue || '',
    view.assistantText,
  ].join('\n');
}

/** An ordinary transcript cannot override a contradictory explicit nonce.
 * Legacy fenced replies without replyTo retain their full-user-receipt path;
 * plain-text replies always require the current exchange nonce. */
export function checkReplyExchange(
  reply: ProposalEnvelope,
  lastReceipt?: OutboundReceipt,
  format?: ChatView['assistantFormat'],
): void {
  const receipt = parseReceipt(lastReceipt);
  if (!receipt?.expectsReplyTo || !receipt.exchangeId) {
    return;
  }
  if ((reply.replyTo !== undefined || format === 'plain') && reply.replyTo !== receipt.exchangeId) {
    let reason =
      'This plain reply is missing replyTo. Return the current exchange link in one fenced json block; no actions were imported.';
    if (reply.replyTo) {
      reason =
        'This reply names an older or different exchange. Use a new reply id and the latest CURRENT REPLY CONTRACT; no rejected actions ran.';
    }
    throw new PageBridgeError('REPLY_LINK_MISSING', reason);
  }
}

export function parseAssistantReply(view: ChatView, lastReceipt?: OutboundReceipt): ProposalEnvelope {
  if (view.assistantReadIssue) {
    const reason =
      extractionReasons[view.assistantReadIssue] ||
      'Mitter could not safely extract this reply. No actions were imported.';
    throw new PageBridgeError('REPLY_FORMAT', reason);
  }
  const reply = parseProposalEnvelope(view.assistantText);
  if (view.assistantFormat === 'plain' && !isReadOnlyReply(reply)) {
    throw new PageBridgeError(
      'REPLY_FORMAT',
      'An unfenced reply can be used only for read-only inspection (PLAIN_REPLY_REQUIRES_FENCE). Return edits, commands and completion inside one fenced json block so source bytes are preserved.',
    );
  }
  checkReplyExchange(reply, lastReceipt, view.assistantFormat);
  return reply;
}

/** Identify a rejected response for correction only. Never substitute an identifier or return its actions. */
export function mistypedProjectHeaders(view: ChatView, receipt: OutboundReceipt) {
  const transcript = view.transcript;
  const discovery = transcript?.receiptDiscovery;
  if (
    !receipt.expectsReplyTo ||
    !receipt.exchangeId ||
    view.lastRole !== 'assistant' ||
    !view.complete ||
    view.busy ||
    view.draft ||
    view.stopped ||
    view.ready !== true ||
    !view.lastUserText ||
    view.lastUserCollapsed ||
    view.lastUserTruncated ||
    view.assistantReadIssue ||
    view.assistantFormat !== 'code' ||
    view.replyEvidence ||
    view.codeReply ||
    view.unlinkedReply ||
    view.codeReplyCount !== 0 ||
    view.codeReplyIssue !== 'NEWER_REPLY_UNREADABLE' ||
    view.codeRead?.incomplete ||
    transcript?.state !== 'ready' ||
    transcript.scanLimited ||
    transcript.unclassifiedTail ||
    discovery?.state !== 'matched' ||
    discovery.matches !== 1 ||
    discovery.tailBranches !== 1
  ) {
    return;
  }
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  try {
    const reply = parseAssistantReply(view, receipt);
    if (
      reply.workerId === receipt.workerId &&
      reply.replyTo === receipt.exchangeId &&
      uuid.test(receipt.projectId) &&
      uuid.test(reply.projectId) &&
      [...reply.projectId].filter((char, index) => char !== receipt.projectId[index]).length === 1
    ) {
      return { id: reply.id, projectId: reply.projectId };
    }
  } catch {
    // Other malformed data follows its own recovery rules.
  }
  return undefined;
}

const waitExplanations: Record<string, string> = {
  INVALID_JSON:
    'The visible reply is not valid complete JSON. Ask for one fenced json block, not an escaped Markdown copy.',
  STALE_REPLY_TO:
    'The reply still names an older exchange. It cannot answer the current pending message; ask for a new id and the latest CURRENT REPLY CONTRACT.',
  MISSING_REPLY_TO: 'The reply is missing replyTo, so its pending exchange cannot be verified.',
  PLAIN_REPLY_REQUIRES_FENCE:
    'The unfenced reply includes actions beyond read-only inspection. Request the complete reply in a fenced json block.',
  MARKDOWN_TRANSFORMED:
    'Markdown formatting changed the visible reply. Request literal fenced JSON; Miter will not reconstruct source code.',
  PLAIN_STRING_LAYOUT: 'A rendered line break splits a JSON string. Request literal fenced JSON.',
  PLAIN_HIDDEN_CONTENT: 'The plain reply contains hidden content. Request one visible fenced json block.',
};

export function replyWaitExplanation(view: ChatView, fragment: boolean): string {
  if (fragment) {
    return 'The new reply stopped arriving before its JSON was complete.';
  }
  const replyIssueReason = waitExplanations[view.codeReplyIssue || ''];
  if (replyIssueReason) {
    return replyIssueReason;
  }
  const readerIssueReason = waitExplanations[view.codeRead?.issue || ''];
  if (readerIssueReason) {
    return readerIssueReason;
  }
  return 'Its full JSON or task link could not be verified.';
}
