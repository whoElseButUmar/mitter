import { auxiliaryPort } from './transport/build-connection.js';
import { parseFileTarget } from '../../../packages/ui/src/file-target.js';
import { assetRequestSchema, validateAssetChunk } from './schemas/preview.js';
import { rpcRequestSchema } from './schemas/messages.js';
import { documentURL, errorMessage } from './schemas/primitives.js';
import type { NativeRPC } from './transport/native-host.js';

type FilePreviewPortDependencies = {
  extensionId: string;
  viewerURL: string;
  rpc: NativeRPC;
};

/** No workspace subscription or mutation RPCs for a standalone viewer. */
export function bindFilePreviewPort(
  port: chrome.runtime.Port,
  dependencies: FilePreviewPortDependencies,
): (() => void) | undefined {
  const sender = port.sender;
  const url = sender?.url;

  if (
    port.name !== auxiliaryPort('miter-file-preview') ||
    sender?.id !== dependencies.extensionId ||
    !url ||
    documentURL(url) !== dependencies.viewerURL ||
    (sender.frameId !== undefined && sender.frameId !== 0) ||
    (sender.origin !== undefined && sender.origin !== 'chrome-extension://' + dependencies.extensionId)
  ) {
    try {
      port.disconnect();
    } catch {}

    return undefined;
  }

  let workerId: string;

  try {
    workerId = parseFileTarget(url).workerId;
  } catch {
    try {
      port.disconnect();
    } catch {}

    return undefined;
  }

  let closed = false;
  const inFlight = new Set<string>();
  const dispose = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    inFlight.clear();

    try {
      try {
        port.onMessage.removeListener(onMessage);
      } finally {
        port.onDisconnect.removeListener(dispose);
      }
    } catch (error) {
      console.warn('Miter file port listeners could not be detached.', error);
    }
  };
  const close = (): void => {
    dispose();

    try {
      port.disconnect();
    } catch {}
  };
  const post = (message: unknown): void => {
    if (closed) {
      return;
    }

    try {
      port.postMessage(message);
    } catch {
      close();
    }
  };

  const onMessage = (raw: unknown): void => {
    const header = rpcRequestSchema.safeParse(raw);

    if (closed || !header.success || inFlight.has(header.data.id)) {
      return;
    }

    const id = header.data.id;

    try {
      const request = assetRequestSchema.parse(header.data);

      if (request.params.workerId !== workerId) {
        throw new Error('This viewer can only read files from its original task.');
      }

      if (inFlight.size >= 4) {
        throw new Error('Too many pending preview reads. Retry after the current load.');
      }

      inFlight.add(id);
      void dependencies
        .rpc('worker.asset', header.data.params)
        .then((result) =>
          post({
            id,
            ok: true,
            result: validateAssetChunk(result, request.params),
          }),
        )
        .catch((error) => post({ id, ok: false, error: errorMessage(error) }))
        .finally(() => inFlight.delete(id));
    } catch (error) {
      post({ id, ok: false, error: errorMessage(error) });
    }
  };

  try {
    port.onDisconnect.addListener(dispose);
    port.onMessage.addListener(onMessage);
  } catch (error) {
    close();
    throw error;
  }

  return dispose;
}
