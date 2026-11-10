import { ChatLinkStore, type ChatLink } from '../../../../packages/bridge/src/chat-links.js';
import { chatStartURL, type BridgeStatus } from '../../../../packages/bridge/src/index.js';
import type { Snapshot } from '../../../../packages/protocol/src/index.js';
import type { PageTransport } from '../../../../packages/bridge/src/page-transport.js';
import type { NativeRPC } from '../transport/native-host.js';
import { bridgeLoadSchema } from '../schemas/host-results.js';
import { errorMessage } from '../schemas/primitives.js';
import { chatOrigins } from './storage-reset.js';

type ChatConnectionDependencies = {
  rpc: NativeRPC;
  page: PageTransport;
  snapshot(): Snapshot | undefined;
  sessions(): BridgeStatus[];
  rewriteTabs(): number[];
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
      id: tab.id,
      url,
      title: (tab.title || 'New ChatGPT chat').slice(0, 200),
      newChat: /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)$/.test(url),
    };
  } catch {
    return;
  }
}

type ChatReservation = {
  workerId: string;
  conversationUrl: string | undefined;
};

/** Saved destinations and temporary tab reservations; no active-tab fallback for a running task. */
export class ChatConnections {
  readonly links: ChatLinkStore;
  private reservations = new Map<number, ChatReservation>();

  constructor(private dependencies: ChatConnectionDependencies) {
    this.links = new ChatLinkStore(
      chrome.storage.local ?? chrome.storage.session,
      chrome.storage.session,
      (message) => dependencies.log('bridge.storage.error', message),
    );
  }

  reserve(workerId: string, selected: ChatLink): void {
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

  clearReservations(): void {
    this.reservations.clear();
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
    const active = (
      await chrome.tabs.query({
        active: true,
        currentWindow: true,
        url: chatOrigins,
      })
    )
      .map(chatChoice)
      .find((candidate): candidate is ChatLink => candidate !== undefined);
    check();

    if (active) {
      const claimed =
        this.dependencies.rewriteTabs().includes(active.id) ||
        [...this.reservations].some(
          ([tabId, reservation]) =>
            tabId === active.id ||
            (reservation.conversationUrl !== undefined && reservation.conversationUrl === active.url),
        ) ||
        this.dependencies
          .sessions()
          .some((status) => (status.active || status.monitoring) && status.tabId === active.id) ||
        this.links
          .entries()
          .some(
            ([id, link]) =>
              id !== workerId && (link.id === active.id || (!active.newChat && link.url === active.url)),
          );

      if (!claimed) {
        this.reserve(workerId, active);
        let retained = false;

        try {
          const view = await this.dependencies.page.request(active.id, {
            op: 'probe',
            token: crypto.randomUUID(),
            url: active.url,
            expiresAt: Date.now() + 12000,
          });
          const current = chatChoice(await chrome.tabs.get(active.id));
          check();

          if (
            current?.url === active.url &&
            view.url === active.url &&
            view.ready &&
            !view.draft &&
            !view.busy
          ) {
            if (
              active.newChat &&
              view.count === 0 &&
              (!view.transcript || view.transcript.state === 'empty')
            ) {
              retained = true;
              this.dependencies.log(
                'bridge.reuse',
                'Using the empty ChatGPT tab ' + active.id + ' for ' + workerId.slice(0, 8) + '.',
              );
              return { ...active, bindingPending: true };
            }

            if (!active.newChat && (!view.transcript || view.transcript.state === 'ready')) {
              // Normal navigation preserves the unclaimed conversation in history and Back.
              await chrome.tabs.update(active.id, {
                url: 'https://chatgpt.com/',
                active: true,
              });
              this.dependencies.page.forget(active.id);
              retained = true;
              this.dependencies.log(
                'bridge.newChat',
                'Opened a fresh conversation in the current unclaimed tab ' + active.id + '.',
              );
              return {
                id: active.id,
                url: 'https://chatgpt.com',
                title: 'New ChatGPT chat',
                newChat: true,
                bindingPending: true,
              };
            }
          }

          this.dependencies.log(
            'bridge.keepTab',
            'Left the current chat untouched because it is busy, has a draft, or is not ready.',
          );
        } catch (error) {
          this.dependencies.log(
            'bridge.keepTab',
            'Could not safely reuse the current chat. Opening a separate task tab. ' + errorMessage(error),
          );
        } finally {
          if (!retained) {
            this.release(workerId, active.id);
          }
        }
      } else {
        this.dependencies.log(
          'bridge.keepTab',
          'The current chat belongs to another task. Keeping its connection intact.',
        );
      }
    }

    check();
    const tab = await chrome.tabs.create({
      url: 'https://chatgpt.com/',
      active: true,
    });
    check();

    if (tab.id === undefined) {
      throw new Error('Chrome could not open a chat.');
    }

    this.reservations.set(tab.id, { workerId, conversationUrl: undefined });
    this.dependencies.log(
      'bridge.newChat',
      'Created task tab ' + tab.id + ' for ' + workerId.slice(0, 8) + '.',
    );
    return {
      id: tab.id,
      url: 'https://chatgpt.com',
      title: 'New ChatGPT chat',
      newChat: true,
      bindingPending: true,
    };
  }
}
