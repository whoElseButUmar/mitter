import { Modal } from '../components';
import { createNotificationsDraft, type NotificationsDraftOptions } from '../ui/dialog-forms';
import { Show } from 'solid-js';

export function NotificationsForm(props: NotificationsDraftOptions & { playSound: () => Promise<void> }) {
  const draft = createNotificationsDraft(props);
  const { preferences, setPreferences } = draft;

  return (
    <Modal title="Notifications" close={draft.close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          return draft.save();
        }}
      >
        <label class="checkline">
          <input
            type="checkbox"
            checked={preferences().enabled}
            onChange={(event) =>
              setPreferences((previous) => ({
                ...previous,
                enabled: event.currentTarget.checked,
              }))
            }
          />
          <span>Desktop notifications for completion and attention</span>
        </label>
        <label class="checkline">
          <input
            type="checkbox"
            checked={preferences().sound}
            onChange={(event) =>
              setPreferences((previous) => ({
                ...previous,
                sound: event.currentTarget.checked,
              }))
            }
          />
          <span>Play a quiet chime while a Miter view is open</span>
        </label>
        <p class="muted small">
          Click a notification to open its task. Your operating system’s notification settings also apply.
        </p>
        <Show when={draft.error()}>
          <p class="error" role="alert">
            {draft.error()}
          </p>
        </Show>
        <div class="button-row end">
          <button type="button" onClick={() => void props.playSound()}>
            Test sound
          </button>
          <button class="primary" disabled={draft.busy()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
