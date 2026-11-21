import { addDisclosureMarkers } from '../../ui/src/icons.js';
import { requiredElement } from './sheets/required-element.js';
import { z } from 'zod';
import { chatLinkSchema } from './chat-links.js';
import { enhanceSelects } from '../../ui/src/select.js';
import { startSheetTemplate } from './sheets/start-template.js';

/** The start sheet uses native DOM controls. Solid owns its mount/lifetime.
 * Keeping this small surface framework-independent also lets browser tests run
 * the exact production interactions without a second mock UI implementation.
 */
export const chatChoiceSchema = chatLinkSchema
  .pick({ id: true, title: true, url: true, providerId: true })
  .extend({
    title: z.string().describe('The conversation name shown in the chat picker.'),
    newChat: z.boolean().optional().describe('Whether this chat is a new conversation.'),
  })
  .describe('A chat the user can choose for this task.');
export type ChatChoice = z.infer<typeof chatChoiceSchema>;

const chatInventorySchema = z
  .array(chatChoiceSchema)
  .describe('Open supported chat tabs available in the picker.');
const rememberedChatSchema = chatChoiceSchema
  .nullable()
  .describe('This task’s last chat, or explicit null when none is saved.');

export type StartSheetDependencies = {
  authorize(): Promise<boolean>;
  lastChat(): Promise<unknown>;
  loadChats(): Promise<unknown>;
  start(options: {
    consent: true;
    newChat: boolean;
    tabId?: number;
    maxTurns: number;
    maxMinutes: number;
  }): Promise<unknown>;
  stop(): Promise<unknown>;
  close(): void;
  started(): void;
};

