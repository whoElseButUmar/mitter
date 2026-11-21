import {
  exceedsHandoffBytes,
  hasCompleteReplyFence,
  isIncompleteReplyJSON,
  readReplyJSON,
} from '../../../protocol/src/reply-json.js';
import { matchesReceipt, parseReceipt, type OutboundReceipt } from '../message-wire.js';
import { identifierSchema } from '../schemas/primitives.js';
import { hasStreamRetry, hasOnlyHiddenSearchIcons, isAnalyzedActivity } from './provider-activity.js';
import { readAssistantMessage } from './assistant-reader.js';
import { contentHidden, htmlElements, pageElements, parentAcrossShadow } from './page-elements.js';
import {
  discoverMessages,
  explicitRole,
  headingRole,
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
  type ReplyRecovery,
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

/** Native role ownership can include a heading and sibling message toolbar.
 * Permit only that presentation outside the identified message; arbitrary
 * prose, media, another turn or an editor still prevents crossing the wrapper. */
function nativeMessageWrapper(parent: HTMLElement, message: HTMLElement, base: MessageDiscovery): boolean {
  const role = messageRole(message);
  if (
    !base.messages.includes(message) ||
    (role !== 'user' && role !== 'assistant') ||
    !parent.contains(message) ||
    base.messages.some((other) => other !== message && parent.contains(other))
  ) {
    return false;
  }
  const ownedContent = (node: Node): boolean => {
    if (node === message) {
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return !node.nodeValue?.trim();
    }
    if (!(node instanceof HTMLElement) || contentHidden(node)) {
      return true;
    }
    if (node.matches('button,[role="button"],summary,svg,script,style,template')) {
      return true;
    }
    if (
      node.matches('h1,h2,h3,h4,h5,h6,[role="heading"]') &&
      (node.getAttribute('data-conversation-role') === role ||
        (node.matches('h4.sr-only:not([data-conversation-role])') &&
          node === node.parentElement?.firstElementChild &&
          node.nextElementSibling?.tagName === 'DIV' &&
          node.nextElementSibling.contains(message) &&
          !node.closest(
            'blockquote,.markdown,[data-message-content],[data-markdown-text-style],[data-user-message-bubble]',
          ))) &&
      (headingRole(node) === role ||
        (role === 'user' && /^You said:\s*You$/i.test((node.textContent || '').trim())) ||
        (role === 'assistant' && /^ChatGPT said:\s*ChatGPT$/i.test((node.textContent || '').trim())))
    ) {
      return true;
    }
    if (
      node.matches('form,nav,aside,textarea,[contenteditable="true"],pre,code,img,video,audio,canvas,iframe')
    ) {
      return false;
    }
    return Array.from(node.childNodes).every(ownedContent);
  };
  return ownedContent(parent);
}

/** A collapsed activity disclosure between the verified user's message and the
 * keyed final response occupies a separate sibling in the windowed transcript. */
function collapsedActivity(user: HTMLElement, activity: Node, response: Node): boolean {
  if (!(activity instanceof HTMLDivElement) || !(response instanceof HTMLDivElement)) {
    return false;
  }
  const userKey = user
    .querySelector('[data-content-search-unit-key]')
    ?.getAttribute('data-content-search-unit-key');
  if (!userKey?.endsWith(':0:user')) {
    return false;
  }
  const finalKey = userKey.slice(0, -':0:user'.length) + ':2:assistant';
  const finalWrapper = [response, ...htmlElements(response, '[data-chatgpt-search-unit-key]')].find(
    (node) => node.getAttribute('data-chatgpt-search-unit-key') === finalKey,
  );
  if (
    finalWrapper?.getAttribute('data-content-search-unit-key') !== finalKey ||
    !finalWrapper.querySelector('[data-markdown-text-style="assistant-message"]') ||
    !finalWrapper.querySelector('[data-dil-message-id]') ||
    activity.querySelector(
      'form,video,audio,canvas,iframe,textarea,[contenteditable="true"],h1,h2,h3,h4,h5,h6,[role="heading"],[data-message-author-role],[data-message-id],[data-turn-id],[data-content-search-unit-key],[data-chatgpt-search-unit-key],[data-user-message-bubble],[data-dil-message-id]',
    )
  ) {
    return false;
  }
  const controls = htmlElements(activity, 'button,[role="button"]');
  const toggle = controls[0];
  const duration = toggle?.parentElement;
  if (
    !toggle ||
    !duration ||
    toggle.getAttribute('aria-expanded') !== 'false' ||
    !/^Worked for \d+(?:h|m|s)(?: \d+(?:h|m|s)){0,2}$/.test(duration.innerText.trim())
  ) {
    return false;
  }
  const standaloneToggle =
    toggle.matches('button[type="button"][data-turn-disclosure-button]') &&
    duration.children.length === 1 &&
    duration.innerText.trim() === toggle.innerText.trim();
  if (!duration.classList.contains('group/activity-header') && !standaloneToggle) {
    return false;
  }
  if (!hasOnlyHiddenSearchIcons(activity, toggle)) {
    return false;
  }
  if (controls.length === 1) {
    return !activity.querySelector('pre,code,a') && activity.innerText.trim() === duration.innerText.trim();
  }

  return isAnalyzedActivity(activity, duration, controls);
}

function recoveryObservation(
  kind: ReplyRecovery['kind'],
  receipt: OutboundReceipt,
  userText: string,
  response: HTMLElement,
): ReplyRecovery | undefined {
  if (
    !receipt.exchangeId ||
    contentHidden(response) ||
    response.matches('form,textarea,[contenteditable="true"],blockquote,nav,aside') ||
    response.querySelector('form,textarea,[contenteditable="true"],blockquote,nav,aside')
  ) {
    return;
  }
  const read = readAnchoredAssistant(response);
  const controls = responseControls(response);
  const responseOnly =
    ((controls.positive === 1 && controls.negative === 1) || controls.other === 1) && !controls.userEdit;
  const identifiedAssistant =
    explicitRole(response) === 'assistant' ||
    htmlElements(response, roleSelector).some((element) => explicitRole(element) === 'assistant');
  const diagnosticCarrier = kind === 'duplicate_send' && (identifiedAssistant || responseOnly);
  if (
    diagnosticCarrier &&
    htmlElements(response, '*').some((element) => contentHidden(element) && !!element.textContent?.trim())
  ) {
    return;
  }
  // An identified assistant may expose conflicting blocks as diagnostics only.
  // Without that role evidence, require one whole JSON/fence carrier.
  if (
    !read.text.trim() ||
    exceedsHandoffBytes(read.text) ||
    ['CODE_NOT_VISIBLE', 'PLAIN_HIDDEN_CONTENT'].includes(read.issue || '') ||
    (!diagnosticCarrier &&
      (['EXTRA_CONTENT', 'MULTIPLE_BLOCKS'].includes(read.issue || '') ||
        !/^\s*(?:\{|(?:\\?`){3}(?:json)?[ \t\\]*\r?\n)/.test(read.text)))
  ) {
    return;
  }
  let wholeCarrier =
    diagnosticCarrier ||
    read.format === 'code' ||
    hasCompleteReplyFence(read.text) ||
    isIncompleteReplyJSON(read.text);
  if (!wholeCarrier && !read.issue) {
    try {
      const parsed = readReplyJSON(read.text);
      wholeCarrier = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {}
  }
  if (!wholeCarrier) {
    return;
  }
  return {
    kind,
    exchangeId: receipt.exchangeId,
    userText,
    responseText: read.text,
    format: read.format,
    issue: read.issue,
  };
}

/** Locate one response after the latest duplicate receipt, without assigning
 * either a user role or an assistant role. Only correction may use this text. */
function duplicateRecoveryResponse(
  latest: HTMLElement,
  matchingNodes: HTMLElement[],
  base: MessageDiscovery,
): HTMLElement | undefined {
  const latestKnownUser = base.messages.filter((message) => messageRole(message) === 'user').at(-1);
  if (latestKnownUser && !latestKnownUser.contains(latest) && !latest.contains(latestKnownUser)) {
    return;
  }
  for (let branch = latest, depth = 0; depth < 20; depth++) {
    const parent = branch.parentElement;
    if (!parent || parent.matches('body,html,form,nav,aside,[role="dialog"]')) {
      return;
    }
    const siblings = Array.from(parent.childNodes);
    const following = siblings.slice(siblings.indexOf(branch) + 1).filter(substantiveBranch);
    if (following.length) {
      const response = following[0];
      if (following.length !== 1 || !(response instanceof HTMLElement)) {
        return;
      }
      const roles = [explicitRole(response), ...htmlElements(response, roleSelector).map(explicitRole)];
      const controls = responseControls(response);
      if (
        roles.includes('user') ||
        roles.includes('unknown') ||
        controls.userEdit ||
        controls.positive > 1 ||
        controls.negative > 1 ||
        controls.other > 2
      ) {
        return;
      }
      if (latestKnownUser) {
        const knownTail = base.messages.slice(base.messages.indexOf(latestKnownUser) + 1);
        if (knownTail.length > 1 || knownTail.some((message) => !response.contains(message))) {
          return;
        }
      }
      return response;
    }
    if (parent.matches('main,[role="main"]') || !matchingNodes.includes(parent)) {
      return;
    }
    branch = parent;
  }
  return;
}

export async function discoverReceiptMessages(
  receipt: OutboundReceipt,
  base: MessageDiscovery = discoverMessages(),
  checkCurrent: () => void = () => {},
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
      // A composer wrapper can contain the exact resend bytes. Neither the
      // editor nor any ancestor containing it is a sent-message candidate.
      if (
        element.matches('html,body,main,[role="main"]') ||
        transcriptExcluded(element) ||
        (element.textContent || '').length > 180000 ||
        !(element.textContent || '').includes(receiptMarker) ||
        element.querySelector('form,textarea,[contenteditable="true"]')
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
  // Nested wrappers often serialize the same full message. Hash each unique
  // serialization once, in one bounded batch, but keep every DOM candidate:
  // disjoint identical sends must still be diagnosed as ambiguous.
  const matchesByText = new Map<string, Promise<boolean>>();
  const candidateMatches = await Promise.all(
    candidateReads.map((candidate) =>
      Promise.all(
        (candidate.read?.texts ?? []).map((text) => {
          if (text.length > 160000) {
            return false;
          }
          let matching = matchesByText.get(text);
          if (!matching) {
            matching = matchesReceipt(text, validReceipt);
            matchesByText.set(text, matching);
          }
          return matching;
        }),
      ),
    ),
  );
  checkCurrent();
  for (const [candidateIndex, candidate] of candidateReads.entries()) {
    const userRead = candidate.read;
    if (!userRead || !candidate.node.isConnected) {
      continue;
    }
    const index = candidateMatches[candidateIndex]?.indexOf(true) ?? -1;
    const verifiedText = userRead.texts[index];
    if (verifiedText !== undefined) {
      matchingMessages.push({
        node: candidate.node,
        read: {
          ...userRead,
          texts: [verifiedText, ...userRead.texts.filter((text) => text !== verifiedText)],
        },
      });
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
    const discovery = unchangedDiscovery();
    const latestMatch = leafMatches.at(-1);
    if (latestMatch) {
      const response = duplicateRecoveryResponse(
        latestMatch.node,
        matchingMessages.map((match) => match.node),
        base,
      );
      const userText = latestMatch.read.texts[0];
      if (response && userText !== undefined) {
        const recovery = recoveryObservation('duplicate_send', validReceipt, userText, response);
        if (recovery) {
          discovery.replyRecovery = recovery;
        }
      }
    }
    return discovery;
  }
  if (!leafMatches.length) {
    if (base.stats.users) {
      receiptStats.state = 'mismatch';
      return unchangedDiscovery();
    }
    // A matching marker permits ONLY opening Show more, not acknowledging or
    // importing. The next read must recover and verify the COMPLETE body.
    const expectedBeginning = 'MITTER EXCHANGE ' + validReceipt.exchangeId;
    const collapsedCandidates = candidateReads
      .filter(({ node, read }) => {
        if (!validReceipt.exchangeId || !read || receiptRoleConflict(node)) {
          return false;
        }
        // A transcript ancestor may contain this nonce and older Show more
        // buttons. Only a candidate beginning with this exchange can own its
        // disclosure; a marker somewhere inside the page is not a user bubble.
        const startsCurrentExchange = read.texts.some((text) => {
          const beginning = text.replace(/\s+/g, ' ').trimStart();
          return beginning === expectedBeginning || beginning.startsWith(expectedBeginning + ' ');
        });
        return startsCurrentExchange && messageDisclosure(node, true).collapsed;
      })
      .map(({ node }) => node);
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
      let activity: Node | undefined;
      let responseBranch = followingBranches[0];
      const finalBranch = followingBranches[1];
      if (
        followingBranches.length === 2 &&
        responseBranch &&
        finalBranch &&
        collapsedActivity(branch, responseBranch, finalBranch)
      ) {
        activity = responseBranch;
        responseBranch = finalBranch;
      }
      if ((!activity && followingBranches.length !== 1) || !(responseBranch instanceof HTMLElement)) {
        receiptStats.state = 'unknown_tail';
        transcriptStats.unclassifiedTail = true;
        transcriptStats.state = 'partial';
        return discovery;
      }
      if (base.stats.users) {
        const userIndex = base.messages.indexOf(matchedMessage.node);
        const knownTail = base.messages
          .slice(userIndex + 1)
          .filter((message) => !activity?.contains(message));
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
      // A stopped stream can leave only ChatGPT's error notice and Retry
      // control. It is evidence to request another reply, never an action
      // batch or permission to click an arbitrary button in a message.
      if (
        validReceipt.exchangeId &&
        hasStreamRetry(responseBranch) &&
        !responseBranch.querySelector('pre,code,blockquote,a,textarea,[contenteditable="true"]') &&
        /^(?:ChatGPT said:\s*(?:ChatGPT\s*)?)?Error in message stream\.?\s*(?:Retry)?$/i.test(
          responseBranch.innerText.trim(),
        )
      ) {
        discovery.replyRecovery = {
          kind: 'unreadable_reply',
          issue: 'PROVIDER_STREAM_ERROR',
          exchangeId: validReceipt.exchangeId,
          userText: verifiedText,
          responseText: 'Error in message stream',
          format: 'plain',
        };
        receiptStats.state = 'waiting_reply';
        return discovery;
      }
      if (!hasAssistantRole && !responseOnly) {
        // An incomplete response row often gets its action toolbar only after
        // streaming. Never infer completion from valid JSON alone.
        receiptStats.state = 'waiting_reply';
        transcriptStats.unclassifiedTail = true;
        transcriptStats.state = 'partial';
        const recovery = recoveryObservation('unreadable_reply', validReceipt, verifiedText, responseBranch);
        if (recovery) {
          discovery.replyRecovery = recovery;
        }
        return discovery;
      }
      const nativeAssistant = discovery.messages.find(
        (message) => messageRole(message) === 'assistant' && responseBranch.contains(message),
      );
      let responseMessage = responseBranch;
      if (nativeAssistant) {
        if (!nativeMessageWrapper(responseBranch, nativeAssistant, base)) {
          // Keep residual content visible to the coordinator even when a
          // nested literal reply independently matches the exchange nonce.
          receiptStats.state = 'unknown_tail';
          transcriptStats.unclassifiedTail = true;
          transcriptStats.state = 'partial';
          return discovery;
        }
        responseMessage = nativeAssistant;
      }
      const assistantRead = readAnchoredAssistant(responseMessage);
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
      } catch {
        const recovery = recoveryObservation('unreadable_reply', validReceipt, verifiedText, responseBranch);
        if (recovery) {
          discovery.replyRecovery = recovery;
        }
      }
      if (responseMessage !== nativeAssistant) {
        setReceiptRole(responseBranch, 'assistant', identity);
        discovery.messages = discovery.messages.filter((message) => !responseBranch.contains(message));
        discovery.messages.push(responseBranch);
      }
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
    if (
      !matchingMessages.some((match) => match.node === parent) &&
      !nativeMessageWrapper(parent, matchedMessage.node, base)
    ) {
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
