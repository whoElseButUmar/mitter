import { recoverSentSource } from './sent-source.js';
import { clearStaleDraft } from './stale-draft.js';
import { matchesReceipt, parseReceipt } from '../message-wire.js';
import { chatgptAddress } from '../connections/chatgpt.js';
import { isProviderOrigin } from '../connections/providers.js';
import { readAssistantMessage } from './assistant-reader.js';
import { readCodeReply } from './code-replies.js';
import { findComposer, composerText, sendComposerMessage } from './composer-operations.js';
import { contentHidden, pageElements, generationActive, generationStopControls } from './page-elements.js';
import { hasStreamRetry } from './provider-activity.js';
import { discoverReceiptMessages } from './receipt-discovery.js';
import {
  forgetSentSource,
  getChatDomSession,
  resetChatDomSessions,
  type MessageReveal,
} from './session-state.js';
import {
  discoverMessages,
  messageRole,
  messageIdentity,
  resetMessageDiscoveryState,
} from './transcript-discovery.js';
import { messageDisclosure, readUserMessageVariants, countTaskTurns } from './user-reader.js';
import { PAGE_READER_REVISION, USER_READER_VERSION } from './types.js';
import type {
  AssistantReadResult,
  ChatView,
  CommittedMessage,
  CodeReplyScan,
  DisclosureObservation,
  DomRequest,
  MessageDiscovery,
  MessageDisclosure,
  ObservedTaskTurn,
  UserReadResult,
} from './types.js';

