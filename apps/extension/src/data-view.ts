import { auxiliaryPort } from './transport/build-connection.js';
import type { DataResetState } from '../../../packages/bridge/src/data-reset.js';
import { RESET_VIEW_PARAM } from '../../../packages/bridge/src/reset-views.js';
import { resetMessageSchema } from './schemas/messages.js';
import { errorMessage } from './schemas/primitives.js';

let resetting = false;
const writes = new Set<Promise<unknown>>();

/** Late preference writes cannot repopulate storage after the view acknowledges quiescence. */
export function persistLocal(data: Record<string, unknown>): Promise<void> {
  if (resetting) {
    return Promise.reject(new Error('Miter data reset is in progress. No preferences were saved.'));
  }

  const write = chrome.storage.local.set(data);
  writes.add(write);
  void write.then(
    () => writes.delete(write),
    () => writes.delete(write),
  );
  return write;
}

type ResetRequest = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Dedicated reset channel. A lost port reconnects for status only, never destructive replay. */
export function connectResetView(
  onState: (state: DataResetState) => void,
  quiesce: () => void | Promise<void>,
  onConnection: (connected: boolean, error?: string) => void = () => {},
) {
  let port: chrome.runtime.Port | undefined;
  let removePortListeners: (() => void) | undefined;
  let closed = false;
  let completed = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let stopJob: Promise<void> | undefined;
  let marker = '';
  const pending = new Map<string, ResetRequest>();

  const stop = (): Promise<void> => {
    resetting = true;

    if (!stopJob) {
      stopJob = Promise.resolve()
        .then(quiesce)
        .catch((error) => {
          stopJob = undefined;
          throw error;
        });
    }

    return stopJob;
  };

  function restoreMarker(id = marker): void {
    if (!id || marker !== id) {
      return;
    }

    const url = new URL(location.href);

    if (url.searchParams.get(RESET_VIEW_PARAM) === id) {
      url.searchParams.delete(RESET_VIEW_PARAM);
      history.replaceState(history.state, '', url.href);
    }

    marker = '';
  }

  function detachPort(): chrome.runtime.Port | undefined {
    const previous = port;
    port = undefined;
    const removeListeners = removePortListeners;
    removePortListeners = undefined;

    try {
      removeListeners?.();
    } catch {}

    return previous;
  }

  function rejectPending(detail: string): void {
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error(detail));
    }

    pending.clear();
  }

  function disconnected(detail: string): void {
    clearTimeout(readyTimer);
    readyTimer = undefined;
    onConnection(false, detail);
    rejectPending(detail);

    try {
      restoreMarker();
    } catch {
      // The old document may already be unloading.
    }

    if (resetting && !completed) {
      onState({
        phase: 'failed',
        error:
          detail + ' Reconnecting for status only. No successful reset was confirmed; retry when connected.',
      });
    }

    if (!closed && !completed && retryTimer === undefined) {
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined;
          connect();
        },
        Math.min(5000, 250 * 2 ** Math.min(retries++, 5)),
      );
    }
  }

  function connect(): void {
    if (closed || completed || port) {
      return;
    }

    let current: chrome.runtime.Port;

    try {
      current = chrome.runtime.connect({ name: auxiliaryPort('miter-data-view') });
      port = current;
    } catch (error) {
      disconnected(errorMessage(error));
      return;
    }

    const onDisconnect = (): void => {
      if (port !== current || closed) {
        return;
      }

      detachPort();
      disconnected(chrome.runtime.lastError?.message || 'Reset coordinator disconnected.');
    };

    const onMessage = (raw: unknown): void => {
      if (port !== current || closed) {
        return;
      }

      const parsed = resetMessageSchema.safeParse(raw);

      if (!parsed.success) {
        return;
      }

      const message = parsed.data;

      if ('type' in message && message.type === 'reset-state') {
        const state = message.state;
        clearTimeout(readyTimer);
        readyTimer = undefined;
        retries = 0;
        onConnection(true);

        if (state.phase === 'idle' && resetting) {
          onState({
            phase: 'failed',
            error:
              'This view previously stopped for a reset. Retry clearing all data to verify both stores; work has not resumed.',
          });
          return;
        }

        if (state.phase !== 'idle') {
          void stop().catch((error) => {
            if (port === current && !closed) {
              onState({
                phase: 'failed',
                error: 'Could not stop this view: ' + errorMessage(error),
              });
            }
          });
        }

        onState(state);

        if (state.phase === 'complete' && !completed) {
          completed = true;
          reloadTimer = setTimeout(() => location.reload(), 500);
        }
      } else if ('type' in message && message.type === 'reset-quiesce') {
        resetting = true;
        onState({ phase: 'stopping' });
        void (async () => {
          try {
            await stop();
            await Promise.allSettled([...writes]);

            if (port !== current || closed) {
              return;
            }

            localStorage.clear();
            sessionStorage.clear();

            if (localStorage.length || sessionStorage.length) {
              throw new Error('Web Storage is not empty.');
            }

            if (message.identify === true) {
              const url = new URL(location.href);
              url.searchParams.set(RESET_VIEW_PARAM, message.id);
              history.replaceState(history.state, '', url.href);
              marker = message.id;
            }

            current.postMessage({
              type: 'reset-ack',
              id: message.id,
              ok: true,
            });
          } catch (error) {
            if (port !== current || closed) {
              return;
            }

            try {
              current.postMessage({
                type: 'reset-ack',
                id: message.id,
                ok: false,
                error: errorMessage(error),
              });
            } catch {
              onState({
                phase: 'failed',
                error: 'The view stopped but could not confirm cleanup. Reopen Miter and retry.',
              });
            }
          }
        })();
      } else if ('type' in message && message.type === 'reset-identified') {
        try {
          restoreMarker(message.id);
        } catch {
          // This one-time marker carries no persisted data or reset authority.
        }
      } else if ('ok' in message) {
        const job = pending.get(message.id);

        if (!job) {
          return;
        }

        clearTimeout(job.timer);
        pending.delete(message.id);

        if (message.ok) {
          job.resolve();
        } else {
          job.reject(new Error(message.error || 'Reset failed.'));
        }
      }
    };

    removePortListeners = () => {
      try {
        current.onMessage.removeListener(onMessage);
      } finally {
        current.onDisconnect.removeListener(onDisconnect);
      }
    };

    try {
      current.onDisconnect.addListener(onDisconnect);
      current.onMessage.addListener(onMessage);
    } catch (error) {
      detachPort();

      try {
        current.disconnect();
      } catch {}

      disconnected(errorMessage(error));
      return;
    }

    readyTimer = setTimeout(() => {
      if (port !== current) {
        return;
      }

      detachPort();

      try {
        current.disconnect();
      } catch {}

      disconnected('The reset coordinator did not respond.');
    }, 10000);
  }

  connect();

  return {
    clear(confirmation: string): Promise<void> {
      const current = port;

      if (confirmation !== 'CLEAR') {
        return Promise.reject(new Error('Type exactly CLEAR to delete all Miter application data.'));
      }

      if (closed || !current) {
        return Promise.reject(new Error('The reset coordinator is reconnecting. Wait, then retry.'));
      }

      if (pending.size) {
        return Promise.reject(new Error('A reset request is already waiting for confirmation.'));
      }

      return new Promise<void>((resolve, reject) => {
        const id = crypto.randomUUID();
        // Coordinator stages have their own bounded deadlines. Do not time out midway through deletion.
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('No complete reset acknowledgement. Reopen Miter and retry; it stays locked.'));
        }, 600000);
        pending.set(id, { resolve, reject, timer });

        try {
          current.postMessage({ type: 'reset-start', id, confirmation });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close(): void {
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(readyTimer);
      clearTimeout(reloadTimer);
      rejectPending('The Miter view closed before a complete reset acknowledgement.');

      try {
        restoreMarker();
      } catch {}

      const previous = detachPort();

      try {
        previous?.disconnect();
      } catch {}
    },
  };
}
