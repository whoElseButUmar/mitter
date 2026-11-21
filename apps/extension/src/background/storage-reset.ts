import { DATA_RESET_KEY } from '../../../../packages/bridge/src/data-reset.js';
import { pageReplySchema, PAGE_CHANNEL } from '../../../../packages/bridge/src/transport/messages.js';
import { z } from 'zod';
import { chatgptProvider } from '../../../../packages/bridge/src/connections/providers.js';
import { errorMessage } from '../schemas/primitives.js';

export const chatOrigins = chatgptProvider.origins.map((origin) => origin + '/*');
const clearAcknowledgementSchema = z
  .object({ cleared: z.literal(true) })
  .describe('The page endpoint retired itself and cleared its document-local state.');

export async function waitFor<Result>(
  promise: Promise<Result>,
  label: string,
  timeoutMs = 150000,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(label + ' did not stop. Reset remains locked; close it and retry.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function clearPageState(pageIds: Set<number>, forget: (tabId: number) => void): Promise<void> {
  const granted = await chrome.permissions.getAll();
  const pageOrigins = (granted.origins || []).filter((origin) => chatOrigins.includes(origin));

  if (pageOrigins.length) {
    for (const tab of await chrome.tabs.query({ url: pageOrigins })) {
      if (tab.id !== undefined) {
        pageIds.add(tab.id);
      }
    }
  }

  const failures: string[] = [];

  for (const tabId of pageIds) {
    try {
      const send = async () => {
        const id = crypto.randomUUID();
        const raw: unknown = await waitFor(
          chrome.tabs.sendMessage(
            tabId,
            {
              channel: PAGE_CHANNEL,
              kind: 'reset',
              id,
              confirmation: 'CLEAR',
            },
            { frameId: 0 },
          ),
          'Chat page ' + tabId,
          20000,
        );
        const reply = pageReplySchema.parse(raw);

        if (reply.id !== id) {
          throw new Error('The page data-clear acknowledgement belongs to another request.');
        }

        return reply;
      };

      let reply = await send();

      if (reply.error?.code === 'BAD_REQUEST') {
        const tab = await chrome.tabs.get(tabId);
        const url = new URL(tab.url || '');

        if (!chatOrigins.includes(url.origin + '/*')) {
          throw new Error('The old bridge moved to a different document.');
        }

        if (!(await chrome.permissions.contains({ origins: [url.origin + '/*'] }))) {
          throw new Error('The old bridge no longer has authorized origin access.');
        }

        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'ISOLATED',
          files: ['mitter-page.js'],
        });
        reply = await send();
      }

      if (!reply.ok || !clearAcknowledgementSchema.safeParse(reply.value).success) {
        throw new Error(reply.error?.message || 'No data-clear acknowledgement.');
      }

      forget(tabId);
    } catch (error) {
      const detail = errorMessage(error);

      if (!/Receiving end does not exist|No tab with id|Could not establish connection/i.test(detail)) {
        failures.push('Chat tab ' + tabId + ': ' + detail + ' Close or reload that tab, then retry.');
      }
    }
  }

  if (failures.length) {
    throw new Error(failures.join('\n'));
  }
}

/** Deletes only extension-scoped stores; never provider data, history, projects, or font settings. */
export async function clearBrowserData(): Promise<void> {
  const failures: string[] = [];
  const attempt = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(label + ': ' + errorMessage(error));
    }
  };

  for (const [name, area] of Object.entries({
    local: chrome.storage.local,
    session: chrome.storage.session,
    sync: chrome.storage.sync,
  })) {
    if (!area) {
      continue;
    }

    await attempt('chrome.storage.' + name, async () => {
      await area.clear();

      if (name === 'local') {
        await area.set({ [DATA_RESET_KEY]: true });
      }

      const remaining = Object.keys(await area.get(null)).filter(
        (key) => name !== 'local' || key !== DATA_RESET_KEY,
      );

      if (remaining.length) {
        throw new Error('Could not remove keys: ' + remaining.join(', '));
      }
    });
  }

  if (typeof caches !== 'undefined') {
    await attempt('Extension CacheStorage', async () => {
      for (const name of await caches.keys()) {
        if (!(await caches.delete(name))) {
          throw new Error('Could not delete cache ' + name);
        }
      }

      if ((await caches.keys()).length) {
        throw new Error('Caches remain after deletion.');
      }
    });
  }

  if (typeof indexedDB !== 'undefined') {
    await attempt('Extension IndexedDB', async () => {
      for (const database of await indexedDB.databases()) {
        const name = database.name;

        if (!name) {
          continue;
        }

        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          const timer = setTimeout(() => reject(new Error('Timed out deleting database ' + name)), 10000);
          const done = (error?: unknown): void => {
            clearTimeout(timer);

            if (error) {
              reject(error);
            } else {
              resolve();
            }
          };
          request.onsuccess = () => done();
          request.onerror = () => done(request.error);
          request.onblocked = () => done(new Error('Database is still open: ' + name));
        });
      }

      if ((await indexedDB.databases()).some((database) => database.name)) {
        throw new Error('Databases remain after deletion.');
      }
    });
  }

  if (chrome.notifications && (await chrome.permissions.contains({ permissions: ['notifications'] }))) {
    await attempt('Desktop notifications', async () => {
      for (const id of Object.keys(await chrome.notifications.getAll())) {
        await chrome.notifications.clear(id);
      }

      if (Object.keys(await chrome.notifications.getAll()).length) {
        throw new Error('Notifications remain.');
      }
    });
  }

  if (failures.length) {
    throw new Error(failures.join('\n'));
  }

  await attempt('Optional permissions', async () => {
    const granted = await chrome.permissions.getAll();
    const permissions = (granted.permissions || []).filter((permission) =>
      ['clipboardRead', 'notifications'].includes(permission),
    );
    const origins = (granted.origins || []).filter((origin) => chatOrigins.includes(origin));

    if (
      (permissions.length || origins.length) &&
      !(await chrome.permissions.remove({ permissions, origins }))
    ) {
      throw new Error('Optional permission removal was not confirmed.');
    }
  });

  if (failures.length) {
    throw new Error(failures.join('\n'));
  }
}
