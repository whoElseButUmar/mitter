import { createSignal, onCleanup, onMount } from 'solid-js';
import { z } from 'zod';
import { documentURL, errorMessage } from '../schemas/primitives';

const tabIdSchema = z.int().nonnegative().describe('The Chrome tab hosting the full Miter workspace.');

export function createWorkspaceHandoff(enabled: boolean, notice: (message: string) => void) {
  const [externalTab, setExternalTab] = createSignal<number>();
  const [opening, setOpening] = createSignal(false);
  let windowId: number | undefined;
  let alive = true;

  const storageKey = () => 'miter.workspaceHandoff.' + windowId;
  const workspaceURL = () => chrome.runtime.getURL('workspace.html');

  async function workspaceTabs() {
    const contexts = await chrome.runtime.getContexts({ windowIds: [windowId ?? -1] });
    return contexts.filter(
      (context) => context.contextType === 'TAB' && documentURL(context.documentUrl || '') === workspaceURL(),
    );
  }

  function openHere() {
    setExternalTab(undefined);
    if (windowId !== undefined) {
      void chrome.storage.session.remove(storageKey()).catch(() => {});
    }
  }

  function closed(tabId: number) {
    if (tabId === externalTab()) {
      openHere();
    }
  }

  function updated(tabId: number, change: chrome.tabs.OnUpdatedInfo) {
    if (tabId !== externalTab() || change.status !== 'complete') {
      return;
    }
    void workspaceTabs()
      .then((tabs) => {
        if (alive && externalTab() === tabId && !tabs.some((tab) => tab.tabId === tabId)) {
          openHere();
        }
      })
      .catch(() => {});
  }

  onMount(() => {
    if (!enabled) {
      return;
    }
    chrome.tabs.onRemoved.addListener(closed);
    chrome.tabs.onDetached.addListener(closed);
    chrome.tabs.onUpdated.addListener(updated);
    void (async () => {
      windowId = (await chrome.windows.getCurrent()).id;
      if (!alive || windowId === undefined) {
        return;
      }
      const key = storageKey();
      const saved = tabIdSchema.safeParse((await chrome.storage.session.get(key))[key]);
      if (
        saved.success &&
        (await workspaceTabs()).some((tab) => tab.tabId === saved.data) &&
        alive &&
        !opening()
      ) {
        setExternalTab(saved.data);
      }
    })().catch(() => {});
    onCleanup(() => {
      alive = false;
      chrome.tabs.onRemoved.removeListener(closed);
      chrome.tabs.onDetached.removeListener(closed);
      chrome.tabs.onUpdated.removeListener(updated);
    });
  });

  async function openWorkspace() {
    if (opening()) {
      return;
    }
    setOpening(true);
    try {
      windowId ??= (await chrome.windows.getCurrent()).id;
      if (windowId === undefined) {
        throw new Error('The Chrome window is unavailable.');
      }
      const existing = (await workspaceTabs()).find((tab) => tab.tabId >= 0);
      let tabId = existing?.tabId;
      if (tabId === undefined) {
        tabId = (await chrome.tabs.create({ windowId, url: workspaceURL() })).id;
      } else {
        await chrome.tabs.update(tabId, { active: true });
      }
      if (tabId === undefined) {
        throw new Error('Chrome did not open a workspace tab.');
      }
      if (alive) {
        setExternalTab(tabId);
      }
      await chrome.storage.session.set({ [storageKey()]: tabId }).catch(() => {});
    } catch (error) {
      if (alive) {
        notice(errorMessage(error));
      }
    } finally {
      setOpening(false);
    }
  }

  async function takeMeThere() {
    const tabId = externalTab();
    if (tabId === undefined || windowId === undefined) {
      return;
    }
    try {
      const tabs = await workspaceTabs();
      if (!tabs.some((tab) => tab.tabId === tabId) && (await chrome.tabs.get(tabId)).status !== 'loading') {
        throw new Error('The workspace tab is unavailable.');
      }
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(windowId, { focused: true });
    } catch (error) {
      if (alive) {
        openHere();
        notice(errorMessage(error));
      }
    }
  }

  return { externalTab, opening, openWorkspace, openHere, takeMeThere };
}
