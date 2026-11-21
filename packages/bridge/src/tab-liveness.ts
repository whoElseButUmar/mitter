import { z } from 'zod';
import { nonNegativeIntegerSchema } from './schemas/primitives.js';
import { PageBridgeError } from './page-transport.js';
import { isProviderOrigin } from './connections/providers.js';

export const TAB_LEASE_KEY = 'miter.chatTabLeases.v1';

export const tabStateSchema = z
  .object({
    id: nonNegativeIntegerSchema.optional().describe('The browser tab whose state is being checked.'),
    url: z.string().optional().describe('The address currently loaded in the tab.'),
    pendingUrl: z.string().optional().describe('The address the tab is navigating to, when provided.'),
    autoDiscardable: z
      .boolean()
      .optional()
      .describe('Whether Chrome is allowed to unload the tab when it needs memory.'),
    discarded: z.boolean().optional().describe('Whether Chrome has unloaded this tab to save memory.'),
    frozen: z.boolean().optional().describe('Whether Chrome has paused work in this tab.'),
  })
  .describe('Browser information used to check whether a chat tab can run.');
export type TabState = z.infer<typeof tabStateSchema>;

export const tabLeaseSchema = z
  .array(nonNegativeIntegerSchema)
  .max(256)
  .describe('Tab IDs whose unload policy Miter must restore after running tasks.');

type TabAPI = {
  get(tabId: number): Promise<unknown>;
  update(tabId: number, changes: { autoDiscardable: boolean }): Promise<unknown>;
};

type LeaseStorage = {
  get(key: string): Promise<unknown>;
  set(values: Record<string, unknown>): Promise<unknown>;
};

function hasSupportedOrigin(tab: TabState): boolean {
  return isProviderOrigin('chatgpt', tab.url || tab.pendingUrl || '');
}

const savedTabLeaseSchema = z
  .object({
    [TAB_LEASE_KEY]: tabLeaseSchema
      .optional()
      .describe('Owned tab-policy journal, absent when no recovery is pending.'),
  })
  .describe('Browser session storage containing the optional tab-policy recovery journal.');

function readTabState(value: unknown, expectedTabId?: number): TabState {
  const result = tabStateSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      'Chrome returned invalid chat-tab state. No tab policy was changed; recheck the linked tab.',
      {
        cause: result.error,
      },
    );
  }
  if (expectedTabId !== undefined && result.data.id !== undefined && result.data.id !== expectedTabId) {
    throw new Error('Chrome returned invalid chat-tab identity. No tab policy was changed.');
  }
  return result.data;
}

const isClosedTabError = (error: unknown) =>
  /No tab with id|Invalid tab ID|tab (?:was )?closed/i.test(String(error));

/** Resource policy only, never a grant to read/send. Protect only explicitly
 * running chats from automatic discarding, and restore their original policy.
 * A session-scoped journal permits cleanup after a worker restart; it does not
 * restart tasks. Chrome can still freeze a tab or the computer can sleep. */
export class ChatTabLiveness {
  private ownedTabIds = new Set<number>();
  private desiredTabIds = new Set<number>();
  private queueTail: Promise<void>;
  private inFlightSync: Promise<void> | undefined;
  private disposed = false;
  private recoveryFailed = false;
  readonly ready: Promise<void>;

  constructor(
    private tabs: TabAPI,
    private storage: LeaseStorage,
    private log: (kind: string, message: string) => void,
  ) {
    this.ready = this.restore();
    this.queueTail = this.ready.catch((error) => {
      this.recoveryFailed = true;
      this.log('bridge.tab.policy.error', String(error));
    });
  }

  private async persist() {
    await this.storage.set({
      [TAB_LEASE_KEY]: [...this.ownedTabIds].sort((left, right) => left - right),
    });
  }

  private async release(tabId: number): Promise<void> {
    try {
      const tab = readTabState(await this.tabs.get(tabId), tabId);
      if (tab.autoDiscardable === false) {
        await this.tabs.update(tabId, { autoDiscardable: true });
      }
    } catch (error) {
      if (!isClosedTabError(error)) {
        throw error;
      }
    }

    this.ownedTabIds.delete(tabId);
    await this.persist();
  }

