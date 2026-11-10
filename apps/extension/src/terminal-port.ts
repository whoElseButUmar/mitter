import { TERMINAL_PORT } from '../../../packages/terminal/src/protocol.js';
import { documentURL, errorMessage } from './schemas/primitives.js';
import { rpcRequestSchema } from './schemas/messages.js';
import { parseTerminalResult, terminalRequestSchema } from './schemas/terminal.js';
import type { NativeRPC } from './transport/native-host.js';

type TerminalPortDependencies = {
  extensionId: string;
  viewURLs: string[];
  rpc: NativeRPC;
};

/** Human UI-only capability. Each authenticated port receives its own shell ownership token. */
export function bindTerminalPort(
  port: chrome.runtime.Port,
  dependencies: TerminalPortDependencies,
): (() => void) | undefined {
  const sender = port.sender;

  if (
    port.name !== TERMINAL_PORT ||
    sender?.id !== dependencies.extensionId ||
    (sender.frameId !== undefined && sender.frameId !== 0) ||
    (sender.origin !== undefined && sender.origin !== 'chrome-extension://' + dependencies.extensionId) ||
    !sender.url ||
    !dependencies.viewURLs.includes(documentURL(sender.url))
  ) {
    try {
      port.disconnect();
    } catch {}

    return undefined;
  }

  const clientId = crypto.randomUUID();
  let alive = true;
  let pending = 0;
  let tail = Promise.resolve();
  const inFlight = new Set<string>();
  const dispose = (): void => {
    if (!alive) {
      return;
    }

    alive = false;
    inFlight.clear();

    try {
      try {
        port.onMessage.removeListener(onMessage);
      } finally {
        port.onDisconnect.removeListener(dispose);
      }
    } catch (error) {
      console.warn('Miter terminal port listeners could not be detached.', error);
    }

    void tail.finally(() => dependencies.rpc('terminal.disconnect', { clientId })).catch(() => {});
  };
  const close = (): void => {
    dispose();

    try {
      port.disconnect();
    } catch {}
  };

  const post = (message: unknown): void => {
    if (!alive) {
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

    if (!alive || !header.success) {
      return;
    }

    const id = header.data.id;

    if (inFlight.has(id)) {
      return;
    }

    const request = terminalRequestSchema.safeParse(header.data);

    if (!request.success) {
      post({ id, ok: false, error: 'Unsupported terminal request.' });
      return;
    }

    if (pending >= 24) {
      post({ id, ok: false, error: 'Terminal is busy; input was not queued.' });
      return;
    }

    pending++;
    inFlight.add(id);
    const message = request.data;
    const run = async (): Promise<void> => {
      try {
        if (!alive) {
          return;
        }

        const result = await dependencies.rpc(message.method, {
          ...message.params,
          clientId,
        });
        post({
          id,
          ok: true,
          result: parseTerminalResult(message.method, result),
        });

        // A native create/attach may finish after disconnect released existing sessions.
        if (!alive) {
          await dependencies.rpc('terminal.disconnect', { clientId });
        }
      } catch (error) {
        post({ id, ok: false, error: errorMessage(error) });
      } finally {
        pending--;
        inFlight.delete(id);
      }
    };

    if (
      [
        'terminal.write',
        'terminal.resize',
        'terminal.close',
        'terminal.create',
        'terminal.attach',
        'terminal.release',
      ].includes(message.method)
    ) {
      tail = tail.then(run, run);
    } else {
      void run();
    }
  };

  try {
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(dispose);
  } catch (error) {
    close();
    throw error;
  }

  return dispose;
}
