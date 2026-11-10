import { decodeRenderedMessage, decodeFlatRenderedMessages, messagePayload } from '../message-wire.js';
import { contentHidden, htmlElements } from './page-elements.js';
import { headingRole, messageRole, roleSelector } from './transcript-discovery.js';
import type { MessageDisclosure, ObservedTaskTurn, UserReadResult } from './types.js';

/** innerText is a layout API: Chromium adds an extra newline around an empty
 * block after insertText. Serialize the editor's logical lines instead. This
 * does not collapse spaces or blank lines in the actual task/code. */
export function editableText(root: HTMLElement): string {
  const blockTags = new Set(['DIV', 'P', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const readNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || '';
    }
    if (!(node instanceof HTMLElement)) {
      return '';
    }
    if (node.tagName === 'BR') {
      if (node.classList.contains('ProseMirror-trailingBreak')) {
        return '';
      }
      return '\n';
    }
    const childNodes = Array.from(node.childNodes).filter(
      (child) => !(child instanceof HTMLElement && child.classList.contains('ProseMirror-trailingBreak')),
    );
    const onlyChild = childNodes[0];
    if (childNodes.length === 1 && onlyChild instanceof HTMLElement && onlyChild.tagName === 'BR') {
      return '';
    }
    let output = '';
    let previousWasBlock = false;
    let hasPreviousChild = false;
    for (const child of childNodes) {
      const isBlock = child instanceof HTMLElement && blockTags.has(child.tagName);
      if (hasPreviousChild && (previousWasBlock || isBlock)) {
        output += '\n';
      }
      output += readNode(child);
      previousWasBlock = isBlock;
      hasPreviousChild = true;
    }
    return output;
  };
  return readNode(root);
}

/** A narrow presentation-only disclosure detector. Never click Copy, Edit,
 * Regenerate, Send, a link, an assistant control, or a button embedded in code.
 * We do not synthesize shortcuts or invoke private page endpoints.
 */
export function messageDisclosure(message: HTMLElement, bounded = false): MessageDisclosure {
  let root = message;
  // Some renderers put Show more next to the role node rather than inside it.
  // Climb only within a container that holds exactly this user message.
  for (
    let parent = message.parentElement, depth = 0;
    !bounded && parent && depth < 5;
    parent = parent.parentElement, depth++
  ) {
    if (['MAIN', 'BODY', 'HTML', 'FORM'].includes(parent.tagName)) {
      break;
    }
    const roles = htmlElements(parent, roleSelector).filter((element) => !contentHidden(element));
    if (
      roles.some(
        (element) =>
          messageRole(element) === 'assistant' ||
          (messageRole(element) === 'user' && !message.contains(element) && !element.contains(message)),
      )
    ) {
      break;
    }
    root = parent;
    if (parent.matches('article,[data-testid^="conversation-turn-"]')) {
      break;
    }
  }
  const disclosureLabelPattern =
    /^(?:show more|read more|expand(?: (?:message|text))?|view (?:full|entire) message|afficher (?:plus|la suite)|voir plus|mostrar m[aá]s|ver m[aá]s|mehr anzeigen|mostrar mais|عرض المزيد)(?:[.\u2026]*)$/i;
  const disclosureControls = htmlElements(root, 'button,[role="button"],summary').filter((element) => {
    if (
      contentHidden(element) ||
      element.closest('pre,code') ||
      element.getAttribute('aria-expanded') === 'true' ||
      element.closest('[data-message-author-role="assistant"]')
    ) {
      return false;
    }
    const labelCopy = element.cloneNode(true);
    if (!(labelCopy instanceof HTMLElement)) {
      throw new TypeError('A disclosure control did not clone as an HTML element.');
    }
    labelCopy.querySelectorAll('svg,[aria-hidden="true"]').forEach((icon) => icon.remove());
    const label = (element.getAttribute('aria-label') || labelCopy.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!disclosureLabelPattern.test(label)) {
      return false;
    }
    if (
      element.tagName === 'SUMMARY' &&
      (!(element.parentElement instanceof HTMLDetailsElement) || element.parentElement.open)
    ) {
      return false;
    }
    return true;
  });
  // Labels are sufficient to detect a supported disclosure; clipping alone is
  // not evidence that underlying text is missing. The reader tries full text
  // first and only uses expansion when the saved receipt does not match.
  return {
    controls: disclosureControls.filter(
      (element) => element.getAttribute('aria-disabled') !== 'true' && !element.matches(':disabled'),
    ),
    collapsed: disclosureControls.length > 0,
  };
}

