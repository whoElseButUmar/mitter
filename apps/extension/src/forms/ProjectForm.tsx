import { Show } from 'solid-js';
import { createProjectDraft, type ProjectDraftOptions } from '../ui/dialog-forms';
import { syncInputValidity } from '../ui/dom';
import { Field, Modal } from '../components';
import { Icon } from '../icons';

export function ProjectForm(props: ProjectDraftOptions) {
  const draft = createProjectDraft(props);
  const { busy, error, root, setRoot, name, setName, choose } = draft;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    return draft.save();
  };

  return (
    <Modal title="Open a project" close={draft.close}>
      <form onSubmit={submit} aria-busy={busy()}>
        <p class="muted">Choose the folder Miter should work in.</p>
        <button type="button" class="folder-picker full" onClick={choose} disabled={busy()}>
          <Icon name="folder" />
          <Show when={busy()} fallback={'Choose Folder…'}>
            {'Opening…'}
          </Show>
        </button>
        <Field label="Folder path">
          <input
            required
            value={root()}
            onInput={(event) => {
              setRoot(event.currentTarget.value);
              syncInputValidity(event.currentTarget);
            }}
            onBlur={(event) => syncInputValidity(event.currentTarget)}
            onInvalid={(event) => event.currentTarget.setAttribute('aria-invalid', 'true')}
            placeholder="Or enter an absolute folder path"
            spellcheck={false}
          />
        </Field>
        <Field label="Project name">
          <input
            required
            value={name()}
            onInput={(event) => {
              setName(event.currentTarget.value);
              syncInputValidity(event.currentTarget);
            }}
            onBlur={(event) => syncInputValidity(event.currentTarget)}
            onInvalid={(event) => event.currentTarget.setAttribute('aria-invalid', 'true')}
            maxLength={60}
            placeholder="My project"
          />
        </Field>
        <p class="muted small">
          Only this folder is registered. Project commands still run with your computer’s permissions.
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
          <button class="primary" type="submit" disabled={busy()}>
            Open project
          </button>
        </div>
      </form>
    </Modal>
  );
}
