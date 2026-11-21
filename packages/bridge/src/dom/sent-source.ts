import { rawDraftDigest } from '../bootstrap-draft.js';
import { unwrapMessage, type OutboundReceipt } from '../message-wire.js';
import { composerText, findComposer } from './composer-operations.js';
import { readCodeReply } from './code-replies.js';
import { forgetSentSource, rememberSentSource } from './session-state.js';
import { contentHidden, generationActive, htmlElements } from './page-elements.js';
import { discoverMessages, messageIdentity, messageRole } from './transcript-discovery.js';
import type { ChatView, DomRequest } from './types.js';
import { editableText, readUserMessageVariants } from './user-reader.js';

const turnSelector = '[data-chatgpt-search-unit-key$=":user"][data-chatgpt-search-message-ids]';
const bubbleSelector = '[data-user-message-bubble="true"]';
const editorSelector = '.ProseMirror[role="textbox"][contenteditable="true"][aria-label="Edit message"]';
const editSelector = 'button[type="button"][aria-label="Edit message"]';
function uniqueVisible(root: ParentNode, selector: string): HTMLElement | undefined {
  const nodes = htmlElements(root, selector).filter((node) => !contentHidden(node));
  if (nodes.length === 1) {
    return nodes[0];
  }
  return undefined;
}

function activeButton(element: HTMLElement | undefined): element is HTMLButtonElement {
  return (
    element instanceof HTMLButtonElement &&
    !element.disabled &&
    element.getAttribute('aria-disabled') !== 'true'
  );
}

function lastBoundTurn(userId: string, assistantId: string, exchange: string): HTMLElement | undefined {
  const { messages, stats } = discoverMessages();
  const user = messages.at(-2);
  const assistant = messages.at(-1);
  if (
    stats.scanLimited ||
    stats.unclassifiedTail ||
    messageRole(user) !== 'user' ||
    messageIdentity(user) !== userId ||
    messageRole(assistant) !== 'assistant' ||
    messageIdentity(assistant) !== assistantId ||
    !user?.matches(bubbleSelector)
  ) {
    return;
  }
  const scope = user.closest(turnSelector);
  if (
    !(scope instanceof HTMLElement) ||
    scope.getAttribute('data-chatgpt-search-message-ids') !== userId ||
    uniqueVisible(scope, bubbleSelector) !== user
  ) {
    return;
  }
  // A duplicate exchange elsewhere in the chat is ambiguous even when the
  // provider gave those user turns different native IDs.
  const marker = 'END MITTER EXCHANGE ' + exchange;
  if (
    messages.some(
      (node) => messageRole(node) === 'user' && node !== user && node.textContent?.includes(marker),
    )
  ) {
    return;
  }
  return scope;
}

// React may commit the open/close transition after the click returns. A
// mutation wakes a background tab too, without polling a hidden-page timer.
function waitForElement<T>(scope: HTMLElement, read: () => T | undefined): Promise<T | undefined> {
  const current = read();
  if (current) {
    return Promise.resolve(current);
  }
  return new Promise((resolve) => {
    const finish = (value?: T): void => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      const result = read();
      if (result) {
        finish(result);
      }
    });
    const timer = window.setTimeout(() => finish(), 800);
    observer.observe(scope, { subtree: true, childList: true, attributes: true });
  });
}

/** If ChatGPT's presentation lost source characters, read its own unsent
 * Edit message form. The only exit action is Cancel. No source is modified,
 * submitted, or returned until the byte-exact pre-send fingerprint matches. */
