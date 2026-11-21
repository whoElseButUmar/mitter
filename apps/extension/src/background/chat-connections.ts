import { ChatLinkStore, type ChatLink } from '../../../../packages/bridge/src/chat-links.js';
import { chatStartURL, type BridgeStatus } from '../../../../packages/bridge/src/index.js';
import type { Snapshot } from '../../../../packages/protocol/src/index.js';
import type { NativeRPC } from '../transport/native-host.js';
import { bridgeLoadSchema } from '../schemas/host-results.js';
import { chatOrigins } from './storage-reset.js';
import {
  chatgptProvider,
  requireBrowserBridge,
} from '../../../../packages/bridge/src/connections/providers.js';

type ChatConnectionDependencies = {
  rpc: NativeRPC;
  snapshot(): Snapshot | undefined;
  sessions(): BridgeStatus[];
  log(kind: string, message: string): void;
};

export function chatChoice(
  tab: Pick<chrome.tabs.Tab, 'id' | 'url' | 'pendingUrl' | 'title'>,
): ChatLink | undefined {
  if (tab.id === undefined) {
    return;
  }

  try {
    const url = chatStartURL(tab.url || tab.pendingUrl || '', true);

    return {
      providerId: chatgptProvider.id,
      id: tab.id,
      url,
      title: (tab.title || 'New ChatGPT chat').slice(0, 200),
      newChat: chatgptProvider.origins.includes(url),
    };
  } catch {
    return;
  }
}

type ChatReservation = {
  workerId: string;
  conversationUrl: string | undefined;
};

function isSignInAddress(raw: string | undefined): boolean {
  // Chrome hides an external sign-in URL without broader host permissions.
  // Only a separately verified live task-tab binding may use this fallback.
  if (!raw) {
    return true;
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return false;
    }

    return (
      url.origin === 'https://auth.openai.com' ||
      (chatgptProvider.origins.includes(url.origin) && /^\/auth(?:\/|$)/.test(url.pathname))
    );
  } catch {
    return false;
  }
}

/** Saved destinations and temporary tab reservations; no active-tab fallback for a running task. */
export class ChatConnections {
  readonly links: ChatLinkStore;
  private createdTabs = new Map<number, string>();
  private reservations = new Map<number, ChatReservation>();

  constructor(private dependencies: ChatConnectionDependencies) {
    this.links = new ChatLinkStore(
      chrome.storage.local ?? chrome.storage.session,
      chrome.storage.session,
      (message) => dependencies.log('bridge.storage.error', message),
    );
  }

  reserve(workerId: string, selected: ChatLink): void {
    requireBrowserBridge(selected.providerId);
    const url = chatStartURL(selected.url, true);
    let conversationUrl: string | undefined;

    if (url.includes('/c/')) {
      conversationUrl = url;
    }

    const otherReservation = [...this.reservations].some(
      ([tabId, reservation]) =>
        reservation.workerId !== workerId &&
        (tabId === selected.id ||
          (conversationUrl !== undefined && reservation.conversationUrl === conversationUrl)),
    );
    const otherSession = this.dependencies
      .sessions()
      .some(
        (status) =>
          (status.active || status.monitoring) &&
          status.workerId !== workerId &&
          (status.tabId === selected.id || (conversationUrl !== undefined && status.url === conversationUrl)),
      );

    if (otherReservation || otherSession) {
      throw new Error('Another task is already using that chat. Choose a separate chat.');
    }

    this.reservations.set(selected.id, { workerId, conversationUrl });
  }

  release(workerId: string, tabId: number): void {
    if (this.reservations.get(tabId)?.workerId === workerId) {
      this.reservations.delete(tabId);
    }
  }

  isCreatedTab(workerId: string, tabId: number): boolean {
    return this.createdTabs.get(tabId) === workerId;
  }

  canBootstrap(workerId: string, tabId: number, origin: string): boolean {
    if (!this.isCreatedTab(workerId, tabId)) {
      return true;
    }
    // New tabs on the provider root can mirror the same composer. Once an
    // earlier runner verifies its own conversation URL it no longer competes.
    const first = this.dependencies
      .sessions()
      .find(
        (session) =>
          session.active &&
          session.bindingPending &&
          session.url === origin &&
          this.isCreatedTab(session.workerId, session.tabId),
      );
    return !first || first.workerId === workerId;
  }

  forgetCreatedTab(tabId: number): void {
    this.createdTabs.delete(tabId);
  }

  clearReservations(): void {
    this.createdTabs.clear();
    this.reservations.clear();
  }

