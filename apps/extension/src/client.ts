import { z } from 'zod';
import { APP_VERSION, type Snapshot } from '../../../packages/protocol/src/index.js';
import {
  auxiliaryMessageSchema,
  connectionMessageSchema,
  pongSchema,
  rpcResponseSchema,
  rpcRequestSchema,
  snapshotMessageSchema,
  type AuxiliaryMessage,
} from './schemas/messages.js';
import { errorMessage, invalidRPCResult } from './schemas/primitives.js';
import { PendingRequests } from './transport/pending-requests.js';
import {
  validateViewParams,
  parseViewResult,
  type ViewRpcMethod,
  type ViewRpcResult,
} from './schemas/view-rpc.js';

const viewMessageSchema = z
  .union([
    pongSchema,
    snapshotMessageSchema,
    connectionMessageSchema,
    auxiliaryMessageSchema,
    rpcResponseSchema,
  ])
  .describe('A validated view heartbeat, host event, or correlated RPC response.');

export class HostClient {
  private port: chrome.runtime.Port | undefined;
  private removePortListeners: (() => void) | undefined;
  private pending = new PendingRequests();
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatDeadline: ReturnType<typeof setTimeout> | undefined;
  private heartbeatId = '';
  private retries = 0;

  constructor(
    private onSnapshot: (snapshot: Snapshot) => void,
    private onConnection: (connected: boolean, error?: string) => void,
    private onAux: (message: AuxiliaryMessage) => void = () => {},
  ) {}

