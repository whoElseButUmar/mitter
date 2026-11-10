import { Show, type Accessor } from 'solid-js';
import { Modal } from '../components';
import { createRenameDraft, type RenameDraftOptions } from '../ui/dialog-forms';

export function RenameForm(props: RenameDraftOptions & { busy: Accessor<boolean> }) {
  const draft = createRenameDraft(props);
  const { name, setName, error } = draft;

  return (
    <Modal title={'Rename ' + draft.target.kind} close={draft.close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          return draft.save();
        }}
      >
        <label class="field">
          <span>Name</span>
          <input
            autofocus
            required
            maxLength={60}
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <p class="muted small">
          Only the display name changes. Your files, conversation and task progress are kept.
        </p>
        <Show when={error()}>
          <p class="error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="button-row end">
          <button type="button" onClick={draft.close}>
            Cancel
          </button>
          <button class="primary" disabled={props.busy() || draft.busy() || !name().trim()}>
            Save name
          </button>
        </div>
      </form>
    </Modal>
  );
}