  /** Focus-only recovery. This target is never an automation-ready ChatLink. */
  async signInTab(workerId: string, check: () => void): Promise<number | undefined> {
    check();
    await this.links.ready;
    check();
    const link = this.links.get(workerId);
    const worker = this.dependencies.snapshot()?.workers.find((worker) => worker.id === workerId);

    if (!link || !worker || link.projectId !== worker.projectId) {
      return;
    }

    const ownsTab = () => {
      const current = this.links.get(workerId);
      const task = this.dependencies.snapshot()?.workers.find((task) => task.id === workerId);
      const sessions = this.dependencies.sessions();
      const reservation = this.reservations.get(link.id);

      return (
        current?.id === link.id &&
        current.url === link.url &&
        current.projectId === worker.projectId &&
        task?.projectId === worker.projectId &&
        task.runId === worker.runId &&
        (task.control?.epoch ?? 0) === (worker.control?.epoch ?? 0) &&
        (!reservation || reservation.workerId === workerId) &&
        sessions.some((session) => session.workerId === workerId && session.tabId === link.id) &&
        !sessions.some((session) => session.workerId !== workerId && session.tabId === link.id)
      );
    };

    if (!ownsTab()) {
      return;
    }

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(link.id);
    } catch {
      check();
      return;
    }

    check();
    if (!ownsTab()) {
      throw new Error('The task’s chat changed. Open its current chat again.');
    }

    if (tab.id === link.id && isSignInAddress(tab.pendingUrl || tab.url)) {
      return link.id;
    }

    return undefined;
  }

  /** A browser restart assigns new tab IDs. Include pending navigations so a
   * restoring tab counts even before its first document has loaded. */
  async openReplyTabs(link: ChatLink): Promise<chrome.tabs.Tab[]> {
    const matches = (tab: chrome.tabs.Tab): boolean =>
      chatChoice({ id: tab.id, url: tab.pendingUrl || tab.url })?.url === link.url;
    const original = await chrome.tabs.get(link.id).catch(() => undefined);
    if (original && matches(original)) {
      return [original];
    }
    return (await chrome.tabs.query({})).filter(matches);
  }

  async saved(
    workerId: string,
    reopen = false,
    check: () => void = () => {},
    expectedConversation?: string,
  ): Promise<ChatLink | undefined> {
    check();
    await this.links.ready;
    check();
    const original = this.links.get(workerId);

    if (!original) {
      return;
    }

    let link = original;

    if (expectedConversation !== undefined) {
      const destination = chatStartURL(expectedConversation);

      if (!link.newChat && !link.bindingPending && chatStartURL(link.url) !== destination) {
        throw new Error(
          'The saved chat link does not match this task’s recorded conversation. Review its saved chat before continuing; no local work was started.',
        );
      }

      link = { ...link, url: destination, newChat: false, bindingPending: false };
    } else if (link.newChat || link.bindingPending) {
      const saved = await this.dependencies.rpc('worker.bridgeLoad', { workerId }, bridgeLoadSchema);
      check();

      if (saved.progress?.conversationUrl) {
        link = { ...link, url: saved.progress.conversationUrl, newChat: false, bindingPending: false };
      }
    }

    const worker = this.dependencies.snapshot()?.workers.find((worker) => worker.id === workerId);

    if (link.projectId && worker && link.projectId !== worker.projectId) {
      return;
    }

    try {
      const tab = await chrome.tabs.get(link.id);
      check();
      const current = chatChoice(tab);

      if (current && (current.url === link.url || (link.newChat && !current.newChat))) {
        return { ...link, ...current };
      }

      // Retain the known first-send tab while ChatGPT assigns its conversation URL.
      if (link.newChat && link.lastReceipt) {
        const url = new URL(tab.url || tab.pendingUrl || '');

        if (chatOrigins.includes(url.origin + '/*') && /^\/c\/local-chatgpt(?::|%3A)/i.test(url.pathname)) {
          return {
            ...link,
            url: url.origin,
            newChat: true,
            bindingPending: true,
          };
        }
      }
    } catch (error) {
      check();
      console.warn('Miter could not read the saved chat tab; falling back to a conversation search.', error);
    }

    // Browser restarts change tab IDs. Match only the saved conversation, never the first open chat.
    if (!link.newChat) {
      const tabs = await chrome.tabs.query({ url: chatOrigins });
      check();
      const open = tabs.map(chatChoice).find((candidate) => candidate?.url === link.url);

      if (open) {
        return { ...link, ...open };
      }

      if (reopen) {
        const tab = await chrome.tabs.create({ url: link.url, active: true });
        check();

        if (tab.id === undefined) {
          throw new Error('Chrome could not reopen the saved conversation.');
        }

        return { ...link, id: tab.id };
      }
    }

    return undefined;
  }

  async fresh(workerId: string, check: () => void = () => {}): Promise<ChatLink> {
    check();
    const tab = await chrome.tabs.create({
      url: chatgptProvider.startUrl + '/',
      active: false,
    });
    check();

    if (tab.id === undefined) {
      throw new Error('Chrome could not open a chat.');
    }

    this.createdTabs.set(tab.id, workerId);
    while (this.createdTabs.size > 64) {
      const oldest = this.createdTabs.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.createdTabs.delete(oldest);
    }
    this.reservations.set(tab.id, { workerId, conversationUrl: undefined });
    this.dependencies.log(
      'bridge.newChat',
      'Created task tab ' + tab.id + ' for ' + workerId.slice(0, 8) + '.',
    );
    return {
      providerId: chatgptProvider.id,
      id: tab.id,
      url: chatgptProvider.startUrl,
      title: 'New ChatGPT chat',
      newChat: true,
      bindingPending: true,
    };
  }
}
