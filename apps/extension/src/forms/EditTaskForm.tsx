import { Show } from 'solid-js';
import { Field, Modal } from '../components';
import { createTaskEditDraft, type TaskEditDraftOptions } from '../ui/dialog-forms';

export function EditTaskForm(props: TaskEditDraftOptions) {
  const draft = createTaskEditDraft(props);

  return (
    <Modal title="Edit task" close={draft.close}>
      <form
        class="creation-form"
        aria-busy={draft.busy()}
        onSubmit={(event) => {
          event.preventDefault();
          return draft.save();
        }}
      >
        <Field label="Title">
          <input
            autofocus
            required
            disabled={draft.busy()}
            maxLength={60}
            value={draft.title()}
            onInput={(event) => draft.setTitle(event.currentTarget.value)}
          />
        </Field>
        <Field label="Task details">
          <textarea
            required
            rows={5}
            maxLength={4000}
            readOnly={!props.canEditDetails()}
            disabled={draft.busy()}
            value={draft.goal()}
            onInput={(event) => draft.setGoal(event.currentTarget.value)}
          />
        </Field>
        <Show when={!props.canEditDetails()}>
          <p class="muted small">Task details are locked after the first run.</p>
        </Show>
        <Show when={draft.error()}>
          <p class="error" role="alert">
            {draft.error()}
          </p>
        </Show>
        <div class="button-row end">
          <button type="button" onClick={draft.close}>
            Cancel
          </button>
          <button class="primary" type="submit" disabled={draft.busy() || !draft.title().trim()}>
            Save changes
          </button>
        </div>
      </form>
    </Modal>
  );
}