export function mountStartSheet(root: HTMLElement, deps: StartSheetDependencies): () => void {
  root.innerHTML = startSheetTemplate;
  addDisclosureMarkers(root);

  const startButton = requiredElement(root, '[data-start]', HTMLButtonElement);
  const cancelButton = requiredElement(root, '[data-cancel]', HTMLButtonElement);
  const findButton = requiredElement(root, '[data-find]', HTMLButtonElement);
  const chatSelect = requiredElement(root, '[data-chat]', HTMLSelectElement);
  const turnLimitSelect = requiredElement(root, '[data-turns]', HTMLSelectElement);
  const timeLimitSelect = requiredElement(root, '[data-minutes]', HTMLSelectElement);
  const errorMessage = requiredElement(root, '[data-error]', HTMLParagraphElement);
  const destinationLabel = requiredElement(root, '[data-destination]', HTMLElement);
  const destinationHint = requiredElement(root, '[data-destination-hint]', HTMLElement);
  const chatsByTabId = new Map<number, ChatChoice>();
  const selects = enhanceSelects(root);

  let alive = true;
  let busy = false;
  let chosenByUser = false;
  let startRequested = false;

  function showError(error: unknown) {
    if (!alive) {
      return;
    }

    if (error instanceof Error) {
      errorMessage.textContent = error.message;
    } else {
      errorMessage.textContent = String(error);
    }
    errorMessage.hidden = false;
  }

  function startButtonLabel() {
    if (chatSelect.value === 'new') {
      return 'Start task';
    }
    return 'Resume task';
  }

  function renderDestination() {
    const titleCounts = new Map<string, number>();
    const titlePositions = new Map<string, number>();
    for (const chat of chatsByTabId.values()) {
      const title = chat.title || 'Untitled chat';
      titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
    }
    for (const option of Array.from(chatSelect.options)) {
      const chat = chatsByTabId.get(Number(option.value));
      if (!chat) {
        continue;
      }
      const title = chat.title || 'Untitled chat';
      const position = (titlePositions.get(title) || 0) + 1;
      titlePositions.set(title, position);
      option.textContent = title;
      if ((titleCounts.get(title) || 0) > 1) {
        option.textContent += ` (chat ${position})`;
      }
    }
    const selectedChat = chatsByTabId.get(Number(chatSelect.value));
    if (selectedChat) {
      destinationLabel.textContent = 'Existing ChatGPT chat';
      destinationHint.textContent = selectedChat.title || 'Untitled chat';
    } else {
      destinationLabel.textContent = 'New ChatGPT chat';
      destinationHint.textContent = 'A separate conversation for this task.';
    }

    startButton.textContent = startButtonLabel();
    selects.refresh();
  }

  function addChatOption(chat: ChatChoice) {
    chatsByTabId.set(chat.id, chat);
    let option = Array.from(chatSelect.options).find((option) => option.value === String(chat.id));
    if (!option) {
      option = document.createElement('option');
      option.value = String(chat.id);
      chatSelect.add(option);
    }

    option.textContent = chat.title || 'Untitled chat';
  }

  function setBusy(value: boolean) {
    busy = value;
    startButton.disabled = value || startRequested;
    findButton.disabled = value || startRequested;
    chatSelect.disabled = value || startRequested;
    turnLimitSelect.disabled = value || startRequested;
    timeLimitSelect.disabled = value || startRequested;

    if (!value) {
      startButton.textContent = startButtonLabel();
    }
    selects.refresh();
  }

  async function findOpenChats() {
    if (!alive || busy || startRequested) {
      return;
    }

    setBusy(true);
    errorMessage.hidden = true;
    findButton.textContent = 'Finding chats…';

    try {
      if (!(await deps.authorize())) {
        throw new Error('ChatGPT access was not granted. Nothing was sent.');
      }
      if (!alive) {
        return;
      }

      const response = await deps.loadChats();
      if (!alive) {
        return;
      }
      const parsed = chatInventorySchema.safeParse(response);
      if (!parsed.success) {
        throw new Error('The browser returned an invalid chat list. Refresh open chats before starting.', {
          cause: parsed.error,
        });
      }
      const chats = parsed.data;

      const previousSelection = chatSelect.value;
      for (const option of Array.from(chatSelect.options)) {
        if (option.value !== 'new') {
          option.remove();
        }
      }
      chatsByTabId.clear();
      chats.forEach(addChatOption);
      const selectionStillAvailable =
        previousSelection === 'new' || chats.some((chat) => String(chat.id) === previousSelection);
      if (selectionStillAvailable) {
        chatSelect.value = previousSelection;
      } else {
        chatSelect.value = 'new';
      }
      if (!chats.length) {
        showError(new Error('No open chat found. Use a new chat instead.'));
      }
      renderDestination();
    } catch (error) {
      showError(error);
    } finally {
      if (alive) {
        setBusy(false);
        findButton.textContent = 'Refresh open chats';
      }
    }
  }

  async function startTask() {
    if (!alive || busy || startRequested) {
      return;
    }

    const selectedChat = chatsByTabId.get(Number(chatSelect.value));
    const options: Parameters<StartSheetDependencies['start']>[0] = {
      consent: true,
      newChat: !selectedChat || selectedChat.newChat === true,
      maxTurns: Number(turnLimitSelect.value),
      maxMinutes: Number(timeLimitSelect.value),
    };
    if (selectedChat) {
      options.tabId = selectedChat.id;
    }

    setBusy(true);
    chosenByUser = true;
    errorMessage.hidden = true;
    startButton.textContent = 'Starting…';

    try {
      // This permission request runs directly from the user's Start click.
      if (!(await deps.authorize())) {
        throw new Error('ChatGPT access was not granted. Nothing was sent.');
      }
      if (!alive) {
        return;
      }

      // Once submitted, an error may follow a successful admission. Check the
      // task's current state before another start; this sheet never resends it.
      startRequested = true;
      await deps.start(options);
      if (!alive) {
        await deps.stop().catch(() => {});
        return;
      }

      deps.started();
      deps.close();
    } catch (error) {
      showError(error);
      if (alive && startRequested) {
        errorMessage.textContent +=
          ' Start could not be confirmed. Go back to the task to check its status before trying again.';
        startButton.hidden = true;
        cancelButton.textContent = 'Back to task';
        cancelButton.focus();
      }
    } finally {
      if (alive) {
        setBusy(false);
      }
    }
  }

  function restoreLastChat(response: unknown) {
    if (!alive || chosenByUser || busy) {
      return;
    }
    const parsed = rememberedChatSchema.safeParse(response);
    if (!parsed.success) {
      showError(
        new Error('The saved chat is invalid. Choose a new chat or refresh open chats.', {
          cause: parsed.error,
        }),
      );
      return;
    }
    const chat = parsed.data;
    if (chat === null) {
      return;
    }
    addChatOption(chat);
    chatSelect.value = String(chat.id);
    renderDestination();
  }

  chatSelect.addEventListener('change', () => {
    chosenByUser = true;
    renderDestination();
  });
  cancelButton.addEventListener('click', () => deps.close());
  findButton.addEventListener('click', findOpenChats);
  startButton.addEventListener('click', startTask);

  // Remember this task's chat without selecting an unrelated tab or asking for
  // permission on mount. Closing the sheet cancels pending continuations.
  void deps
    .lastChat()
    .then(restoreLastChat)
    .catch(() => {});

  return function disposeStartSheet() {
    alive = false;
    selects.dispose();
    root.replaceChildren();
  };
}
