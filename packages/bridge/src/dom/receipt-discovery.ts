import { readReplyJSON } from '../../../protocol/src/reply-json.js';
import { matchesReceipt, parseReceipt, type OutboundReceipt } from '../message-wire.js';
import { identifierSchema } from '../schemas/primitives.js';
import { readAssistantMessage } from './assistant-reader.js';
import { contentHidden, htmlElements, pageElements, parentAcrossShadow } from './page-elements.js';
import {
  discoverMessages,
  explicitRole,
  messageRole,
  roleSelector,
  setReceiptRole,
  transcriptExcluded,
} from './transcript-discovery.js';
import { messageDisclosure, readUserMessageVariants } from './user-reader.js';
import {
  taskReplyObservationSchema,
  type AssistantReadResult,
  type CodeAncestor,
  type MessageDiscovery,
  type ReceiptDiscoveryStats,
  type TranscriptStats,
} from './types.js';

function structuralAncestry(elements: HTMLElement[]): TranscriptStats['codeAncestry'] {
  return elements
    .filter((element) => element.matches('pre,code') && !contentHidden(element))
    .slice(0, 2)
    .map((element) => {
      const ancestry: CodeAncestor[] = [];
      for (let node: Element | null = element; node && ancestry.length < 7; node = parentAcrossShadow(node)) {
        let tag = 'custom-element';
        if (/^[A-Z][A-Z0-9]*$/.test(node.tagName)) {
          tag = node.tagName.toLowerCase();
        }
        ancestry.push({
          tag,
          attributes: node
            .getAttributeNames()
            .filter((attributeName) =>
              [
                'id',
                'class',
                'role',
                'aria-label',
                'aria-labelledby',
                'aria-hidden',
                'hidden',
                'data-testid',
                'data-message-author-role',
                'data-message-id',
                'data-message-role',
                'data-message-key',
                'data-message-content',
                'data-turn',
                'data-turn-id',
                'data-turn-role',
                'data-author',
                'data-author-role',
                'data-role',
              ].includes(attributeName),
            )
            .slice(0, 12),
        });
        if (node.matches('body,html')) {
          break;
        }
      }
      return ancestry;
    });
}

/** A branch has content if it contains non-UI text or a real rendered media
 * object. Empty layout spacers and toolbars are not additional messages. */
function substantiveBranch(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return !!node.nodeValue?.trim();
  }
  if (!(node instanceof HTMLElement) || contentHidden(node)) {
    return false;
  }
  if (
    node.matches(
      'form,nav,aside,button,[role="button"],summary,svg,script,style,template,textarea,[contenteditable="true"],#mitter-automation-control,[data-mitter-ui]',
    )
  ) {
    return false;
  }
  if (node.matches('pre,code,img,video,audio,canvas,iframe')) {
    return true;
  }
  return Array.from(node.childNodes).some(substantiveBranch);
}

