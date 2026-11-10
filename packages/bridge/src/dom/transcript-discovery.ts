import { contentHidden, htmlElements, pageElements, parentAcrossShadow } from './page-elements.js';
import type { MessageRole, TranscriptStats } from './types.js';

let discoveredRoles = new WeakMap<HTMLElement, MessageRole>();

let receiptIdentities = new WeakMap<HTMLElement, string>();

const roleAttributes = [
  'data-message-author-role',
  'data-turn',
  'data-message-role',
  'data-author-role',
  'data-role',
] as const;

const turnSelector =
  'article[data-testid^="conversation-turn"],article[data-turn],article[data-turn-id],[data-message-id],[data-turn-id],[data-testid^="conversation-turn-"]';

export const roleSelector =
  roleAttributes.map((attribute) => '[' + attribute + ']').join(',') +
  ',[data-testid="user-message"],[data-testid="assistant-message"],[data-testid="user-message-content"],[data-testid="assistant-message-content"]';

export function transcriptExcluded(element: HTMLElement): boolean {
  for (let ancestor: Element | null = element; ancestor; ancestor = parentAcrossShadow(ancestor)) {
    if (
      ancestor.matches(
        'form,nav,aside,[role="navigation"],[role="dialog"],dialog,textarea,[contenteditable="true"],pre,code,script,style,template,#mitter-automation-control,[data-mitter-ui]',
      )
    ) {
      return true;
    }
  }
  return contentHidden(element);
}

export function explicitRole(element: HTMLElement): MessageRole {
  const roles = new Set<MessageRole>();
  for (const attribute of roleAttributes) {
    const value = element.getAttribute(attribute)?.toLowerCase();
    if (value === 'user' || value === 'assistant') {
      roles.add(value);
    }
  }
  const testId = element.getAttribute('data-testid');
  if (testId === 'user-message' || testId === 'user-message-content') {
    roles.add('user');
  }
  if (testId === 'assistant-message' || testId === 'assistant-message-content') {
    roles.add('assistant');
  }
  if (roles.size === 1) {
    for (const role of roles) {
      return role;
    }
  }
  if (roles.size > 1) {
    return 'unknown';
  }
  return '';
}