  private clearRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private clearHeartbeat(): void {
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.heartbeatDeadline);
    this.heartbeatTimer = undefined;
    this.heartbeatDeadline = undefined;
    this.heartbeatId = '';
  }

  private scheduleReconnect(error: string): void {
    if (this.closed || this.retryTimer !== undefined) {
      return;
    }

    // Reconnect the view, never replay an outstanding mutation.
    if (this.retries >= 6) {
      this.onConnection(false, error + ' Automatic reconnection paused. Use Reconnect or reopen Miter.');
      return;
    }

    const delay = Math.min(8000, 250 * 2 ** this.retries++);
    this.onConnection(false, error + ' Reconnecting the panel… Pending actions are not retried.');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;

      if (!this.closed && !this.port) {
        this.open();
      }
    }, delay);
  }

  private detachPort(): chrome.runtime.Port | undefined {
    const port = this.port;
    this.port = undefined;
    const removeListeners = this.removePortListeners;
    this.removePortListeners = undefined;

    try {
      removeListeners?.();
    } catch (error) {
      console.warn('Miter view port listeners failed to detach.', error);
    }

    return port;
  }

  private disconnected(port: chrome.runtime.Port, error: string): void {
    if (this.port !== port) {
      return;
    }

    this.detachPort();
    this.clearHeartbeat();
    this.pending.rejectAll(
      new Error(error + ' The operation may already have reached Miter; it was not replayed.'),
    );

    try {
      port.disconnect();
    } catch (disconnectError) {
      console.warn('Miter view port failed to close.', disconnectError);
    }

    this.scheduleReconnect(error);
  }

  private scheduleHeartbeat(port: chrome.runtime.Port): void {
    this.clearHeartbeat();

    if (this.closed || this.port !== port) {
      return;
    }

    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;

      if (this.closed || this.port !== port) {
        return;
      }

      const id = crypto.randomUUID();
      this.heartbeatId = id;
      this.heartbeatDeadline = setTimeout(() => {
        if (this.port === port && this.heartbeatId === id) {
          this.disconnected(port, 'The extension connection stopped responding.');
        }
      }, 5000);

      try {
        port.postMessage({ type: 'ping', id });
      } catch {
        this.disconnected(port, 'The extension connection closed.');
      }
    }, 15000);
  }

  private open(): void {
    if (this.closed) {
      return;
    }

    let port: chrome.runtime.Port;

    try {
      port = chrome.runtime.connect({ name: 'mitter-ui' });
    } catch (error) {
      let detail = 'The extension could not be reached.';

      if (error instanceof Error) {
        detail = error.message;
      }

      this.scheduleReconnect(detail);
      return;
    }

    this.port = port;
    const onMessage = (raw: unknown): void => {
      if (this.port !== port || this.closed) {
        return;
      }

      const parsed = viewMessageSchema.safeParse(raw);

      if (!parsed.success) {
        return;
      }

      const message = parsed.data;

      if ('type' in message) {
        if (message.id === this.heartbeatId) {
          this.retries = 0;
          this.scheduleHeartbeat(port);
        }
      } else if ('id' in message) {
        this.pending.receive(message);
      } else if (message.event === 'snapshot') {
        this.retries = 0;
        this.onSnapshot(message.data);
        const compatible = message.data.runtime.version === APP_VERSION;
        let error: string | undefined;

        if (!compatible) {
          error = 'Reload Miter after setup to connect the matching local host.';
        }

        this.onConnection(compatible, error);
      } else if (message.event === 'connection') {
        this.onConnection(message.connected, message.error);
      } else {
        this.onAux(message);
      }
    };

    const onDisconnect = (): void => {
      if (this.port === port) {
        this.disconnected(port, chrome.runtime.lastError?.message || 'Extension connection closed.');
      }
    };

    this.removePortListeners = () => {
      try {
        port.onMessage.removeListener(onMessage);
      } finally {
        port.onDisconnect.removeListener(onDisconnect);
      }
    };

    try {
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
    } catch (error) {
      this.disconnected(port, errorMessage(error));
      return;
    }

    this.scheduleHeartbeat(port);
  }

  connect(): void {
    // Detach before disconnecting: an old callback cannot reject new work.
    const previous = this.detachPort();
    this.closed = false;
    this.clearRetry();
    this.clearHeartbeat();
    this.retries = 0;
    this.pending.rejectAll(
      new Error('Extension connection replaced. The previous operation was not replayed.'),
    );

    try {
      previous?.disconnect();
    } catch (error) {
      console.warn('Miter previous view port failed to close.', error);
    }

    this.open();
  }

  request<Method extends ViewRpcMethod>(
    method: Method,
    params?: Record<string, unknown>,
  ): Promise<ViewRpcResult<Method>>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  request<Result>(
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<Result>,
  ): Promise<Result>;
  async request(method: string, params: Record<string, unknown> = {}, schema?: z.ZodType): Promise<unknown> {
    if (this.closed) {
      throw new Error('Miter view closed. No operation was sent.');
    }

    const request = rpcRequestSchema.parse({ id: crypto.randomUUID(), method, params });
    method = request.method;
    validateViewParams(method, params);

    if (!this.port) {
      this.clearRetry();
      this.open();
    }

    const port = this.port;

    if (!port) {
      throw new Error('The extension is reconnecting. No operation was sent.');
    }

    let timeoutMs = 45000;
    let timeoutDetail = 'The local host did not respond.';

    if (method === 'project.pickFolder') {
      timeoutMs = 135000;
    }

    if (method.startsWith('bridge.')) {
      timeoutDetail = 'The chat connection did not respond.';
    }

    const result = await this.pending.send(
      request.id,
      timeoutMs,
      () =>
        new Error(
          timeoutDetail + ' The operation may still finish; it was not retried. Open Console for details.',
        ),
      () => {
        try {
          port.postMessage({ ...request, params });
        } catch {
          this.disconnected(port, 'The extension connection closed while sending.');
        }
      },
    );
    try {
      const parsed = parseViewResult(method, result);

      if (schema !== undefined) {
        return schema.parse(parsed);
      }

      return parsed;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw invalidRPCResult(method, error);
      }

      throw error;
    }
  }

  reconnect(): void {
    if (this.closed) {
      return;
    }

    if (!this.port) {
      this.connect();
    }

    const port = this.port;

    if (!port) {
      return;
    }

    try {
      port.postMessage({ type: 'reconnect' });
    } catch {
      this.disconnected(port, 'The extension connection closed.');
    }
  }

  close(): void {
    this.closed = true;
    this.clearRetry();
    this.clearHeartbeat();
    const port = this.detachPort();
    this.pending.rejectAll(new Error('Miter view closed. Pending operations were not replayed.'));

    try {
      port?.disconnect();
    } catch (error) {
      console.warn('Miter view port failed to close.', error);
    }
  }
}

export async function userReadClipboard(): Promise<string> {
  // Keep permission acquisition directly in the user-gesture path.
  const granted = await chrome.permissions.request({
    permissions: ['clipboardRead'],
  });

  if (!granted) {
    throw new Error('Clipboard permission was not granted. Paste into the text box instead.');
  }

  return navigator.clipboard.readText();
}