function failOperation(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function canonicalURL(rawURL: string): string {
  const url = new URL(rawURL);
  return url.origin + url.pathname.replace(/\/$/, '');
}

function isConversationURL(rawURL: string): boolean {
  return chatgptAddress(rawURL) !== undefined;
}

export async function chatDom(request: DomRequest): Promise<ChatView> {
  const emptyView = (): ChatView => ({
    readerRevision: PAGE_READER_REVISION,
    url: canonicalURL(location.href),
    count: 0,
    userCount: 0,
    lastRole: '',
    assistantId: '',
    assistantText: '',
    lastUserText: '',
    busy: false,
    complete: false,
    draft: false,
    draftText: '',
    stopped: true,
    ready: false,
  });
  if (request.op === 'interrupt') {
    // Only stop generation in this runner's exact linked document. A stale
    // token, ambiguous control or a navigated tab cannot affect another chat.
    if (
      getChatDomSession()?.token !== request.token ||
      canonicalURL(location.href) !== canonicalURL(request.url)
    ) {
      return { ...emptyView(), interruptOutcome: 'unavailable' };
    }
    const controls = generationStopControls();
    const control = controls[0];
    if (controls.length === 1 && control) {
      control.click();
      return { ...emptyView(), interruptOutcome: 'requested' };
    }
    if (controls.length) {
      return { ...emptyView(), interruptOutcome: 'unavailable' };
    }
    return { ...emptyView(), interruptOutcome: 'idle' };
  }
  if (request.op === 'stop') {
    const ownedSession = getChatDomSession();
    if (ownedSession && ownedSession.token === request.token) {
      ownedSession.stopped = true;
      document.getElementById('mitter-automation-control')?.remove();
    }
    return emptyView();
  }
  const currentURL = canonicalURL(location.href);
  const expectedURL = canonicalURL(request.url);
  // Inspection may observe the new conversation while its route is settling.
  // Preparing/committing text still requires exact URL equality below. A route
  // match alone never authorizes adopting or executing a reply: the runner must
  // prove the task's message/IDs. Probe is read-only and cannot adopt a session.
  const locationMatchesRequest = (): boolean => {
    const currentLocation = new URL(location.href);
    const requestedLocation = new URL(request.url);
    if (canonicalURL(location.href) === expectedURL) {
      return true;
    }
    const chatRoute =
      currentLocation.pathname === '/' ||
      /^\/(?:g\/[^/]+\/)?c(?:\/[^?#]*)?\/?$/.test(currentLocation.pathname);
    if (
      request.allowConversationBind === true &&
      currentLocation.origin === requestedLocation.origin &&
      chatRoute
    ) {
      return true;
    }
    // A reload of a saved /c URL can briefly display the root/loading shell.
    return (
      request.op === 'inspect' &&
      currentLocation.origin === requestedLocation.origin &&
      currentLocation.pathname === '/' &&
      isConversationURL(expectedURL)
    );
  };
  if (!isProviderOrigin('chatgpt', location.href)) {
    failOperation('UNSUPPORTED_ORIGIN', 'This page is not a supported ChatGPT page.');
  }
  if (!locationMatchesRequest()) {
    failOperation(
      'NAVIGATED',
      `The linked tab changed conversation. Expected ${expectedURL}; observed ${currentURL}. Nothing was sent.`,
    );
  }
  if (Date.now() > request.expiresAt) {
    failOperation('SESSION_EXPIRED', 'The automatic session has reached its time limit.');
  }
  if (request.op === 'control') {
    // Independent read-only Pause channel while a previously accepted local
    // batch runs. Never scan the transcript or create/replace a session here.
    const ownedSession = getChatDomSession();
    const sessionOwned = ownedSession?.token === request.token;
    return {
      ...emptyView(),
      stopped: sessionOwned && ownedSession?.stopped === true,
      ready: sessionOwned,
    };
  }
  if (request.op === 'reply') {
    const codeScan = readCodeReply(
      request.workerId || '',
      request.projectId || '',
      request.replyId,
      request.replyTo,
    );
    const composerField = pageElements().elements.find(
      (element) =>
        element.matches(
          '#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,[data-testid="composer-input"],form [contenteditable="true"][role="textbox"]',
        ) && !contentHidden(element),
    );
    const generating = generationActive();
    let draftText = '';
    if (composerField) {
      draftText = composerText(composerField);
    }
    return {
      ...emptyView(),
      stopped: false,
      ready: !!composerField,
      busy: generating,
      draft: !!draftText.trim(),
      draftText,
      codeRead: codeScan.read,
      codeReply: codeScan.reply,
      codeReplyIssue: codeScan.issue,
      codeReplyCount: codeScan.count,
      unlinkedReply: codeScan.unlinked,
      codeReplyIds: codeScan.ids,
      codeReplyTotal: codeScan.total,
    };
  }
  const existingSession = getChatDomSession();
  if (request.preservePause && existingSession?.stopped) {
    failOperation('STOPPED', 'Paused from the chat page.');
  }
  if (
    (request.op === 'clear_draft' || (request.op === 'commit' && request.composerSession !== undefined)) &&
    (!existingSession ||
      existingSession.token !== request.token ||
      existingSession.composerSession !== request.composerSession)
  ) {
    failOperation(
      'COMMIT_DOCUMENT_CHANGED',
      'The document that prepared this message is no longer available. Checking the sent message without clicking again.',
    );
  }
  if (request.op !== 'probe' && (!existingSession || existingSession.token !== request.token)) {
    if (existingSession) {
      existingSession.stopped = true;
    }
    // page-endpoint reads and replaces this exact plain object on reinjection.
    // Keep the global key, token, ledgers and object-identity retirement intact.
    globalThis.__mitterSessionV4 = {
      token: request.token,
      composerSession: crypto.randomUUID(),
      stopped: false,
      prepared: null,
      committed: new Map<string, CommittedMessage>(),
      reveals: new Map<string, MessageReveal>(),
    };
    document.getElementById('mitter-automation-control')?.remove();
    const host = document.createElement('div');
    host.id = 'mitter-automation-control';
    Object.assign(host.style, {
      position: 'fixed',
      bottom: '12px',
      left: '12px',
      zIndex: '2147483647',
    });
    const controlShadow = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    button.textContent = 'Miter is working · Pause';
    button.setAttribute('aria-label', 'Pause Miter');
    Object.assign(button.style, {
      font: '12px -apple-system, sans-serif',
      color: '#f3dbad',
      background: 'linear-gradient(#4c4942,#292825)',
      border: '1px solid #111',
      borderRadius: '4px',
      padding: '8px 12px',
      boxShadow: 'inset 0 1px #777, 0 2px 8px #0007',
      cursor: 'pointer',
    });
    button.onclick = () => {
      const currentSession = getChatDomSession();
      if (currentSession) {
        currentSession.stopped = true;
        button.textContent = 'Mitter stopped';
      }
    };
    controlShadow.append(button);
    document.documentElement.append(host);
  }
  let session = getChatDomSession();
  if (request.op === 'probe') {
    session = undefined;
  }
  const checkSession = (): void => {
    if (request.op !== 'probe' && (!session || session.stopped || getChatDomSession() !== session)) {
      failOperation('STOPPED', 'Stopped from the chat page.');
    }
    if (Date.now() > request.expiresAt) {
      failOperation('SESSION_EXPIRED', 'The automatic session expired.');
    }
    if (!locationMatchesRequest()) {
      failOperation('NAVIGATED', 'The chat changed before the operation finished.');
    }
  };
  // The fallback is bound to a saved send receipt, not global selectors or
  // arbitrary JSON on the page. Keep the prior verified receipt available while
  // preparing the next message; the new receipt arrives on the next inspect.
  const receivedReceipt = parseReceipt(request.receipt);
  if (request.op === 'inspect' && receivedReceipt && session) {
    session.discoveryReceipt = receivedReceipt;
  }
  let lastDiscovery: MessageDiscovery | undefined;
  const collectView = async (): Promise<ChatView> => {
    let discovery: MessageDiscovery = discoverMessages();
    const receipt = receivedReceipt || parseReceipt(session?.discoveryReceipt);
    let codeReplies: CodeReplyScan | undefined;
    if (request.workerId && request.projectId) {
      codeReplies = readCodeReply(request.workerId, request.projectId, request.replyId, request.replyTo);
    }
    // A pending nonce must not disable discovery of its own sent message.
    // Direct, correlated code remains the fast lane; otherwise independently
    // recover the FULL user receipt and its adjacent response. This lets us
    // distinguish a vanished response from an unconfirmed send in roleless UI.
    // Partially labelled transcripts still need this proof, even when a code
    // candidate exists: a nonce cannot erase an unknown or intervening turn.
    // The receipt fallback never promotes an unlinked code candidate.
    if (
      request.op !== 'probe' &&
      receipt &&
      !request.replyId &&
      !discovery.stats.scanLimited &&
      (discovery.stats.users === 0 ||
        discovery.stats.unclassifiedTail ||
        !!codeReplies?.read ||
        hasStreamRetry(document))
    ) {
      discovery = await discoverReceiptMessages(receipt, discovery, checkSession);
      checkSession();
    }
    const receiptDiscovery = discovery.stats.receiptDiscovery;
    const syntheticUser = discovery.messages.find((message) => messageRole(message) === 'user');
    if (
      request.replyTo &&
      request.replyTo === receipt?.exchangeId &&
      request.workerId &&
      request.projectId &&
      receiptDiscovery?.state === 'unknown_tail' &&
      receiptDiscovery.matches === 1 &&
      receiptDiscovery.tailBranches === 0 &&
      receiptDiscovery.responseControls === 0 &&
      !discovery.stats.scanLimited &&
      !discovery.replyRecovery &&
      discovery.userRead &&
      syntheticUser &&
      !syntheticUser.closest('blockquote')
    ) {
      // A failed climb from a receipt bubble is not a native user/unknown turn.
      // Refresh both structures after hashing yielded, preserving the existing
      // independent nonce lane only when no real transcript barrier is present.
      const native = discoverMessages();
      if (
        !native.stats.scanLimited &&
        native.messages.length === 0 &&
        native.stats.turnContainers === 0 &&
        native.stats.roleAttributes === 0 &&
        native.stats.alternativeRoles === 0 &&
        native.stats.semanticRoles === 0 &&
        !native.stats.unclassifiedTail
      ) {
        const currentCode = readCodeReply(
          request.workerId,
          request.projectId,
          request.replyId,
          request.replyTo,
        );
        if (
          currentCode.reply?.replyTo === request.replyTo &&
          currentCode.count === 1 &&
          currentCode.issue === undefined &&
          currentCode.read?.incomplete !== true
        ) {
          discovery = {
            messages: native.messages,
            stats: {
              ...native.stats,
              version: 'message-discovery/2',
              strategy: 'receipt',
              receiptDiscovery,
              codeAncestry: discovery.stats.codeAncestry,
            },
            userRead: discovery.userRead,
          };
          codeReplies = currentCode;
        }
      }
    }
    const ambiguousReceipt = discovery.stats.receiptDiscovery?.state === 'ambiguous';
    if (ambiguousReceipt) {
      // A valid old nonce cannot choose between repeated sends. Keep the
      // ambiguous exchange available only for a fresh-request correction.
      codeReplies = {
        ...codeReplies,
        count: 0,
        issue: 'DUPLICATE_SENT_RECEIPT',
        reply: undefined,
        unlinked: undefined,
      };
    }
    lastDiscovery = discovery;
    const messages = discovery.messages;
    const lastMessage = messages.at(-1);
    const users = messages.filter((element) => messageRole(element) === 'user');
    const lastUser = users.at(-1);
    let lastAssistant: HTMLElement | undefined;
    if (!ambiguousReceipt && messageRole(lastMessage) === 'assistant') {
      lastAssistant = lastMessage;
    }
    if (discovery.assistantRead && lastAssistant && request.workerId && request.projectId) {
      // Receipt discovery can identify a literal fenced response with no role
      // attributes. Include only that freshly verified root in the code scan;
      // old widget diagnostics must not obscure the current bounded payload.
      codeReplies = readCodeReply(
        request.workerId,
        request.projectId,
        request.replyId,
        request.replyTo,
        lastAssistant,
      );
    }
    let assistantBody = lastAssistant;
    const markdown = lastAssistant?.querySelector('.markdown');
    if (markdown instanceof HTMLElement) {
      assistantBody = markdown;
    }
    let assistantRead: AssistantReadResult = { text: '', format: 'plain' };
    if (discovery.assistantRead) {
      assistantRead = discovery.assistantRead;
    } else if (assistantBody) {
      assistantRead = readAssistantMessage(assistantBody);
    }
    const text = assistantRead.text;
    let userRead: UserReadResult | undefined = discovery.userRead;
    if (!userRead && lastUser) {
      userRead = readUserMessageVariants(lastUser);
    }
    const userText = userRead?.texts[0] || '';
    let disclosure: MessageDisclosure = { controls: [], collapsed: false };
    if (lastUser) {
      disclosure = messageDisclosure(lastUser, discovery.stats.strategy === 'receipt');
    }
    const userAlternatives = userRead?.texts.slice(1).filter((candidate) => candidate.length <= 160000);
    const generating = generationActive();
    const composer = findComposer();
    let draftText = '';
    if (composer) {
      draftText = composerText(composer).slice(0, 160001);
    }
    let disclosureState: DisclosureObservation['state'] = 'none';
    if (disclosure.collapsed) {
      disclosureState = 'unavailable';
      if (disclosure.controls.length === 1) {
        disclosureState = 'available';
      } else if (disclosure.controls.length > 1) {
        disclosureState = 'ambiguous';
      }
    }
    let observedTaskTurns: ObservedTaskTurn[] | undefined;
    if (request.includeHistory) {
      observedTaskTurns = countTaskTurns(users);
    }
    let renderedDraftText = '';
    if (composer instanceof HTMLTextAreaElement) {
      renderedDraftText = composer.value.slice(0, 160001);
    } else if (composer) {
      renderedDraftText = composer.innerText.slice(0, 160001);
    }
    let readiness = 'composer_missing';
    if (composer) {
      readiness = 'ready';
    } else if (document.readyState === 'loading') {
      readiness = 'loading';
    }
    return {
      composerSession: session?.composerSession,
      visibility: document.visibilityState,
      codeRead: codeReplies?.read,
      codeReply: codeReplies?.reply,
      codeReplyIssue: codeReplies?.issue,
      codeReplyCount: codeReplies?.count,
      unlinkedReply: codeReplies?.unlinked,
      codeReplyIds: codeReplies?.ids,
      codeReplyTotal: codeReplies?.total,
      readerRevision: PAGE_READER_REVISION,
      url: canonicalURL(location.href),
      count: messages.length,
      userCount: users.length,
      lastRole: messageRole(lastMessage),
      assistantId: messageIdentity(lastAssistant) || String(messages.length),
      assistantText: text.slice(0, 400001),
      assistantFormat: assistantRead.format,
      assistantReadIssue: assistantRead.issue,
      assistantReadStats: assistantRead.stats,
      lastUserText: userText.slice(0, 160001),
      lastUserCandidates: userAlternatives,
      lastUserId: messageIdentity(lastUser),
      userIds: users.map(messageIdentity).filter(Boolean).slice(-256),
      lastUserTruncated: userText.length > 160000,
      userReader: USER_READER_VERSION,
      lastUserCollapsed: disclosure.collapsed,
      disclosure: { state: disclosureState, attempts: 0 },
      lastUserReadStats: userRead?.stats,
      observedTaskTurns,
      busy: generating,
      complete: !!lastAssistant && !!text.trim() && !generating,
      draft: !!draftText.trim(),
      draftText,
      renderedDraftText,
      stopped: !!session?.stopped,
      transcript: discovery.stats,
      replyRecovery: discovery.replyRecovery,
      ready: !!composer,
      readiness,
    };
  };
  checkSession();
  if (request.op === 'probe') {
    return collectView(); // Probe is read-only, including disclosure UI.
  }
  if (request.op === 'inspect') {
    let view = await collectView();
    const receipt = parseReceipt(request.receipt);
    // Only expand the latest USER message of the explicitly connected task.
    // This reveals presentation; it does NOT send, acknowledge, import, accept
    // partial content, or touch an assistant's controls. Full receipt checks
    // still run in the coordinator after expansion (including after a restart).
    if (
      receipt &&
      !request.replyId &&
      view.lastUserCollapsed &&
      !view.draft &&
      (!request.replyTo || !!view.transcript?.users)
    ) {
      const variants = [view.lastUserText, ...(view.lastUserCandidates || [])];
      const receiptMatched = (
        await Promise.all(variants.map((candidate) => matchesReceipt(candidate, receipt)))
      ).some(Boolean);
      checkSession();
      if (!receiptMatched) {
        const lastUser = lastDiscovery?.messages.filter((element) => messageRole(element) === 'user').at(-1);
        const belongsToTask =
          !!lastUser &&
          ((!!receipt.acknowledgedUserId && messageIdentity(lastUser) === receipt.acknowledgedUserId) ||
            variants.some(
              (candidate) =>
                (!!receipt.exchangeId && candidate.includes(receipt.exchangeId)) ||
                candidate.includes('You are collaborating with Mitter,'),
            ));
        if (
          lastUser &&
          belongsToTask &&
          messageIdentity(lastUser) === (view.lastUserId || '') &&
          readUserMessageVariants(lastUser).texts[0] === view.lastUserText &&
          session
        ) {
          const currentDisclosure = messageDisclosure(lastUser, lastDiscovery?.stats.strategy === 'receipt');
          const identity =
            messageIdentity(lastUser) || receipt.messageId || receipt.exchangeId || receipt.textHash;
          const reveals = session.reveals ?? new Map<string, MessageReveal>();
          session.reveals = reveals;
          const previousRecord = reveals.get(identity);
          const control = currentDisclosure.controls[0];
          if (currentDisclosure.controls.length === 1 && control) {
            // One click per DOM control, at most three replacements. A slow
            // hydration must not toggle the same control closed again.
            if (
              (!previousRecord ||
                (previousRecord.control !== control &&
                  previousRecord.attempts < 3 &&
                  Date.now() - previousRecord.at >= 500)) &&
              control.isConnected &&
              !contentHidden(control)
            ) {
              checkSession();
              reveals.set(identity, {
                control,
                attempts: (previousRecord?.attempts ?? 0) + 1,
                at: Date.now(),
              });
              while (reveals.size > 24) {
                const oldestIdentity = reveals.keys().next().value;
                if (oldestIdentity === undefined) {
                  break;
                }
                reveals.delete(oldestIdentity);
              }
              control.click();
              // Return promptly: asynchronous content can finish on a later
              // read. Never block Stop or run a speculative second click.
              // No page timer: hidden tabs may defer it for a minute. The next
              // background inspection will observe asynchronous expansion.
              checkSession();
              view = await collectView();
              const revealed = reveals.get(identity);
              if (!revealed) {
                failOperation('STOPPED', 'Stopped from the chat page.');
              }
              let state: DisclosureObservation['state'] = 'expanded';
              if (view.lastUserCollapsed) {
                state = 'pending';
              }
              view.disclosure = { state, attempts: revealed.attempts };
            } else {
              view.disclosure = {
                state: 'pending',
                attempts: previousRecord?.attempts ?? 0,
              };
            }
          }
        }
      }
    }
    if (receipt && (await recoverSentSource(request, receipt, view, checkSession))) {
      view = await collectView();
      checkSession();
    }
    return view;
  }
  if (!session) {
    failOperation('STOPPED', 'Stopped from the chat page.');
  }
  if (request.op === 'clear_draft') {
    return clearStaleDraft(request, collectView, checkSession);
  }
  return sendComposerMessage(
    request,
    session,
    collectView,
    checkSession,
    () => canonicalURL(location.href) === expectedURL,
  );
}

/** Clear only Miter's isolated-world memory. Provider conversation/draft DOM is
 * user data and is never erased by a local application reset. */
export function clearChatDomState(): void {
  forgetSentSource();
  resetChatDomSessions();
  resetMessageDiscoveryState();
  document.getElementById('mitter-automation-control')?.remove();
}
