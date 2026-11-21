import { z } from 'zod';
import { documentURL, timestampSchema } from './schemas/primitives.js';

const key = 'miter.reopenWorkspace';
const reloadRequest = z
  .object({
    windowId: z.int().nonnegative().describe('The Chrome window where the user requested the reload.'),
    requestedAt: timestampSchema,
  })
  .describe('A one-use request to reopen the workspace after reloading the extension.');

export async function reloadWorkspace(): Promise<void> {
  try {
    const window = await chrome.windows.getCurrent();
    if (window.id !== undefined && window.id >= 0) {
      await chrome.storage.local.set({ [key]: { windowId: window.id, requestedAt: Date.now() } });
    }
  } catch {
    // Reload can still repair the connection if window or storage access fails.
  }
  chrome.runtime.reload();
}

export async function restoreReloadedWorkspace(disposed: () => boolean): Promise<void> {
  const stored = await chrome.storage.local.get(key);
  if (disposed() || stored[key] === undefined) {
    return;
  }

  await chrome.storage.local.remove(key);
  const request = reloadRequest.safeParse(stored[key]);
  if (!request.success || disposed()) {
    return;
  }
  const { windowId, requestedAt } = request.data;
  const age = Date.now() - requestedAt;
  if (age < 0 || age > 60_000) {
    return;
  }

  const url = chrome.runtime.getURL('workspace.html');
  const contexts = await chrome.runtime.getContexts({ windowIds: [windowId] });
  if (disposed()) {
    return;
  }
  const workspace = contexts.find(
    (context) => context.contextType === 'TAB' && documentURL(context.documentUrl || '') === url,
  );
  if (workspace) {
    await chrome.tabs.update(workspace.tabId, { active: true });
  } else {
    await chrome.tabs.create({ windowId, url, active: true });
  }
}