export function headingRole(element: Element): MessageRole {
  if (!element.matches('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
    return '';
  }
  const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
  if (
    /^(?:You said|You|Vous avez dit|Tú dijiste|Has dicho|Du hast gesagt|Você disse|أنت قلت|قلت)[：:]?$/i.test(
      text,
    )
  ) {
    return 'user';
  }
  if (
    /^(?:ChatGPT said|ChatGPT|Assistant|ChatGPT a dit|ChatGPT dijo|ChatGPT hat gesagt|ChatGPT disse|قال ChatGPT)[：:]?$/i.test(
      text,
    )
  ) {
    return 'assistant';
  }
  return '';
}

export function messageRole(message: HTMLElement | undefined): MessageRole {
  if (!message) {
    return '';
  }
  return discoveredRoles.get(message) || explicitRole(message);
}

export function messageIdentity(message: HTMLElement | undefined): string {
  if (message) {
    const receiptIdentity = receiptIdentities.get(message);
    if (receiptIdentity !== undefined) {
      return receiptIdentity;
    }
  }
  for (let node: Element | null = message || null; node; node = parentAcrossShadow(node)) {
    const identity = node.getAttribute('data-message-id') || node.getAttribute('data-turn-id');
    if (identity && identity.length <= 200) {
      return identity;
    }
    if (node.matches('main,body,html,[role="main"]')) {
      break;
    }
  }
  // A turn's DOM id is more useful than a shifting transcript array index.
  if (message?.id && message.id.length <= 200) {
    return message.id;
  }
  return '';
}

export function discoverMessages(): {
  messages: HTMLElement[];
  stats: TranscriptStats;
} {
  const scan = pageElements();
  const eligible = scan.elements.filter(
    (element) => element.matches(roleSelector + ',article,' + turnSelector) && !transcriptExcluded(element),
  );
  const candidates = new Map<HTMLElement, MessageRole>();
  let explicitRoles = 0;
  let alternativeRoles = 0;
  let semanticRoles = 0;
  for (const element of eligible) {
    const role = explicitRole(element);
    if (role) {
      candidates.set(element, role);
      if (element.hasAttribute('data-message-author-role')) {
        explicitRoles++;
      } else {
        alternativeRoles++;
      }
    }
  }
  const containers = eligible.filter(
    (element) => element.matches(turnSelector) || element.tagName === 'ARTICLE',
  );
  for (const element of containers) {
    if (candidates.has(element)) {
      continue;
    }
    // Only the outer turn heading is role metadata; headings embedded inside
    // the message/code are ordinary content and never relabel a message.
    const heading = htmlElements(element, 'h1,h2,h3,h4,h5,h6,[role="heading"]').find(
      (heading) =>
        !heading.closest('pre,code,.markdown,[data-message-content]') &&
        heading.closest('article,[data-testid^="conversation-turn-"]') === element,
    );
    let role: MessageRole = '';
    if (heading) {
      role = headingRole(heading);
    }
    if (role) {
      candidates.set(element, role);
      semanticRoles++;
    }
  }
  const roleElements = [...candidates.keys()];
  const leafMessages = roleElements.filter(
    (element) => !roleElements.some((other) => other !== element && element.contains(other)),
  );
  const messageRoots = leafMessages.map((leaf) => {
    let role = candidates.get(leaf);
    if (role === undefined) {
      throw new Error('A discovered message lost its role metadata.');
    }
    let root = leaf;
    for (let parent = leaf.parentElement; parent; parent = parent.parentElement) {
      if (!candidates.has(parent)) {
        continue;
      }
      const outerRole = candidates.get(parent);
      const outerIdentity = messageIdentity(parent);
      const innerIdentity = messageIdentity(root);
      if (outerRole !== role) {
        role = 'unknown';
        candidates.set(leaf, role);
        break;
      }
      if (
        leafMessages.filter((node) => parent.contains(node)).length !== 1 ||
        (outerIdentity && innerIdentity && outerIdentity !== innerIdentity)
      ) {
        break;
      }
      root = parent;
    }
    return { root, role };
  });
  const messages: HTMLElement[] = [];
  for (const { root, role } of messageRoots) {
    discoveredRoles.set(root, role);
    if (!messages.includes(root)) {
      messages.push(root);
    }
  }
  // Preserve unclassified turn containers as barriers, rather than ignoring a
  // human intervention simply because its renderer has unfamiliar attributes.
  for (const element of containers) {
    const hasPeer = messages.some(
      (message) => (message.closest('article') || message).parentElement === element.parentElement,
    );
    if (
      !(element.matches(turnSelector) || (element.tagName === 'ARTICLE' && hasPeer)) ||
      messages.some(
        (message) => message === element || message.contains(element) || element.contains(message),
      )
    ) {
      continue;
    }
    if (
      containers.some((child) => child !== element && element.contains(child) && child.matches(turnSelector))
    ) {
      continue;
    }
    if (!(element.textContent || '').trim()) {
      continue;
    }
    discoveredRoles.set(element, 'unknown');
    messages.push(element);
  }
  const elementOrder = new Map(scan.elements.map((element, index) => [element, index]));
  messages.sort((first, second) => {
    const firstOrder = elementOrder.get(first);
    const secondOrder = elementOrder.get(second);
    if (firstOrder === undefined || secondOrder === undefined) {
      return 0;
    }
    return firstOrder - secondOrder;
  });
  const users = messages.filter((element) => messageRole(element) === 'user').length;
  const assistants = messages.filter((element) => messageRole(element) === 'assistant').length;
  const unknownTurns = messages.filter((element) => messageRole(element) === 'unknown').length;
  const codeBlocks = scan.elements.filter(
    (element) =>
      element.tagName === 'PRE' &&
      !element.closest('form,nav,aside,[data-mitter-ui]') &&
      !contentHidden(element),
  ).length;
  let state: TranscriptStats['state'] = 'empty';
  if (scan.limited) {
    state = 'partial';
  } else if (users + assistants) {
    state = 'ready';
  } else if (unknownTurns || containers.length || codeBlocks) {
    state = 'unrecognized';
  }
  const stats: TranscriptStats = {
    version: 'message-discovery/1',
    state,
    roleAttributes: explicitRoles,
    alternativeRoles: alternativeRoles,
    semanticRoles: semanticRoles,
    turnContainers: containers.length,
    unknownTurns,
    unclassifiedTail: messages.some(
      (element, index) =>
        messageRole(element) === 'unknown' &&
        index > messages.findLastIndex((message) => messageRole(message) === 'user'),
    ),
    users,
    assistants,
    codeBlocks,
    openShadowRoots: scan.shadows,
    frames: scan.elements.filter((element) => element.tagName === 'IFRAME').length,
    scanLimited: scan.limited,
  };
  return { messages, stats };
}

export function logicalMessages(): HTMLElement[] {
  return discoverMessages().messages;
}

export function setReceiptRole(message: HTMLElement, role: 'user' | 'assistant', identity: string): void {
  discoveredRoles.set(message, role);
  // Synthetic identities are correlation hints only. Content/receipt and
  // proposal validation still run before each import in BridgeRunner.
  receiptIdentities.set(message, identity);
}

export function resetMessageDiscoveryState(): void {
  discoveredRoles = new WeakMap();
  receiptIdentities = new WeakMap();
}
