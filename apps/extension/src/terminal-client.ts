import { TERMINAL_PORT } from '../../../packages/terminal/src/protocol.js';
import { rpcResponseSchema } from './schemas/messages.js';
import { errorMessage } from './schemas/primitives.js';
import {
  parseTerminalResult,
  terminalRequestSchema,
  type TerminalRpcMethod,
  type TerminalRpcResult,
} from './schemas/terminal.js';
import { PendingRequests } from './transport/pending-requests.js';

export class TerminalClient {
  private port: chrome.runtime.Port | undefined;
  private removePortListeners: (() => void) | undefined;
  private pending = new PendingRequests();
  private closed = false;

  constructor(private disconnected: () => void) {}

  private detachPort(): chrome.runtime.Port | undefined {
    const port = this.port;
    this.port = undefined;
    const removeListeners = this.removePortListeners;
    this.removePortListeners = undefined;

    try {
      removeListeners?.();
    } catch {}

    return port;
  }

  private disconnect(port: chrome.runtime.Port): void {
    if (this.port !== port) {
      return;
    }

    this.detachPort();
    this.pending.rejectAll(new Error('Terminal disconnected. Input was not replayed.'));

    try {
      port.disconnect();
    } catch {}

    this.disconnected();
  }

  private connect(): chrome.runtime.Port {
    if (this.closed) {
      throw new Error('Terminal view closed. No input was sent.');
    }

    if (this.port) {
      return this.port;
    }

    const port = chrome.runtime.connect({ name: TERMINAL_PORT });
    this.port = port;
    const onMessage = (raw: unknown): void => {
      if (this.port !== port || this.closed) {
        return;
      }

      const response = rpcResponseSchema.safeParse(raw);

      if (response.success) {
        this.pending.receive(response.data);
      }
    };

    const onDisconnect = (): void => {
      this.disconnect(port);
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
      if (this.port === port) {
        this.detachPort();
        this.pending.rejectAll(new Error(errorMessage(error)));

        try {
          port.disconnect();
        } catch {}
      }

      throw error;
    }

    return port;
  }

  request<Method extends TerminalRpcMethod>(
    method: Method,
    params?: Record<string, unknown>,
  ): Promise<TerminalRpcResult<Method>>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const request = terminalRequestSchema.parse({
      id: crypto.randomUUID(),
      method,
      params,
    });
    const port = this.connect();
    const result = await this.pending.send(
      request.id,
      15000,
      () => new Error('Terminal request timed out. Input was not replayed.'),
      () => {
        try {
          port.postMessage(request);
        } catch {
          this.disconnect(port);
        }
      },
    );

    return parseTerminalResult(request.method, result);
  }

  close(): void {
    this.closed = true;
    const port = this.detachPort();
    this.pending.rejectAll(new Error('Terminal view closed.'));

    try {
      port?.disconnect();
    } catch {}
  }
}
