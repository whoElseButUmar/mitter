import { validateViewParams, parseViewResult } from '../schemas/view-rpc.js';
import { ResetViewBarrier } from '../../../../packages/bridge/src/reset-views.js';
import type { DataResetCoordinator } from '../../../../packages/bridge/src/data-reset.js';
import { bindTerminalPort } from '../terminal-port.js';
import { bindFilePreviewPort } from '../file-preview-port.js';
import { resetStartSchema, rpcRequestSchema, uiControlSchema } from '../schemas/messages.js';
import { documentURL, errorMessage } from '../schemas/primitives.js';
import type { NativeRPC } from '../transport/native-host.js';
import { auxiliaryPort, viewMismatch, type PeerBuild } from '../transport/build-connection.js';
import { APP_VERSION, BUILD_ID, matchesBuild } from '../../../../packages/protocol/src/index.js';

type ViewDependencies = {
  reset(): DataResetCoordinator;
  requireHelper?(): void;
  currentHelper?(): PeerBuild | undefined;
  rpc: NativeRPC;
  connect(): void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  initialMessages(): unknown[];
  log(kind: string, message: string): void;
};

/** Authenticated document ports, UI work tracking, and the independent reset write barrier. */
export class ViewConnections {
  private views = new Set<chrome.runtime.Port>();
  private readyViews = new Set<chrome.runtime.Port>();
  private resetViews = new Set<chrome.runtime.Port>();
  private auxiliaryViews = new Set<chrome.runtime.Port>();
  private portCleanups = new Map<chrome.runtime.Port, () => void>();
  private disposed = false;
  private work = new Set<Promise<unknown>>();
  private viewURLs = ['sidepanel.html', 'workspace.html'].map((page) => chrome.runtime.getURL(page));
  private dataViewURLs = [...this.viewURLs, chrome.runtime.getURL('file.html')];
  private barrier = new ResetViewBarrier(this.dataViewURLs, () => {
    if (!chrome.runtime.getContexts) {
      throw new Error(
        'This Chrome version cannot enumerate Miter documents. Update Chrome before resetting.',
      );
    }

    return chrome.runtime.getContexts({});
  });

  constructor(private dependencies: ViewDependencies) {}