  private async restore() {
    const saved = savedTabLeaseSchema.safeParse(await this.storage.get(TAB_LEASE_KEY));
    if (!saved.success) {
      throw new Error('Invalid saved chat-tab resource policy. No tab was changed.', { cause: saved.error });
    }
    const leases = saved.data[TAB_LEASE_KEY];
    if (leases === undefined) {
      return;
    }
    for (const tabId of leases) {
      this.ownedTabIds.add(tabId);
    }

    for (const tabId of [...this.ownedTabIds]) {
      await this.release(tabId);
    }
  }

  sync(tabIds: Iterable<number>): Promise<void> {
    let desiredTabIds: Set<number>;
    if (this.disposed) {
      desiredTabIds = new Set();
    } else {
      const validTabIds = [...tabIds].filter((tabId) => Number.isSafeInteger(tabId) && tabId >= 0);
      desiredTabIds = new Set(validTabIds);
    }
    const unchanged =
      desiredTabIds.size === this.desiredTabIds.size &&
      [...desiredTabIds].every((tabId) => this.desiredTabIds.has(tabId));
    this.desiredTabIds = desiredTabIds;

    // Repeated UI/status pulses must not create an unbounded promise queue
    // behind a slow browser-storage or tab update call.
    if (unchanged && this.inFlightSync) {
      return this.inFlightSync;
    }

    const syncOperation = this.queueTail.then(async () => {
      if (this.recoveryFailed) {
        throw new Error(
          'Saved chat-tab resource policy could not be recovered. No new tab policy was applied.',
        );
      }
      for (const tabId of [...this.ownedTabIds]) {
        if (!this.desiredTabIds.has(tabId)) {
          await this.release(tabId);
        }
      }

      for (const tabId of this.desiredTabIds) {
        if (this.ownedTabIds.has(tabId)) {
          continue;
        }

        let tab: TabState;
        try {
          tab = readTabState(await this.tabs.get(tabId), tabId);
        } catch (error) {
          if (isClosedTabError(error)) {
            continue;
          }
          throw error;
        }

        // False may belong to the user or another extension. Never claim it.
        if (
          this.disposed ||
          !this.desiredTabIds.has(tabId) ||
          !hasSupportedOrigin(tab) ||
          tab.autoDiscardable !== true
        ) {
          continue;
        }
        this.ownedTabIds.add(tabId);

        // Journal BEFORE update. A lost reply is still recoverable on restart.
        try {
          await this.persist();
        } catch (error) {
          this.ownedTabIds.delete(tabId);
          throw error;
        }
        if (this.disposed || !this.desiredTabIds.has(tabId)) {
          await this.release(tabId);
          continue;
        }
        try {
          await this.tabs.update(tabId, { autoDiscardable: false });
          this.log(
            'bridge.tab.protected',
            'Active chat tab ' + tabId + ' is protected from automatic discarding. Focus was not changed.',
          );
        } catch (error) {
          if (isClosedTabError(error)) {
            this.ownedTabIds.delete(tabId);
            await this.persist();
          } else {
            throw error;
          }
        }
      }
    });
    this.inFlightSync = syncOperation;
    this.queueTail = syncOperation
      .finally(() => {
        if (this.inFlightSync === syncOperation) {
          this.inFlightSync = undefined;
        }
      })
      .catch((error) => {
        this.log('bridge.tab.policy.error', String(error));
      });
    return syncOperation;
  }

  async releaseAll() {
    this.disposed = true;
    await this.sync([]);
  }
}

/** Do not inject into, reload, or focus a suspended document to disguise its
 * unavailability. The runner can wait safely and recheck when it resumes. */
export function assertChatTabAvailable(value: unknown): void {
  const tab = readTabState(value);
  if (tab.discarded) {
    throw new PageBridgeError(
      'TAB_DISCARDED',
      'Chrome unloaded the linked chat. Reopen that tab to restore its document; no prompt was resent.',
      true,
    );
  }
  if (tab.frozen) {
    throw new PageBridgeError(
      'TAB_FROZEN',
      'Chrome froze the linked chat. Waiting for it to resume without changing browser focus.',
      true,
    );
  }
}
