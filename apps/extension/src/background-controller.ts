import { APP_VERSION } from '../../../packages/protocol/src/index.js';
import {
  DataResetCoordinator,
  resetPreparationSchema,
  resetCleanupResultSchema,
  resetCompletionSchema,
} from '../../../packages/bridge/src/data-reset.js';
import { Diagnostics } from '../../../packages/bridge/src/diagnostics.js';
import { NativeHost, type NativeRPC } from './transport/native-host.js';
import { TaskNotifications } from './background/notifications.js';
import { createTaskController } from './background/task-controller.js';
import { TerminalControl } from './background/terminal-control.js';
import { ViewConnections } from './background/view-connections.js';
import { clearBrowserData, clearPageState, waitFor } from './background/storage-reset.js';
import { restoreReloadedWorkspace } from './workspace-reload.js';
import { errorMessage } from './schemas/primitives.js';

/** One host and one coordinator shared by authenticated views. Page scripts cannot call host RPC. */
export function startBackground() {
  let reset: DataResetCoordinator | undefined;
  let lastEvent = 0;
  let announced = false;
  let disposed = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const pageIds = new Set<number>();
  const blocked = () => reset?.blocked ?? false;
  const getReset = (): DataResetCoordinator => {
    if (!reset) {
      throw new Error('The reset coordinator is not initialized.');
    }

    return reset;
  };
  const diagnostics = new Diagnostics((entries) => views.broadcast({ event: 'debug', data: entries }));
  const log = (kind: string, message: string) => diagnostics.add(kind, message);
  const host = new NativeHost({
    allow(method) {
      if (!blocked() || ['system.resetPrepare', 'system.reset', 'system.resetComplete'].includes(method)) {
        return true;
      }

      return (
        getReset().busy &&
        getReset().state.phase === 'stopping' &&
        ['worker.pause', 'worker.bridgeSave'].includes(method)
      );
    },
    snapshot(snapshot) {
      if (blocked() || disposed) {
        return;
      }

      tasks.update(snapshot);
      const compatible = snapshot.runtime.version === APP_VERSION;
      let error: string | undefined;

      if (!compatible) {
        error =
          `Local host ${snapshot.runtime.version || 'unknown'} differs from Miter ${APP_VERSION}. ` +
          'Finish setup, then reload Miter in Chrome’s extensions page.';
      }

      views.broadcast({ event: 'connection', connected: compatible, error });

      if (!announced) {
        announced = true;
        log('host.ready', `Host ${snapshot.runtime.version || 'unknown'}; extension ${APP_VERSION}.`);
      }

      for (const event of [...snapshot.events].reverse()) {
        if (event.id > lastEvent) {
          lastEvent = event.id;
          diagnostics.add(
            'worker.' + event.kind,
            `[${event.workerId.slice(0, 8)}] ${event.message}`,
            event.time,
          );
        }
      }
    },
    resetRequired: (error) => getReset().recover(error),
    disconnected(error) {
      announced = false;
      terminal.disconnected();
      tasks.disconnected();
      log('host.error', error);
      views.broadcast({ event: 'connection', connected: false, error });
    },
    log,
  });
  const rpc: NativeRPC = host.request.bind(host);
  const views = new ViewConnections({
    reset: getReset,
    rpc,
    connect: () => {
      host.connect();
    },
    request: (method, params) => tasks.request(method, params),
    initialMessages: () => tasks.initialMessages(),
    log,
  });
  const notifications = new TaskNotifications({
    blocked,
    broadcast: (message) => views.broadcast(message),
    ding: () => views.ding(),
    openTask: (workerId) => tasks.openNotification(workerId),
    log,
  });
  const tasks = createTaskController({
    rpc,
    broadcast: (message) => views.broadcast(message),
    blocked,
    ready: () => getReset().ready,
    notifications,
    diagnostics,
  });
  const terminal = new TerminalControl({
    native: rpc,
    request: (method, params) => tasks.request(method, params),
    ready: () => getReset().ready,
    blocked,
    log,
  });

  reset = new DataResetCoordinator({
    storage: chrome.storage.local,
    publish: (state) => views.publishReset(state),
    quiesceViews: () => views.quiesce(),
    async stop() {
      terminal.dispose();
      tasks.capturePageIds(pageIds);
      await tasks.stop();
      await waitFor(views.settled(), 'Pending UI requests');
      tasks.capturePageIds(pageIds);
      await tasks.quiesce();
      await clearPageState(pageIds, tasks.forgetPage);
      await tasks.releaseResources();
    },
    hostPrepare: () => rpc('system.resetPrepare', { confirmation: 'CLEAR' }, resetPreparationSchema),
    hostClear: () => rpc('system.reset', { confirmation: 'CLEAR' }, resetCleanupResultSchema),
    hostComplete: () => rpc('system.resetComplete', { confirmation: 'CLEAR' }, resetCompletionSchema),
    async clearBrowser() {
      await views.quiesce();
      views.disconnectAuxiliary();
      await clearBrowserData();
      tasks.clear();
      pageIds.clear();
      lastEvent = 0;
    },
    restart: () => {
      if (!disposed) {
        restartTimer = setTimeout(() => chrome.runtime.reload(), 150);
      }
    },
  });

  const installed = (details: chrome.runtime.InstalledDetails): void => {
    if (details.reason === 'update' && !disposed) {
      void restoreReloadedWorkspace(() => disposed).catch((error) =>
        log('ui.open.error', errorMessage(error)),
      );
    }
  };

  const openPanel = (tab: chrome.tabs.Tab): void => {
    if (!disposed && tab.windowId !== undefined) {
      // Call directly from the Chrome user gesture; no permission or host work is inserted here.
      void chrome.sidePanel
        .open({ windowId: tab.windowId })
        .catch((error) => log('ui.open.error', errorMessage(error)));
    }
  };
  const command = async (name: string): Promise<void> => {
    if (disposed || name !== 'open-mitter') {
      return;
    }

    try {
      const window = await chrome.windows.getCurrent();

      if (!disposed && window.id !== undefined) {
        await chrome.sidePanel.open({ windowId: window.id });
      }
    } catch (error) {
      log('ui.open.error', errorMessage(error));
    }
  };

  const release = (resource: string, cleanup: () => void): void => {
    try {
      cleanup();
    } catch (error) {
      console.warn('Miter could not release ' + resource + '.', error);
    }
  };
  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    clearInterval(timer);
    clearTimeout(restartTimer);
    release('the terminal relay', () => terminal.dispose());
    release('the browser startup listener', () =>
      chrome.runtime.onStartup.removeListener(tasks.browserStartup),
    );
    release('the update listener', () => chrome.runtime.onInstalled.removeListener(installed));
    release('the action listener', () => chrome.action.onClicked.removeListener(openPanel));
    release('the command listener', () => chrome.commands.onCommand.removeListener(command));
    release('the tab removal listener', () => chrome.tabs.onRemoved.removeListener(tasks.tabRemoved));
    release('the tab update listener', () => chrome.tabs.onUpdated.removeListener(tasks.tabUpdated));
    release('notifications', () => notifications.dispose());
    release('task resources', () => tasks.dispose());
    release('view connections', () => views.dispose());
    release('the native host', () => host.dispose());
  };

  try {
    views.start();
    chrome.runtime.onStartup.addListener(tasks.browserStartup);
    chrome.runtime.onInstalled.addListener(installed);
    chrome.action.onClicked.addListener(openPanel);
    chrome.commands.onCommand.addListener(command);
    chrome.tabs.onRemoved.addListener(tasks.tabRemoved);
    chrome.tabs.onUpdated.addListener(tasks.tabUpdated);
    timer = setInterval(() => tasks.tick(), 1500);
    terminal.start();
    log('app.start', `Miter ${APP_VERSION}; packaged message bridge v4.`);
  } catch (error) {
    dispose();
    throw error;
  }

  return { diagnostics, dispose };
}