function responseControls(root: HTMLElement): {
  positive: number;
  negative: number;
  other: number;
  userEdit: boolean;
} {
  const result = { positive: 0, negative: 0, other: 0, userEdit: false };
  for (const control of htmlElements(root, 'button,[role="button"]')) {
    if (contentHidden(control) || control.closest('pre,code,[contenteditable="true"],blockquote')) {
      continue;
    }
    const label = (
      control.getAttribute('aria-label') ||
      control.getAttribute('title') ||
      control.textContent ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const testId = (control.getAttribute('data-testid') || '').toLowerCase();
    if (
      /^(?:good response|like response|thumbs up|bonne réponse|buena respuesta)$/.test(label) ||
      /^(?:good-response|thumb-up)-turn-action-button$/.test(testId)
    ) {
      result.positive++;
    }
    if (
      /^(?:bad response|dislike response|thumbs down|mauvaise réponse|mala respuesta)$/.test(label) ||
      /^(?:bad-response|thumb-down)-turn-action-button$/.test(testId)
    ) {
      result.negative++;
    }
    if (
      /^(?:read aloud|regenerate response|regenerate|retry response|lire à voix haute)$/.test(label) ||
      /^(?:read-aloud|regenerate)-turn-action-button$/.test(testId)
    ) {
      result.other++;
    }
    if (
      /^(?:edit|edit message|edit prompt|modifier le message)$/.test(label) ||
      testId === 'edit-message-button'
    ) {
      result.userEdit = true;
    }
  }
  return result;
}

/** Read exactly one code payload. The only extra text accepted on the outer
 * response row is a known duration label such as "Worked for 59s" and the
 * language label. Arbitrary prose/other payloads are NOT removed. */
function readAnchoredAssistant(root: HTMLElement): AssistantReadResult {
  const assistantRead = readAssistantMessage(root);
  if (
    assistantRead.issue !== 'EXTRA_CONTENT' ||
    !assistantRead.source ||
    assistantRead.stats?.logicalBlocks !== 1
  ) {
    return assistantRead;
  }
  const residualTexts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (
      !parent ||
      assistantRead.source.contains(node) ||
      contentHidden(parent) ||
      parent.closest('button,[role="button"],summary,svg,script,style,template,[aria-hidden="true"]')
    ) {
      continue;
    }
    if (node.nodeValue?.trim()) {
      residualTexts.push(node.nodeValue.trim());
    }
  }
  const residualText = residualTexts.join(' ').replace(/\s+/g, ' ').trim();
  if (
    !/^(?:(?:Worked|Thought|Reasoned) for \d+(?:\s*(?:h|m|s|hours?|minutes?|seconds?)\b)(?:\s*\d+\s*(?:h|m|s|hours?|minutes?|seconds?)\b)*\s*)?(?:JSON|application\/json)$/i.test(
      residualText,
    )
  ) {
    return assistantRead;
  }
  return {
    text: assistantRead.source.textContent || '',
    format: 'code',
    stats: assistantRead.stats,
    source: assistantRead.source,
  };
}

function receiptRoleConflict(element: HTMLElement): boolean {
  for (
    let ancestor: Element | null = element;
    ancestor && !ancestor.matches('main,body,html,[role="main"]');
    ancestor = parentAcrossShadow(ancestor)
  ) {
    if (ancestor instanceof HTMLElement && ['assistant', 'unknown'].includes(explicitRole(ancestor))) {
      return true;
    }
  }
  return false;
}

