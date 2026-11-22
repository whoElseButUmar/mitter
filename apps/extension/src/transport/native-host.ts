import { z } from 'zod';
import { NATIVE_HOST_NAME, requestSchema } from '../../../../packages/protocol/src/index.js';
import { NativeMessageInbox } from '../../../../packages/protocol/src/native-transfer.js';
import { NativeRequestTimeout } from '../../../../packages/bridge/src/native-request.js';
import { nativeMessageSchema } from '../schemas/messages.js';
import { parseRpcParams } from '../../../../packages/protocol/src/rpc.js';
import { nativeRpcRegistry, type NativeRpcMethod, type NativeRpcResult } from '../schemas/native-rpc.js';
import { errorMessage, invalidRPCResult } from '../schemas/primitives.js';
import type { HostSnapshot } from '../schemas/host-results.js';
import { PendingRequests } from './pending-requests.js';
import { parseNativeResult } from './native-results.js';

export type NativeRPC = {
  <Method extends NativeRpcMethod>(
    method: Method,
    params?: Record<string, unknown>,
  ): Promise<NativeRpcResult<Method>>;
  (method: string, params?: Record<string, unknown>): Promise<unknown>;
  <Result>(method: string, params: Record<string, unknown>, schema: z.ZodType<Result>): Promise<Result>;
};

type NativeHostDependencies = {
  allow(method: string): boolean;
  snapshot(snapshot: HostSnapshot): void;
  resetRequired(error: string): void;
  disconnected(error: string): void;
  log(kind: string, message: string): void;
};

const quietMethods = new Set([
  'state',
  'worker.files',
  'worker.previewStatus',
  'project.appRuns',
  'worker.handoffSeen',
  'worker.bridgeLoad',
  'worker.bridgeSave',
]);

/** One native connection owns its decoder and pending requests. Superseded ports have no authority. */
export class NativeHost {
  private port: chrome.runtime.Port | undefined;
  private detachPort: (() => void) | undefined;
  private pending = new PendingRequests();
  private closed = false;

  constructor(private dependencies: NativeHostDependencies) {}

  connect(): chrome.runtime.Port {
    if (this.closed) {
      throw new Error('Native transport disposed. No operation was sent.');
    }

    if (this.port) {
      return this.port;
    }

    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    const inbox = new NativeMessageInbox();
    this.port = port;

    const onMessage = (fragment: unknown): void => {
      if (this.port !== port || this.closed) {
        return;
      }

      try {
        const decoded: unknown = inbox.accept(fragment);

        if (decoded === undefined) {
          return;
        }

        const message = nativeMessageSchema.parse(decoded);

        if ('id' in message) {
          this.pending.receive(message);
        } else if (message.event === 'snapshot') {
          this.dependencies.snapshot(message.data);
        } else {
          this.dependencies.resetRequired(message.error || 'Data reset incomplete.');
        }
      } catch (error) {
        const detail = 'Invalid native host message: ' + errorMessage(error);
        inbox.clear();
        this.dependencies.log('host.protocol.error', detail);
        this.disconnect(port, detail);
      }
    };
    const onDisconnect = (): void => {
      inbox.clear();
      this.disconnect(port, chrome.runtime.lastError?.message || 'Local host disconnected.');
    };
    this.detachPort = () => {
      inbox.clear();

      try {
        port.onMessage.removeListener(onMessage);
      } finally {
        port.onDisconnect.removeListener(onDisconnect);
      }
    };
    try {
      this.dependencies.log('host.connect', 'Opening native host connection');
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
    } catch (error) {
      this.disconnect(port, 'Could not initialize the native host connection: ' + errorMessage(error));
      throw error;
    }

    return port;
  }

  private removePortListeners(): void {
    const detach = this.detachPort;
    this.detachPort = undefined;

    try {
      detach?.();
    } catch (error) {
      console.warn('Miter native port listeners could not be detached.', error);
    }
  }

  private disconnect(port: chrome.runtime.Port, detail: string): void {
    if (this.port !== port) {
      return;
    }

    this.port = undefined;
    this.removePortListeners();
    const error = new Error(
      detail +
        ' The operation may already have reached Miter; it was not replayed. ' +
        'Reconnect and check the task state before trying another action.',
    );
    this.pending.rejectAll(error);

    try {
      port.disconnect();
    } catch {}

    this.dependencies.disconnected(error.message);
  }

  request<Method extends NativeRpcMethod>(
    method: Method,
    params?: Record<string, unknown>,
  ): Promise<NativeRpcResult<Method>>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  request<Result>(
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<Result>,
  ): Promise<Result>;
  async request(method: string, params: Record<string, unknown> = {}, schema?: z.ZodType): Promise<unknown> {
    if (this.closed) {
      throw new Error('Native transport disposed. No operation was sent.');
    }

    const request = requestSchema.parse({ id: crypto.randomUUID(), method, params });
    method = request.method;
    parseRpcParams(nativeRpcRegistry, method, request.params);

    if (!this.dependencies.allow(method)) {
      throw new Error('Data reset in progress or incomplete. No task operation was executed.');
    }
    const id = request.id;
    const quiet = method.startsWith('terminal.') || quietMethods.has(method);
    let timeoutMs = 30000;

    if (method === 'worker.previewStart' || method === 'workflow.replay') {
      timeoutMs = 360000;
    } else if (method.startsWith('system.reset')) {
      timeoutMs = 180000;
    } else if (method === 'workflow.record') {
      timeoutMs = 180000;
    } else if (method === 'project.pickFolder') {
      timeoutMs = 130000;
    }

    if (!quiet) {
      this.dependencies.log('rpc.request', `${method} · ${id.slice(0, 8)}`);
    }

    try {
      const result = await this.pending.send(
        id,
        timeoutMs,
        () => new NativeRequestTimeout(method),
        () => {
          const port = this.connect();

          try {
            // Keep host-owned defaults and caller-owned authority fields unchanged on the wire.
            port.postMessage({ ...request, params });
          } catch (error) {
            this.disconnect(port, 'Local host connection closed while sending.');
            throw error;
          }
        },
      );
      let parsed = parseNativeResult(method, result);

      if (schema !== undefined) {
        parsed = schema.parse(parsed);
      }

      if (!quiet) {
        this.dependencies.log('rpc.result', `${method} · OK`);
      }

      return parsed;
    } catch (error) {
      if (!method.startsWith('terminal.')) {
        this.dependencies.log('rpc.error', `${method} · ${errorMessage(error)}`);
      }

      if (error instanceof z.ZodError) {
        throw invalidRPCResult(method, error);
      }

      throw error;
    }
  }

  dispose(): void {
    this.closed = true;
    const port = this.port;
    this.port = undefined;
    this.removePortListeners();
    this.pending.rejectAll(new Error('Extension shutdown. Pending operations were not replayed.'));

    try {
      port?.disconnect();
    } catch {}
  }
}
