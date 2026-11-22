import { Modal } from '../components';
import { createNotificationsDraft, type NotificationsDraftOptions } from '../ui/dialog-forms';
import { notificationPreferencesSchema, type NotificationPreferences } from '../schemas/messages';
import { errorMessage } from '../schemas/primitives';
import { callResult } from '../ui/rpc';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';

export function NotificationsSettings(
  props: Omit<NotificationsDraftOptions, 'preferences'> & { playSound: () => Promise<void> },
) {
  const [preferences, setPreferences] = createSignal<NotificationPreferences>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await callResult(props.rpc, notificationPreferencesSchema, 'notifications.get');
      if (alive) {
        setPreferences(result);
      }
    } catch (error) {
      if (alive) {
        setError(errorMessage(error));
      }
    } finally {
      if (alive) {
        setLoading(false);
      }
    }
  };
  onMount(() => void load());

  return (
    <Show
      keyed
      when={preferences()}
      fallback={
        <Modal title="Notifications" close={props.close}>
          <Show
            when={loading()}
            fallback={
              <p class="error" role="alert">
                {error()}
              </p>
            }
          >
            <p role="status">Loading notification settings…</p>
          </Show>
          <Show when={!loading()}>
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </Show>
        </Modal>
      }
    >
      {(saved) => <NotificationsForm {...props} preferences={saved} />}
    </Show>
  );
}

export function NotificationsForm(props: NotificationsDraftOptions & { playSound: () => Promise<void> }) {
  const draft = createNotificationsDraft(props);
  const { preferences, setPreferences } = draft;

  return (
    <Modal title="Notifications" close={draft.close}>
      <form
        aria-busy={draft.busy()}
        onSubmit={(event) => {
          event.preventDefault();
          return draft.save();
        }}
      >
        <label class="checkline">
          <input
            type="checkbox"
            disabled={draft.busy()}
            checked={preferences().enabled}
            onChange={(event) =>
              setPreferences((previous) => ({
                ...previous,
                enabled: event.currentTarget.checked,
              }))
            }
          />
          <span>Desktop notifications</span>
        </label>
        <label class="checkline">
          <input
            type="checkbox"
            disabled={draft.busy()}
            checked={preferences().sound}
            onChange={(event) =>
              setPreferences((previous) => ({
                ...previous,
                sound: event.currentTarget.checked,
              }))
            }
          />
          <span>Play a sound</span>
        </label>
        <Show when={draft.error()}>
          <p class="error" role="alert">
            {draft.error()}
          </p>
        </Show>
        <div class="button-row end">
          <button type="button" disabled={draft.busy()} onClick={() => void props.playSound()}>
            Test sound
          </button>
          <button class="primary" disabled={draft.busy()}>
            <Show when={draft.busy()} fallback="Save changes">
              Saving…
            </Show>
          </button>
        </div>
      </form>
    </Modal>
  );
}
