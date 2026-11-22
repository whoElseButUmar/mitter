import { sameMessage } from '../message-wire.js';
import { normalizeMessageText } from '../schemas/primitives.js';
import { composerSelector, pageElements } from './page-elements.js';
import type { ComposerState } from './session-state.js';
import { editableText } from './user-reader.js';
import { attachComposerImage, checkComposerImages, sameImageAttachments } from './composer-images.js';
import { isEmptyChat, type ChatView, type DomRequest, type PreparedMessage } from './types.js';

export type { ComposerState } from './session-state.js';

function failOperation(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function isVisible(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden' &&
    getComputedStyle(element).display !== 'none'
  );
}

export function findComposer(): HTMLElement | undefined {
  return pageElements().elements.find((element) => element.matches(composerSelector) && isVisible(element));
}

export function composerText(element: HTMLElement): string {
  if (element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return editableText(element);
}

function findSendControl(composer: HTMLElement): HTMLButtonElement | undefined {
  const composerForm = composer.closest('form');
  const sendCandidates = pageElements().elements.filter(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.matches(
        'button[data-testid="send-button"],button#composer-submit-button,button[aria-label="Send prompt"],button[aria-label="Send message"]',
      ),
  );
  if (composerForm) {
    for (const button of Array.from(composerForm.querySelectorAll('button[type="submit"]'))) {
      if (button instanceof HTMLButtonElement) {
        sendCandidates.push(button);
      }
    }
  }
  return sendCandidates.find(
    (button) =>
      (!composerForm || composerForm.contains(button)) &&
      isVisible(button) &&
      !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true' &&
      !/stop|voice|dictat|microphone/i.test(button.getAttribute('aria-label') || ''),
  );
}

function isPreparedMessageSent(view: ChatView, prepared: PreparedMessage): boolean {
  const changed =
    view.userCount > prepared.userCount ||
    view.lastUserText !== prepared.lastUserText ||
    (!!view.lastUserId && view.lastUserId !== prepared.lastUserId);
  return (
    !view.draft &&
    changed &&
    (sameMessage(view.lastUserText, prepared.text) ||
      (typeof prepared.renderedText === 'string' && sameMessage(view.lastUserText, prepared.renderedText)))
  );
}

function preparedUserChanged(view: ChatView, prepared: PreparedMessage): boolean {
  return (
    view.lastUserText !== prepared.lastUserText ||
    (!!view.lastUserId && !!prepared.lastUserId && view.lastUserId !== prepared.lastUserId)
  );
}

function checkManualImageSend(prepared: PreparedMessage): void {
  if (prepared.imageAttachments?.length) {
    failOperation(
      'IMAGE_SEND_UNCONFIRMED',
      'The message was sent directly in ChatGPT. Miter could not verify its images and did not send it again.',
    );
  }
}

function checkBootstrapDraft(request: DomRequest, view: ChatView, text: string): void {
  if (request.adoptBootstrapDraft && (!isEmptyChat(view) || view.draftText !== text)) {
    failOperation('DRAFT_CHANGED', 'The prepared task draft or chat changed. No new Send was attempted.');
  }
}

export async function sendComposerMessage(
  request: DomRequest,
  session: ComposerState,
  collectView: () => Promise<ChatView>,
  checkSession: () => void,
  isExpectedURL: () => boolean,
): Promise<ChatView> {
  const text = request.text;
  const messageId = request.messageId || 'legacy-' + request.token;
  if (typeof text !== 'string' || !text.trim() || text.length > 160000) {
    failOperation('INVALID_MESSAGE', 'The outgoing message is empty or too large.');
  }
  const outgoingText = text;
  const imageAttachments = request.imageAttachments;
  const hasImages = !!imageAttachments?.length;
  if (hasImages && (!request.messageId || request.op === 'send')) {
    failOperation('INVALID_IMAGE', 'Images require a prepared send request.');
  }
  const previousRecord = session.committed.get(messageId);
  if (previousRecord) {
    if (
      previousRecord.text !== outgoingText ||
      !sameImageAttachments(previousRecord.imageAttachments, imageAttachments)
    ) {
      failOperation('MESSAGE_CONFLICT', 'A send ID was reused with different content.');
    }
    if (request.op === 'attach_image') {
      failOperation(
        'MESSAGE_ALREADY_SENT',
        'This message was already sent. No new image upload was started.',
      );
    }
    return { ...(await collectView()), outcome: 'already_clicked' };
  }
  if (request.op === 'prepare' || request.op === 'send') {
    if (!isExpectedURL()) {
      failOperation('NAVIGATED', 'The conversation changed before preparing the task. No text was changed.');
    }
    // Each request does bounded work, then yields to the BACKGROUND scheduler.
    // No readiness timer or animation frame runs in a hidden chat document.
    const previousView = await collectView();
    checkSession();
    let preparedMessage: PreparedMessage | undefined;
    if (session.prepared?.id === messageId) {
      preparedMessage = session.prepared;
    }
    if (
      preparedMessage &&
      (preparedMessage.text !== outgoingText ||
        !sameImageAttachments(preparedMessage.imageAttachments, imageAttachments))
    ) {
      failOperation('MESSAGE_CONFLICT', 'A prepared message ID was reused with different content.');
    }
    if (preparedMessage) {
      if (isPreparedMessageSent(previousView, preparedMessage)) {
        checkManualImageSend(preparedMessage);
        session.committed.set(messageId, {
          text: outgoingText,
          time: Date.now(),
          imageAttachments,
        });
        return { ...previousView, outcome: 'already_sent' };
      }
      if (preparedUserChanged(previousView, preparedMessage)) {
        failOperation(
          'USER_TURN_CHANGED',
          'A user message changed during preparation. The draft was left untouched.',
        );
      }
    }
    if (previousView.busy) {
      return { ...previousView, outcome: 'pending', readiness: 'generating' };
    }
    checkBootstrapDraft(request, previousView, outgoingText);
    const composerField = findComposer();
    if (!composerField) {
      failOperation('COMPOSER_MISSING', 'ChatGPT’s composer is not ready. Check that you are signed in.');
    }
    if (hasImages && !composerField.closest('form')) {
      failOperation(
        'COMPOSER_MISSING',
        'ChatGPT’s image composer is not ready. Check that you are signed in.',
      );
    }
    const uploadInProgress = [...(preparedMessage?.imageUploads?.values() ?? [])].some(
      (entry) => !entry.confirmed,
    );
    checkComposerImages(composerField, messageId, imageAttachments, uploadInProgress);
    const draftText = normalizeMessageText(composerText(composerField));
    if (draftText && draftText !== normalizeMessageText(outgoingText)) {
      failOperation('DRAFT_CONFLICT', 'Your draft is safe. Send or move it before resuming Mitter.');
    }
    if (!draftText) {
      // An empty field AFTER a verified insertion could mean a manual send or
      // deletion. Never refill it merely because the echo is not visible yet.
      if (preparedMessage) {
        failOperation(
          'DRAFT_CHANGED',
          'The prepared draft was cleared. Checking it requires your review; nothing was inserted again.',
        );
      }
      composerField.focus();
      checkSession();
      if (composerField instanceof HTMLTextAreaElement) {
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (!valueSetter) {
          throw new TypeError('The native textarea value setter is unavailable.');
        }
        valueSetter.call(composerField, outgoingText);
        composerField.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composerField);
        selection?.removeAllRanges();
        selection?.addRange(range);
        if (!document.execCommand('insertText', false, outgoingText)) {
          failOperation('INSERT_REJECTED', 'ChatGPT did not accept the task text. Nothing was sent.');
        }
        composerField.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: outgoingText,
          }),
        );
      }
    }
    checkSession();
    if (!isExpectedURL()) {
      failOperation(
        'NAVIGATED',
        'The conversation changed during preparation. The draft was left untouched.',
      );
    }
    const freshComposer = findComposer();
    if (!freshComposer) {
      failOperation(
        'EDITOR_REPLACED',
        'ChatGPT replaced its editor while preparing the task. Your draft was left in place.',
      );
    }
    if (normalizeMessageText(composerText(freshComposer)) !== normalizeMessageText(outgoingText)) {
      failOperation('DRAFT_CHANGED', 'The draft changed before sending. Miter left it untouched.');
    }
    const observedView = await collectView();
    checkSession();
    if (!preparedMessage) {
      session.prepared = {
        id: messageId,
        text: outgoingText,
        renderedText: observedView.renderedDraftText,
        userCount: previousView.userCount,
        lastUserText: previousView.lastUserText,
        lastUserId: previousView.lastUserId,
        imageAttachments,
      };
    }
    if (!hasImages && !findSendControl(freshComposer)) {
      return {
        ...observedView,
        outcome: 'pending',
        readiness: 'send_not_ready',
      };
    }
    if (request.op === 'prepare') {
      return { ...observedView, outcome: 'prepared' };
    }
  }
  checkSession();
  const preparedMessage = session.prepared;
  if (
    !preparedMessage ||
    preparedMessage.id !== messageId ||
    preparedMessage.text !== outgoingText ||
    !sameImageAttachments(preparedMessage.imageAttachments, imageAttachments)
  ) {
    failOperation('NOT_PREPARED', 'The task was not prepared in this page. No send was attempted.');
  }
  const previousView = await collectView();
  checkSession();
  // If the user sent our prepared text themselves, observe it instead of clicking again.
  if (isPreparedMessageSent(previousView, preparedMessage)) {
    checkManualImageSend(preparedMessage);
    return { ...previousView, outcome: 'already_sent' };
  }
  if (preparedUserChanged(previousView, preparedMessage)) {
    failOperation(
      'USER_TURN_CHANGED',
      'The chat changed while the message was being prepared. The draft is safe; nothing was sent.',
    );
  }
  if (!isExpectedURL()) {
    failOperation('NAVIGATED', 'The conversation changed before sending. No send was attempted.');
  }
  if (previousView.busy) {
    return { ...previousView, outcome: 'pending', readiness: 'generating' };
  }
  checkBootstrapDraft(request, previousView, outgoingText);
  const composer = findComposer();
  if (!composer || normalizeMessageText(composerText(composer)) !== normalizeMessageText(outgoingText)) {
    failOperation('DRAFT_CHANGED', 'The draft changed before sending. Mitter did not click Send.');
  }
  if (request.op === 'attach_image') {
    if (!hasImages || !composer.closest('form')) {
      failOperation('INVALID_IMAGE', 'Miter could not find an image composer for this task.');
    }
    const outcome = attachComposerImage(request, preparedMessage, composer, checkSession);
    if (outcome === 'attached') {
      return { ...previousView, outcome };
    }
    return { ...previousView, outcome: 'pending', readiness: outcome };
  }
  const images = checkComposerImages(composer, messageId, imageAttachments);
  if (!images.complete) {
    if (images.images.length !== imageAttachments?.length) {
      failOperation(
        'IMAGE_DRAFT_CONFLICT',
        'The expected images changed before sending. Miter left the draft untouched.',
      );
    }
    return { ...previousView, outcome: 'pending', readiness: 'uploading_images' };
  }
  const sendButton = findSendControl(composer);
  if (!sendButton) {
    return { ...previousView, outcome: 'pending', readiness: 'send_not_ready' };
  }
  checkSession();
  session.committed.set(messageId, { text: outgoingText, time: Date.now(), imageAttachments });
  while (session.committed.size > 20) {
    const oldestId = session.committed.keys().next().value;
    if (oldestId === undefined) {
      break;
    }
    session.committed.delete(oldestId);
  }
  // Record before clicking, then return immediately. A navigation cannot cause a
  // second click. Observing the actual user message is the background's next step.
  sendButton.click();
  return { ...previousView, outcome: 'clicked' };
}