export function readUserMessageVariants(message: HTMLElement): UserReadResult {
  const texts = [readUserMessage(message), readUserMessage(message, true)];
  // A literal bubble need not use semantic PRE/CODE tags. Read the whole
  // sanitized bubble, never just a matching marker or a convenient substring.
  // Candidates are inert until the runner verifies the entire saved receipt.
  const messageClone = userContentClone(message);
  if (!messageClone.matches('pre,code') && !messageClone.querySelector('pre,code')) {
    for (const full of [editableText(messageClone), messageClone.textContent || '']) {
      texts.push(...decodeFlatRenderedMessages(full));
    }
  }
  const uniqueTexts = [...new Set(texts)].slice(0, 6);
  return {
    texts: uniqueTexts,
    stats: {
      serializer: 'user-turn/6',
      roleElements: 1 + message.querySelectorAll('[data-message-author-role]').length,
      preElements: message.querySelectorAll('pre').length,
      codeElements: message.querySelectorAll('code').length,
      candidates: uniqueTexts.length,
      candidateCharacters: uniqueTexts.map((text) => text.length),
      framedCandidates: uniqueTexts.filter((text) => messagePayload(text) !== text).length,
    },
  };
}

function userContentClone(message: HTMLElement): HTMLElement {
  // Prefer the bubble's actual text over the role wrapper containing Edit/Copy,
  // branch controls and accessibility-only labels.
  const contentBodies = htmlElements(message, '[data-message-content],.whitespace-pre-wrap,.markdown').filter(
    (element) => !contentHidden(element),
  );
  // .whitespace-pre-wrap is also used INSIDE a fenced code renderer. A match
  // is not necessarily the message bubble. Prefer it only when no substantive
  // message text exists outside it (e.g. exchange header/footer). Otherwise
  // parse the complete role container, excluding its controls below.
  const coversMessage = (candidate: HTMLElement): boolean => {
    const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const parent = textNode.parentElement;
      if (
        candidate.contains(textNode) ||
        !parent ||
        contentHidden(parent) ||
        parent.closest(
          'button,[role="button"],summary,svg,script,style,template,[data-message-toolbar],[data-mitter-ui]',
        )
      ) {
        continue;
      }
      if ((textNode.nodeValue || '').trim()) {
        return false;
      }
    }
    return true;
  };
  const contentBody =
    contentBodies.find(
      (element) =>
        !contentBodies.some((other) => other !== element && other.contains(element)) &&
        coversMessage(element),
    ) || message;
  const messageClone = contentBody.cloneNode(true);
  if (!(messageClone instanceof HTMLElement)) {
    throw new TypeError('A user message did not clone as an HTML element.');
  }
  const originalElements = [contentBody, ...Array.from(contentBody.querySelectorAll('*'))];
  const clonedElements = [messageClone, ...Array.from(messageClone.querySelectorAll('*'))];
  for (let index = 1; index < originalElements.length; index++) {
    const element = originalElements[index];
    if (!element) {
      continue;
    }
    if (
      contentHidden(element) ||
      element.matches(
        'button,[role="button"],summary,svg,script,style,template,[data-message-toolbar],[data-mitter-ui]',
      ) ||
      (!!headingRole(element) && !element.closest('pre,code,.markdown,[data-message-content]'))
    ) {
      clonedElements[index]?.remove();
    }
  }
  return messageClone;
}

