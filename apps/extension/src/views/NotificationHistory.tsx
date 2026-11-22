import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { Modal } from '../components';
import { notificationHistorySchema, type NotificationHistory } from '../schemas/messages';
import { errorMessage } from '../schemas/primitives';
import { callResult } from '../ui/rpc';
import type { WorkspaceController } from '../ui/workspace-controller';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function NotificationHistoryDialog(props: { controller: WorkspaceController }) {
  const { connected, snapshot, rpc, notificationRevision, openNotifiedTask, showNotifications, setModal } =
    props.controller;
  const [entries, setEntries] = createSignal<NotificationHistory>();
  const [loadError, setLoadError] = createSignal('');
  const [openError, setOpenError] = createSignal('');
  const [opening, setOpening] = createSignal(false);
  let revision = 0;
  let alive = true;

  async function load(): Promise<void> {
    const request = ++revision;
    setLoadError('');
    try {
      const history = await callResult(rpc, notificationHistorySchema, 'notifications.history');
      if (alive && revision === request) {
        setEntries(history);
      }
    } catch (error) {
      if (alive && revision === request) {
        setLoadError(errorMessage(error));
      }
    }
  }

  async function open(workerId: string): Promise<void> {
    setOpening(true);
    setOpenError('');
    try {
      await openNotifiedTask(workerId);
    } catch (error) {
      if (alive) {
        setOpenError(errorMessage(error));
      }
    } finally {
      if (alive) {
        setOpening(false);
      }
    }
  }

  createEffect(() => {
    notificationRevision();
    void load();
  });
  onCleanup(() => {
    alive = false;
  });

  const taskExists = (workerId: string) => snapshot().workers.some((worker) => worker.id === workerId);

  return (
    <Modal title="Notification history" close={() => setModal('')}>
      <Show when={loadError()}>
        <p class="error" role="alert">
          {loadError()}
        </p>
        <button type="button" onClick={() => void load()}>
          Retry
        </button>
      </Show>
      <Show when={openError()}>
        <p class="error" role="alert">
          {openError()}
        </p>
      </Show>
      <Show when={!entries() && !loadError()}>
        <p class="muted" role="status">
          Loading notifications…
        </p>
      </Show>
      <Show when={entries()}>
        {(history) => (
          <Show when={history().length} fallback={<p class="muted">No notifications yet.</p>}>
            <ol class="notification-history" aria-label="Recent task notifications" aria-busy={opening()}>
              <For each={history()}>
                {(entry) => (
                  <li>
                    <button
                      type="button"
                      class="notification-history-entry"
                      disabled={opening() || !connected() || !taskExists(entry.workerId)}
                      onClick={() => void open(entry.workerId)}
                    >
                      <span>{entry.message}</span>
                      <small>
                        <time datetime={new Date(entry.at).toISOString()}>{dateFormat.format(entry.at)}</time>
                        <Show when={connected() && !taskExists(entry.workerId)}> · Task removed</Show>
                      </small>
                    </button>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        )}
      </Show>
      <div class="button-row end">
        <button type="button" disabled={!connected() || opening()} onClick={() => void showNotifications()}>
          Notification settings
        </button>
      </div>
    </Modal>
  );
}