export async function recoverSentSource(
  request: DomRequest,
  receipt: OutboundReceipt,
  view: ChatView,
  checkSession: () => void,
): Promise<boolean> {
  const exchange = receipt.exchangeId;
  const id = view.lastUserId;
  const url = new URL(request.url);
  if (
    !exchange ||
    !receipt.composerHash ||
    !id ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ||
    request.replyTo !== exchange ||
    request.workerId !== receipt.workerId ||
    request.projectId !== receipt.projectId ||
    request.replyId ||
    request.allowConversationBind ||
    view.url !== url.origin + url.pathname.replace(/\/$/, '') ||
    view.busy ||
    view.draftText !== '' ||
    !view.ready ||
    !view.complete ||
    view.lastUserCollapsed ||
    view.lastUserTruncated ||
    view.transcript?.receiptDiscovery?.state !== 'mismatch' ||
    view.transcript.unclassifiedTail ||
    (receipt.acknowledgedUserId && receipt.acknowledgedUserId !== id) ||
    !view.codeReply ||
    view.codeReply.replyTo !== exchange ||
    view.codeReply.workerId !== receipt.workerId ||
    view.codeReply.projectId !== receipt.projectId ||
    view.codeReplyCount !== 1 ||
    !(view.lastUserCandidates || [])
      .concat(view.lastUserText)
      .some((text) => unwrapMessage(text)?.exchangeId === exchange)
  ) {
    return false;
  }
  const scope = lastBoundTurn(id, view.assistantId, exchange);
  const field = findComposer();
  if (
    !scope ||
    !field ||
    composerText(field) !== '' ||
    generationActive() ||
    document.querySelector(editorSelector) ||
    scope.querySelector('form,textarea,[contenteditable="true"]')
  ) {
    return false;
  }
  const bubble = uniqueVisible(scope, bubbleSelector);
  const edit = uniqueVisible(scope, editSelector);
  if (
    !bubble ||
    !activeButton(edit) ||
    bubble.contains(edit) ||
    !bubble.querySelector('[data-markdown-text-tone="user-message"].rich-text-serialized-paragraphs')
  ) {
    return false;
  }
  checkSession();
  // The open transition can yield to a human keystroke. Once the user types
  // into the form they own it; never cancel their edit, even on a hash match.
  let userInput = false;
  const onInput = (): void => {
    userInput = true;
  };
  scope.addEventListener('beforeinput', onInput, true);
  scope.addEventListener('input', onInput, true);
  let source: string;
  try {
    edit.click();
    const form = await waitForElement(scope, () => uniqueVisible(scope, 'form'));
    if (!form || userInput) {
      return false;
    }
    const cancel = htmlElements(form, 'button[type="button"]').filter(
      (button) => !contentHidden(button) && (button.textContent || '').trim() === 'Cancel',
    );
    if (cancel.length !== 1 || !activeButton(cancel[0])) {
      return false;
    }
    const editor = uniqueVisible(form, editorSelector);
    source = '';
    if (editor) {
      source = editableText(editor);
    }
    // Read and dismiss in the same synchronous turn, before hashing yields.
    cancel[0].click();
  } finally {
    scope.removeEventListener('beforeinput', onInput, true);
    scope.removeEventListener('input', onInput, true);
  }
  const restored = await waitForElement(
    scope,
    () => (!scope.querySelector('form') && uniqueVisible(scope, bubbleSelector)) || undefined,
  );
  if (
    !restored ||
    source.length > 160000 ||
    unwrapMessage(source)?.exchangeId !== exchange ||
    readUserMessageVariants(restored).texts[0] !== view.lastUserText
  ) {
    return false;
  }
  const observer = new MutationObserver(() => {
    changed = true;
    forgetSentSource();
  });
  let changed = false;
  observer.observe(scope, { attributes: true, childList: true, characterData: true, subtree: true });
  let remembered = false;
  try {
    const hash = await rawDraftDigest(source);
    checkSession();
    if (
      hash !== receipt.composerHash ||
      changed ||
      observer.takeRecords().length ||
      lastBoundTurn(id, view.assistantId, exchange) !== scope ||
      uniqueVisible(scope, bubbleSelector) !== restored ||
      findComposer() !== field ||
      composerText(field) !== '' ||
      generationActive()
    ) {
      return false;
    }
    const reply = readCodeReply(receipt.workerId, receipt.projectId, undefined, exchange);
    if (
      reply.count !== 1 ||
      reply.reply?.id !== view.codeReply.id ||
      reply.reply.text !== view.codeReply.text
    ) {
      return false;
    }
    rememberSentSource(restored, source, observer);
    remembered = true;
    return true;
  } finally {
    if (!remembered) {
      observer.disconnect();
    }
  }
}
