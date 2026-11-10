import { Modal } from '../components';
import { createContextDraft, type ContextDraftOptions } from '../ui/dialog-forms';
import { Show } from 'solid-js';

export function ContextForm(props: ContextDraftOptions) {
  const draft = createContextDraft(props);
  const { mission, setMission, conventions, setConventions } = draft;

  return (
    <Modal title="Project context" close={draft.close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          return draft.save();
        }}
      >
        <label class="field">
          <span>Ultimate project goal</span>
          <textarea
            maxlength="4000"
            rows="3"
            value={mission()}
            onInput={(event) => setMission(event.currentTarget.value)}
          />
        </label>
        <label class="field">
          <span>Shared conventions</span>
          <textarea
            maxlength="4000"
            rows="3"
            value={conventions()}
            onInput={(event) => setConventions(event.currentTarget.value)}
          />
        </label>
        <p class="muted small">
          These notes accompany each task. Existing task requests and approval rules are unchanged.
        </p>
        <Show when={draft.error()}>
          <p class="error" role="alert">
            {draft.error()}
          </p>
        </Show>
        <div class="button-row end">
          <button type="button" onClick={draft.close}>
            Cancel
          </button>
          <button class="primary" disabled={draft.busy()}>
            Save context
          </button>
        </div>
      </form>
    </Modal>
  );
}