export async function discoverReceiptMessages(
  receipt: OutboundReceipt,
  base: MessageDiscovery = discoverMessages(),
): Promise<MessageDiscovery> {
  // Parse even when called outside chatDom by tests or future callers.
  const validReceipt = parseReceipt(receipt);
  if (!validReceipt) {
    return base;
  }
  const pageScan = pageElements();
  const receiptStats: ReceiptDiscoveryStats = {
    state: 'searching',
    candidates: 0,
    matches: 0,
    tailBranches: 0,
    responseControls: 0,
  };
  const transcriptStats: TranscriptStats = {
    ...base.stats,
    version: 'message-discovery/2',
    strategy: 'receipt',
    receiptDiscovery: receiptStats,
    codeAncestry: structuralAncestry(pageScan.elements),
  };
  const unchangedDiscovery = (): MessageDiscovery => ({
    ...base,
    stats: transcriptStats,
  });
  if (pageScan.limited) {
    transcriptStats.state = 'partial';
    transcriptStats.scanLimited = true;
    receiptStats.state = 'limit';
    return unchangedDiscovery();
  }
  // Only DOM ancestors containing the known send marker can be candidate
  // message bubbles. Legacy receipts may instead require the bootstrap prefix;
  // they still need an exact full-body hash match, never prefix acceptance.
  const receiptMarker = validReceipt.exchangeId || 'You are collaborating with Mitter,';
  const receiptCandidates = (elements: HTMLElement[]): HTMLElement[] =>
    elements.filter((element) => {
      if (
        element.matches('html,body,main,[role="main"]') ||
        transcriptExcluded(element) ||
        (element.textContent || '').length > 180000 ||
        !(element.textContent || '').includes(receiptMarker)
      ) {
        return false;
      }
      // Transcript-spanning ancestors change as the assistant reasons. They
      // are not user bubbles and must not invalidate an unchanged send receipt.
      let containedTurns = 0;
      for (const message of base.messages) {
        if (element.contains(message)) {
          containedTurns++;
          if (containedTurns > 1) {
            return false;
          }
        }
      }
      return true;
    });
  const candidateMessages = receiptCandidates(pageScan.elements);
  receiptStats.candidates = candidateMessages.length;
  if (candidateMessages.length > 96) {
    receiptStats.state = 'limit';
    transcriptStats.scanLimited = true;
    transcriptStats.state = 'partial';
    return unchangedDiscovery();
  }
  if (!candidateMessages.length) {
    receiptStats.state = 'missing';
    return unchangedDiscovery();
  }
  const candidateReads = candidateMessages.map((node) => {
    let read: ReturnType<typeof readUserMessageVariants> | undefined;
    if (!receiptRoleConflict(node)) {
      read = readUserMessageVariants(node);
    }
    return { node, read };
  });
  const matchingMessages: Array<{
    node: HTMLElement;
    read: ReturnType<typeof readUserMessageVariants>;
  }> = [];
  for (const candidate of candidateReads) {
    const message = candidate.node;
    const userRead = candidate.read;
    // Role metadata, when present, cannot be contradicted by a receipt match.
    if (!userRead) {
      continue;
    }
    const exactMatches = await Promise.all(
      userRead.texts.map((text) => {
        if (text.length <= 160000) {
          return matchesReceipt(text, validReceipt);
        }
        return false;
      }),
    );
    const index = exactMatches.indexOf(true);
    const verifiedText = userRead.texts[index];
    if (index >= 0 && verifiedText !== undefined && message.isConnected) {
      // DOM can change while WebCrypto yields. Never pair an old verified
      // user-body snapshot with a newly inserted response.
      const freshRead = readUserMessageVariants(message);
      if (freshRead.texts.includes(verifiedText)) {
        matchingMessages.push({
          node: message,
          read: {
            ...freshRead,
            texts: [verifiedText, ...freshRead.texts.filter((text) => text !== verifiedText)],
          },
        });
      }
    }
  }
  // Nested matches are the same bubble, disjoint visible matches are not. Never
  // acknowledge two identical sends by deduplicating their bodies.
  const leafMatches = matchingMessages.filter(
    (match) =>
      !matchingMessages.some((otherMatch) => otherMatch !== match && match.node.contains(otherMatch.node)),
  );
  receiptStats.matches = leafMatches.length;
  // Hashing yields to the page. Retaining the matched body alone is not enough:
  // another bubble may have become a duplicate, or a later user may now exist.
  const currentScan = pageElements();
  base = discoverMessages();
  Object.assign(transcriptStats, base.stats, {
    version: 'message-discovery/2',
    strategy: 'receipt',
  });
  const currentCandidates = receiptCandidates(currentScan.elements);
  if (currentScan.limited || base.stats.scanLimited || currentCandidates.length > 96) {
    transcriptStats.state = 'partial';
    transcriptStats.scanLimited = true;
    receiptStats.state = 'limit';
    return unchangedDiscovery();
  }
  const candidatesUnchanged =
    currentCandidates.length === candidateReads.length &&
    currentCandidates.every((node, index) => {
      const candidate = candidateReads[index];
      if (!candidate || candidate.node !== node) {
        return false;
      }
      const conflict = receiptRoleConflict(node);
      if (!candidate.read) {
        return conflict;
      }
      if (conflict) {
        return false;
      }
      const currentRead = readUserMessageVariants(node);
      return (
        candidate.read.texts.length === currentRead.texts.length &&
        candidate.read.texts.every((text, textIndex) => text === currentRead.texts[textIndex])
      );
    });
  if (!candidatesUnchanged) {
    receiptStats.state = 'unknown_tail';
    receiptStats.matches = 0;
    transcriptStats.state = 'partial';
    transcriptStats.unclassifiedTail = true;
    return unchangedDiscovery();
  }
  const withUserMessage = (
    message: HTMLElement,
    userRead: ReturnType<typeof readUserMessageVariants>,
  ): MessageDiscovery => {
    if (base.stats.users) {
      // Keep recognized history and real message IDs. The fallback must not
      // replace the latest known user or hide any later turn.
      return { messages: [...base.messages], stats: transcriptStats, userRead };
    }
    setReceiptRole(
      message,
      'user',
      'receipt-' + (validReceipt.messageId || validReceipt.exchangeId || validReceipt.textHash),
    );
    transcriptStats.state = 'ready';
    transcriptStats.users = 1;
    transcriptStats.assistants = 0;
    transcriptStats.unknownTurns = 0;
    transcriptStats.unclassifiedTail = false;
    return { messages: [message], stats: transcriptStats, userRead };
  };
  if (leafMatches.length > 1) {
    receiptStats.state = 'ambiguous';
    transcriptStats.state = 'unrecognized';
    return unchangedDiscovery();
  }
  if (!leafMatches.length) {
    if (base.stats.users) {
      receiptStats.state = 'mismatch';
      return unchangedDiscovery();
    }
    // A matching marker permits ONLY opening Show more, not acknowledging or
    // importing. The next read must recover and verify the COMPLETE body.
    const collapsedCandidates = candidateMessages.filter(
      (message) =>
        !!validReceipt.exchangeId &&
        !receiptRoleConflict(message) &&
        (message.textContent || '').includes('MITTER EXCHANGE ' + validReceipt.exchangeId) &&
        messageDisclosure(message, true).collapsed,
    );
    const smallestCandidates = collapsedCandidates.filter(
      (message) => !collapsedCandidates.some((other) => other !== message && message.contains(other)),
    );
    const collapsedMessage = smallestCandidates[0];
    if (smallestCandidates.length === 1 && collapsedMessage) {
      receiptStats.state = 'collapsed';
      return withUserMessage(collapsedMessage, readUserMessageVariants(collapsedMessage));
    }
    receiptStats.state = 'mismatch';
    if (smallestCandidates.length > 1) {
      receiptStats.state = 'ambiguous';
    }
    return unchangedDiscovery();
  }
  let matchedMessage = leafMatches[0];
  if (!matchedMessage) {
    return unchangedDiscovery();
  }
  if (base.stats.users) {
    const latestUser = base.messages.filter((message) => messageRole(message) === 'user').at(-1);
    const knownMatch = matchingMessages.find((match) => match.node === latestUser);
    if (!knownMatch) {
      receiptStats.state = 'unknown_tail';
      transcriptStats.state = 'partial';
      return unchangedDiscovery();
    }
    matchedMessage = knownMatch;
  }
  const verifiedText = matchedMessage.read.texts[0];
  const freshRead = readUserMessageVariants(matchedMessage.node);
  if (
    !matchedMessage.node.isConnected ||
    verifiedText === undefined ||
    !freshRead.texts.includes(verifiedText)
  ) {
    receiptStats.state = 'mismatch';
    transcriptStats.state = 'partial';
    return unchangedDiscovery();
  }
  matchedMessage.read = {
    ...freshRead,
    texts: [verifiedText, ...freshRead.texts.filter((text) => text !== verifiedText)],
  };
  const discovery = withUserMessage(matchedMessage.node, matchedMessage.read);
  receiptStats.state = 'matched';
  // Find the FIRST branch following the verified bubble. Do not climb over
  // intervening content to cherry-pick a convenient JSON block further down.
  for (let branch: HTMLElement = matchedMessage.node, depth = 0; depth < 20; depth++) {
    const parent = branch.parentElement;
    if (!parent || parent.matches('body,html,form,nav,aside,[role="dialog"]')) {
      break;
    }
    const siblings = Array.from(parent.childNodes);
    const index = siblings.indexOf(branch);
    const followingBranches = siblings.slice(index + 1).filter(substantiveBranch);
    if (followingBranches.length) {
      receiptStats.tailBranches = followingBranches.length;
      const responseBranch = followingBranches[0];
      if (followingBranches.length !== 1 || !(responseBranch instanceof HTMLElement)) {
        receiptStats.state = 'unknown_tail';
        transcriptStats.unclassifiedTail = true;
        transcriptStats.state = 'partial';
        return discovery;
      }
      if (base.stats.users) {
        const userIndex = base.messages.indexOf(matchedMessage.node);
        const knownTail = base.messages.slice(userIndex + 1);
        if (knownTail.length > 1 || knownTail.some((message) => !responseBranch.contains(message))) {
          receiptStats.state = 'unknown_tail';
          transcriptStats.unclassifiedTail = true;
          transcriptStats.state = 'partial';
          return unchangedDiscovery();
        }
      }
      const controls = responseControls(responseBranch);
      receiptStats.responseControls = controls.positive + controls.negative + controls.other;
      const responseRole = explicitRole(responseBranch);
      const descendantRoles = htmlElements(responseBranch, roleSelector).map(explicitRole);
      const responseOnly =
        ((controls.positive === 1 && controls.negative === 1) || controls.other === 1) && !controls.userEdit;
      const hasAssistantRole = responseRole === 'assistant' || descendantRoles.includes('assistant');
      if (
        responseRole === 'user' ||
        responseRole === 'unknown' ||
        descendantRoles.includes('user') ||
        descendantRoles.includes('unknown') ||
        controls.userEdit ||
        controls.positive > 1 ||
        controls.negative > 1 ||
        controls.other > 2
      ) {
        receiptStats.state = 'unknown_tail';
        transcriptStats.unclassifiedTail = true;
        transcriptStats.state = 'partial';
        return discovery;
      }
      if (!hasAssistantRole && !responseOnly) {
        // An incomplete response row often gets its action toolbar only after
        // streaming. Never infer completion from valid JSON alone.
        receiptStats.state = 'waiting_reply';
        transcriptStats.unclassifiedTail = true;
        transcriptStats.state = 'partial';
        return discovery;
      }
      const assistantRead = readAnchoredAssistant(responseBranch);
      let identity =
        'receipt-reply-' + (validReceipt.messageId || validReceipt.exchangeId || validReceipt.textHash);
      // The envelope ID is not authority. A stable ID merely prevents a
      // highlighter re-render from being mistaken for another reply.
      try {
        const envelope = readReplyJSON(assistantRead.text);
        if (
          typeof envelope === 'object' &&
          envelope !== null &&
          'id' in envelope &&
          typeof envelope.id === 'string' &&
          identifierSchema.safeParse(envelope.id).success
        ) {
          identity = 'reply-' + envelope.id;
        }
      } catch {}
      setReceiptRole(responseBranch, 'assistant', identity);
      discovery.messages = discovery.messages.filter((message) => !responseBranch.contains(message));
      discovery.messages.push(responseBranch);
      discovery.assistantRead = assistantRead;
      transcriptStats.state = 'ready';
      transcriptStats.assistants = discovery.messages.filter(
        (message) => messageRole(message) === 'assistant',
      ).length;
      transcriptStats.unknownTurns = discovery.messages.filter(
        (message) => messageRole(message) === 'unknown',
      ).length;
      transcriptStats.unclassifiedTail = false;
      return discovery;
    }
    if (parent.matches('main,[role="main"]')) {
      break;
    }
    // A matching substring nested inside an edited/quoted message is not the
    // full user turn. Only climb through wrappers that also match the receipt.
    if (!matchingMessages.some((match) => match.node === parent)) {
      if (base.stats.users && discovery.messages.at(-1) === matchedMessage.node) {
        receiptStats.state = 'waiting_reply';
        return discovery;
      }
      // A verified new user bubble can be the last child of the transcript,
      // following a previously recorded assistant reply. The parent then
      // necessarily contains older text and cannot itself match the new send.
      // Recognize ONLY that exact preceding known reply; arbitrary introductory
      // prose / quoted copies still fail below. This grants no execution proof.
      const previous = siblings.slice(0, index).filter(substantiveBranch).at(-1);
      if (previous instanceof HTMLElement && validReceipt.priorReplyIds?.length) {
        const assistantRead = readAnchoredAssistant(previous);
        let previousReply: unknown;
        try {
          if (!assistantRead.issue && assistantRead.format === 'code') {
            previousReply = readReplyJSON(assistantRead.text);
          }
        } catch {}
        const previousReplyResult = taskReplyObservationSchema.safeParse(previousReply);
        if (
          previousReplyResult.success &&
          previousReplyResult.data.workerId === validReceipt.workerId &&
          previousReplyResult.data.projectId === validReceipt.projectId &&
          typeof previousReplyResult.data.id === 'string' &&
          validReceipt.priorReplyIds.includes(previousReplyResult.data.id)
        ) {
          receiptStats.state = 'waiting_reply';
          return discovery;
        }
      }
      receiptStats.state = 'unknown_tail';
      transcriptStats.unclassifiedTail = true;
      transcriptStats.state = 'partial';
      return discovery;
    }
    branch = parent;
  }
  receiptStats.state = 'waiting_reply';
  return discovery;
}