  start(): void {
    if (this.disposed) {
      throw new Error('View connections disposed. Reopen Miter to reconnect.');
    }

    try {
      chrome.runtime.onConnect.addListener(this.connected);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private retire(port: chrome.runtime.Port): void {
    const cleanup = this.portCleanups.get(port);
    this.portCleanups.delete(port);
    const view = this.views.delete(port);
    this.readyViews.delete(port);
    const auxiliary = this.auxiliaryViews.delete(port);
    const reset = this.resetViews.delete(port);

    if (reset) {
      this.barrier.remove(port);
    }

    if (!cleanup && !view && !auxiliary && !reset) {
      return;
    }

    try {
      cleanup?.();
    } catch (error) {
      console.warn('Miter view listeners could not be detached.', error);
    }

    try {
      port.disconnect();
    } catch {}
  }

  private attach(port: chrome.runtime.Port, onMessage: (raw: unknown) => void): void {
    const onDisconnect = (): void => this.retire(port);
    this.portCleanups.set(port, () => {
      try {
        port.onMessage.removeListener(onMessage);
      } finally {
        port.onDisconnect.removeListener(onDisconnect);
      }
    });

    try {
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
    } catch (error) {
      this.retire(port);
      throw error;
    }
  }

  private post(port: chrome.runtime.Port, message: unknown): void {
    if (!this.views.has(port) && !this.resetViews.has(port)) {
      return;
    }

    try {
      port.postMessage(message);
    } catch {
      this.retire(port);
    }
  }

  broadcast(message: unknown): void {
    for (const view of this.readyViews) {
      this.post(view, message);
    }
  }

  ding(): void {
    const view = [...this.readyViews].at(-1);

    if (view) {
      this.post(view, { event: 'ding' });
    }
  }

  publishReset(state: DataResetCoordinator['state']): void {
    for (const view of this.resetViews) {
      this.post(view, { type: 'reset-state', state });
    }
  }

  private authenticated(port: chrome.runtime.Port, urls: string[]): boolean {
    const sender = port.sender;

    return (
      sender?.id === chrome.runtime.id &&
      sender.url !== undefined &&
      urls.includes(documentURL(sender.url)) &&
      (sender.frameId === undefined || sender.frameId === 0) &&
      (sender.origin === undefined || sender.origin === 'chrome-extension://' + chrome.runtime.id)
    );
  }

  private bindReset(port: chrome.runtime.Port): void {
    if (!this.authenticated(port, this.dataViewURLs)) {
      port.disconnect();
      return;
    }

    const reset = this.dependencies.reset();
    this.resetViews.add(port);
    this.barrier.add(port);
    const onMessage = (raw: unknown): void => {
      if (!this.resetViews.has(port)) {
        return;
      }

      if (this.barrier.receive(port, raw)) {
        return;
      }

      const message = resetStartSchema.safeParse(raw);

      if (!message.success || documentURL(port.sender?.url || '') === chrome.runtime.getURL('file.html')) {
        return;
      }

      const request = message.data;
      try {
        this.dependencies.requireHelper?.();
      } catch (error) {
        this.post(port, { id: request.id, ok: false, error: errorMessage(error) });
        return;
      }
      void reset
        .clear(request.confirmation)
        .then(() => this.post(port, { id: request.id, ok: true }))
        .catch((error) =>
          this.post(port, {
            id: request.id,
            ok: false,
            error: errorMessage(error),
          }),
        );
    };
    this.attach(port, onMessage);

    void reset.ready.then(() => {
      if (!this.resetViews.has(port)) {
        return;
      }

      this.post(port, { type: 'reset-state', state: reset.state });

      if (reset.busy) {
        void this.barrier.quiesce(port).catch(() => {});
      }
    });
  }

  private connected = (port: chrome.runtime.Port): void => {
    if (this.disposed) {
      try {
        port.disconnect();
      } catch {}

      return;
    }

    try {
      this.bind(port);
    } catch (error) {
      this.retire(port);
      this.dependencies.log('ui.connect.error', errorMessage(error));
    }
  };

  private bind(port: chrome.runtime.Port): void {
    if (port.name === auxiliaryPort('miter-data-view')) {
      this.bindReset(port);
      return;
    }

    const reset = this.dependencies.reset();

    if (reset.blocked && port.name !== 'mitter-ui') {
      port.disconnect();
      return;
    }

    if (port.name === auxiliaryPort('miter-terminal') || port.name === auxiliaryPort('miter-file-preview')) {
      let dispose: (() => void) | undefined;

      if (port.name === auxiliaryPort('miter-terminal')) {
        dispose = bindTerminalPort(port, {
          extensionId: chrome.runtime.id,
          viewURLs: this.viewURLs,
          rpc: this.dependencies.rpc,
        });
      } else {
        dispose = bindFilePreviewPort(port, {
          extensionId: chrome.runtime.id,
          viewerURL: chrome.runtime.getURL('file.html'),
          rpc: this.dependencies.rpc,
        });
      }

      if (!dispose) {
        return;
      }

      const onDisconnect = (): void => this.retire(port);
      this.auxiliaryViews.add(port);
      this.portCleanups.set(port, () => {
        try {
          port.onDisconnect.removeListener(onDisconnect);
        } finally {
          dispose();
        }
      });
      port.onDisconnect.addListener(onDisconnect);
      return;
    }

    if (port.name !== 'mitter-ui' || !this.authenticated(port, this.viewURLs)) {
      port.disconnect();
      return;
    }

    this.views.add(port);
    let compatible = false;
    let initialized = false;
    let reloadMessage =
      'Miter could not confirm a matching view version. Open chrome://extensions, click Reload on Miter, ' +
      'then reopen the workspace. No operation was sent.';
    const inFlight = new Set<string>();
    const onMessage = (raw: unknown): void => {
      if (!this.views.has(port)) {
        return;
      }

      const control = uiControlSchema.safeParse(raw);

      if (control.success) {
        if (control.data.type === 'hello') {
          compatible = matchesBuild(control.data.version, control.data.buildId);
          if (!compatible) {
            reloadMessage = viewMismatch(control.data, { version: APP_VERSION, buildId: BUILD_ID });
          }

          if (compatible) {
            this.readyViews.add(port);
          } else {
            this.readyViews.delete(port);
          }

          const helper = this.dependencies.currentHelper?.();
          this.post(port, {
            type: 'hello',
            id: control.data.id,
            version: APP_VERSION,
            buildId: BUILD_ID,
            ...(helper && { helper }),
          });

          if (!compatible) {
            this.post(port, { event: 'connection', connected: false, error: reloadMessage });
            return;
          }

          if (!initialized) {
            initialized = true;

            if (!reset.blocked) {
              for (const message of this.dependencies.initialMessages()) {
                this.post(port, message);
              }
            }
          }
        } else if (control.data.type === 'ping') {
          // Liveness never touches tasks, the composer, native RPC, or permissions.
          this.post(port, { type: 'pong', id: control.data.id });
          return;
        }

        if (compatible) {
          try {
            this.dependencies.connect();
          } catch (error) {
            const detail = errorMessage(error);
            this.dependencies.log('host.error', detail);
            this.post(port, { event: 'connection', connected: false, error: detail });
          }
        } else {
          this.post(port, { event: 'connection', connected: false, error: reloadMessage });
        }

        return;
      }

      const parsed = rpcRequestSchema.safeParse(raw);

      if (!parsed.success || inFlight.has(parsed.data.id)) {
        return;
      }

      const message = parsed.data;

      if (!compatible) {
        this.post(port, { id: message.id, ok: false, error: reloadMessage });
        return;
      }

      let job: Promise<unknown>;

      try {
        validateViewParams(message.method, message.params);
        job = this.dependencies.request(message.method, message.params);
      } catch (error) {
        this.post(port, { id: message.id, ok: false, error: errorMessage(error) });
        return;
      }
      this.work.add(job);
      inFlight.add(message.id);
      void job
        .finally(() => {
          this.work.delete(job);
          inFlight.delete(message.id);
        })
        .catch(() => {});
      void job
        .then((result) =>
          this.post(port, {
            id: message.id,
            ok: true,
            result: parseViewResult(message.method, result),
          }),
        )
        .catch((error) => {
          const detail = errorMessage(error);

          if (message.method.startsWith('bridge.')) {
            this.dependencies.log('bridge.error', detail);
          }

          this.post(port, { id: message.id, ok: false, error: detail });
        });
    };
    this.attach(port, onMessage);
    // Older views do not send hello. Their existing connection handler can still explain recovery.
    this.post(port, { event: 'connection', connected: false, error: reloadMessage });
  }

  quiesce(): Promise<void> {
    return this.barrier.quiesceAll();
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.work]);
  }

  disconnectAuxiliary(): void {
    for (const port of this.auxiliaryViews) {
      this.retire(port);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    try {
      chrome.runtime.onConnect.removeListener(this.connected);
    } catch (error) {
      console.warn('Miter view connection listener could not be detached.', error);
    }

    this.barrier.dispose();

    for (const port of this.portCleanups.keys()) {
      this.retire(port);
    }
  }
}