export function readUserMessage(message: HTMLElement, logicalCodeLines = false): string {
  const messageClone = userContentClone(message);
  const preElements: HTMLElement[] = [];
  if (messageClone.tagName === 'PRE') {
    preElements.push(messageClone);
  }
  preElements.push(...htmlElements(messageClone, 'pre'));
  const leafPreElements = preElements.filter(
    (preElement) =>
      !preElements.some(
        (otherPreElement) => otherPreElement !== preElement && preElement.contains(otherPreElement),
      ),
  );
  const payloadElements: HTMLElement[] = [];
  for (const pre of leafPreElements) {
    const codeElements = htmlElements(pre, 'code');
    if (codeElements.length) {
      payloadElements.push(
        ...codeElements.filter(
          (codeElement) =>
            !codeElements.some((other) => other !== codeElement && other.contains(codeElement)),
        ),
      );
    } else {
      payloadElements.push(pre);
    }
  }
  // Some code components use a DIV around CODE, not PRE. It is a candidate
  // only when the *entire* surrounding message has the exact known framing.
  if (!preElements.length) {
    const codeElements: HTMLElement[] = [];
    if (messageClone.tagName === 'CODE') {
      codeElements.push(messageClone);
    }
    codeElements.push(...htmlElements(messageClone, 'code'));
    payloadElements.push(
      ...codeElements.filter(
        (codeElement) => !codeElements.some((other) => other !== codeElement && other.contains(codeElement)),
      ),
    );
  }
  const payloadElement = payloadElements[0];
  if (payloadElements.length === 1 && payloadElement) {
    let payload = payloadElement.textContent || '';
    if (logicalCodeLines) {
      payload = editableText(payloadElement);
    }
    // Preserve inline text-node adjacency. Adding spaces after every text node
    // corrupts a UUID or word split across SPANs. Introduce boundaries only at
    // actual block elements/BRs, using the existing logical-text serializer.
    let payloadMarker = '\uE000MITTER_PAYLOAD\uE001';
    while ((messageClone.textContent || '').includes(payloadMarker)) {
      payloadMarker += '\uE002';
    }
    const markerNode = document.createTextNode(payloadMarker);
    payloadElement.replaceWith(markerNode);
    const messageShell = editableText(messageClone);
    const markerIndex = messageShell.indexOf(payloadMarker);
    let framedMessage: string | undefined;
    if (markerIndex >= 0) {
      framedMessage = decodeRenderedMessage(
        messageShell.slice(0, markerIndex),
        payload,
        messageShell.slice(markerIndex + payloadMarker.length),
      );
    }
    markerNode.replaceWith(payloadElement);
    if (framedMessage !== undefined) {
      return framedMessage;
    }
  }
  return editableText(messageClone);
}

/** One-time legacy recovery lower bound, not a global DOM-count progress bar.
 * Only task-shaped user messages are counted; hidden mirrors are removed by
 * logicalMessages, and duplicate rendered copies collapse by complete content.
 * Returning counts instead of historical bodies keeps the bridge payload small. */
export function countTaskTurns(users: HTMLElement[]): ObservedTaskTurn[] {
  const groups = new Map<string, { workerId: string; projectId: string; texts: Set<string> }>();
  for (const user of users.slice(-256)) {
    const renderedText = readUserMessage(user);
    if (renderedText.length > 160000) {
      continue;
    }
    const payload = messagePayload(renderedText);
    if (
      !payload.startsWith('You are collaborating with Mitter,') ||
      !payload.includes('GOAL: ') ||
      !payload.includes('For THIS ChatGPT handoff')
    ) {
      continue;
    }
    const workerId = /"workerId"\s*:\s*"([a-zA-Z0-9_-]{1,100})"/.exec(payload)?.[1];
    const projectId = /"projectId"\s*:\s*"([a-zA-Z0-9_-]{1,100})"/.exec(payload)?.[1];
    if (!workerId || !projectId) {
      continue;
    }
    const taskKey = workerId + ':' + projectId;
    const taskGroup = groups.get(taskKey) || {
      workerId,
      projectId,
      texts: new Set<string>(),
    };
    taskGroup.texts.add(renderedText);
    groups.set(taskKey, taskGroup);
  }
  return [...groups.values()].map(({ workerId, projectId, texts }) => ({
    workerId,
    projectId,
    count: texts.size,
  }));
}
