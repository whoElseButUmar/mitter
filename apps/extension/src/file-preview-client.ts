import { assetRequestSchema, validateAssetChunk, type AssetChunk } from './schemas/preview.js';
import { rpcResponseSchema } from './schemas/messages.js';
import { errorMessage } from './schemas/primitives.js';
import { PendingRequests } from './transport/pending-requests.js';

/** One lightweight read-only connection. Reconnection never triggers execution. */
export class FilePreviewClient {
  private port: chrome.runtime.Port | undefined;
  private removePortListeners: (() => void) | undefined;
  private closed = false;
  private pending = new PendingRequests();

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

  private disconnected(port: chrome.runtime.Port, detail: string): void {
    if (this.port !== port) {
      return;
    }

    this.detachPort();
    this.pending.rejectAll(new Error(detail));

    try {
      port.disconnect();
    } catch {}
  }

  private connect(): chrome.runtime.Port {
    if (this.closed) {
      throw new Error('File window closed.');
    }

    if (this.port) {
      return this.port;
    }

    const port = chrome.runtime.connect({ name: 'miter-file-preview' });
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
      this.disconnected(
        port,
        chrome.runtime.lastError?.message || 'File connection closed. Reload to reconnect.',
      );
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

  request = async (method: string, params: Record<string, unknown>): Promise<AssetChunk> => {
    const request = assetRequestSchema.parse({
      id: crypto.randomUUID(),
      method,
      params,
    });
    const port = this.connect();
    const result = await this.pending.send(
      request.id,
      35000,
      () => new Error('File read timed out. Reload to try again.'),
      () => {
        try {
          port.postMessage({ ...request, params });
        } catch {
          this.disconnected(port, 'File connection closed. Reload to reconnect.');
        }
      },
    );

    return validateAssetChunk(result, request.params);
  };

  close(): void {
    this.closed = true;
    const port = this.detachPort();
    this.pending.rejectAll(new Error('File window closed.'));

    try {
      port?.disconnect();
    } catch {}
  }
}
