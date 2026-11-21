import { Show } from 'solid-js';
import { createProjectDraft, type ProjectDraftOptions } from '../ui/dialog-forms';
import { syncInputValidity } from '../ui/dom';
import { Field, Modal } from '../components';
import { Icon } from '../icons';
import { projectFolderNameSchema } from '../../../../packages/protocol/src/rpc';

export function ProjectForm(props: ProjectDraftOptions) {
  const draft = createProjectDraft(props);
  let picker: HTMLButtonElement | undefined;
  let advanced: HTMLDetailsElement | undefined;
  const { busy, error, root, setRoot, name, setName, choose } = draft;
  const creating = () => draft.mode() === 'create';
  const title = () => {
    if (creating()) {
      return 'New project';
    }
    return 'Open project';
  };
  const pickerLabel = () => {
    if (draft.choosing()) {
      return 'Choosing folder…';
    }
    if (creating()) {
      if (root()) {
        return 'Change location…';
      }
      return 'Choose location…';
    }
    if (root()) {
      return 'Change folder…';
    }
    return 'Choose folder…';
  };
  const pathLabel = () => {
    if (creating()) {
      return 'Parent folder path';
    }
    return 'Folder path';
  };
  const submitLabel = () => {
    if (draft.saving()) {
      if (creating()) {
        return 'Creating…';
      }
      return 'Opening…';
    }
    if (creating()) {
      return 'Create project';
    }
    return 'Open project';
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    await draft.save();
    if (error() && !root().trim() && picker?.isConnected) {
      picker.focus();
    }
  };

  const chooseFolder = async () => {
    await choose();
    if (error() && advanced?.isConnected) {
      advanced.open = true;
    }
  };

  return (
    <Modal title={title()} close={draft.close}>
      <form class="creation-form" onSubmit={submit} aria-busy={busy()}>
        <Show when={props.create}>
          <div class="project-mode-switch" role="group" aria-label="Project action">
            <button
              type="button"
              aria-pressed={creating()}
              disabled={busy()}
              onClick={() => draft.setMode('create')}
            >
              Create new
            </button>
            <button
              type="button"
              aria-pressed={!creating()}
              disabled={busy()}
              onClick={() => draft.setMode('open')}
            >
              Open existing
            </button>
          </div>
        </Show>
        <Show when={creating()}>
          <Field label="Folder name (required)">
            <input
              name="folderName"
              required
              autofocus
              disabled={busy()}
              value={draft.folderName()}
              onInput={(event) => {
                draft.setFolderName(event.currentTarget.value);
                event.currentTarget.setCustomValidity('');
                syncInputValidity(event.currentTarget);
              }}
              onBlur={(event) => {
                const result = projectFolderNameSchema.safeParse(event.currentTarget.value);
                let message = '';
                if (!result.success) {
                  message = result.error.issues[0]?.message || 'Enter one folder name.';
                }
                event.currentTarget.setCustomValidity(message);
                syncInputValidity(event.currentTarget);
              }}
              onInvalid={(event) => event.currentTarget.setAttribute('aria-invalid', 'true')}
              maxLength={80}
              placeholder="My project"
              spellcheck={false}
              autocapitalize="none"
              autocomplete="off"
            />
          </Field>
        </Show>
        <button
          ref={picker}
          type="button"
          class="folder-picker full"
          onClick={chooseFolder}
          disabled={busy()}
          autofocus={!creating()}
        >
          <Icon name="folder" />
          {pickerLabel()}
        </button>
        <Show when={root()}>
          <p class="project-folder-selection">{root()}</p>
        </Show>
        <details ref={advanced} class="form-advanced project-options">
          <summary class="disclosure-summary">
            <Icon name="down" />
            Advanced options
          </summary>
          <Field label={pathLabel()}>
            <input
              name="root"
              disabled={busy()}
              value={root()}
              onInput={(event) => setRoot(event.currentTarget.value)}
              maxLength={2000}
              placeholder="Absolute folder path"
              spellcheck={false}
              autocapitalize="none"
              autocomplete="off"
            />
          </Field>
          <Field label="Display name (optional)">
            <input
              name="name"
              disabled={busy()}
              value={name()}
              onInput={(event) => {
                setName(event.currentTarget.value);
                syncInputValidity(event.currentTarget);
              }}
              onBlur={(event) => syncInputValidity(event.currentTarget)}
              onInvalid={(event) => {
                if (advanced) {
                  advanced.open = true;
                }
                event.currentTarget.setAttribute('aria-invalid', 'true');
              }}
              maxLength={60}
              placeholder="Uses the folder name"
            />
          </Field>
        </details>
        <p class="task-disclosure">Commands run with your computer’s permissions.</p>
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
            {submitLabel()}
          </button>
        </div>
      </form>
    </Modal>
  );
}
