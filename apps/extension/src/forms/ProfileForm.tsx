import { profileSchema } from '../../../../packages/protocol/src/index';

import { requireElement } from '../ui/dom';
import { Show } from 'solid-js';
import { createProfileDraft, type ProfileDraftOptions } from '../ui/dialog-forms';
import { Field, Modal } from '../components';

export function ProfileForm(props: ProfileDraftOptions) {
  const draft = createProfileDraft(props);
  const { error, busy } = draft;

  let id: HTMLInputElement | undefined;
  let label: HTMLInputElement | undefined;
  let program: HTMLInputElement | undefined;
  let args: HTMLTextAreaElement | undefined;
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    return draft.save(() => ({
      id: requireElement(id, 'forms id').value,
      label: requireElement(label, 'forms label').value,
      program: requireElement(program, 'forms program').value,
      args: profileSchema.shape.args.parse(JSON.parse(requireElement(args, 'forms args').value)),
      timeoutMs: 120000,
    }));
  };

  return (
    <Modal title="Register a command" close={draft.close}>
      <form onSubmit={submit}>
        <p class="muted">
          Only you can register programs. Models can request an existing profile, never supply a shell
          command.
        </p>
        <div class="form-row">
          <Field label="Profile ID">
            <input
              ref={(element) => {
                id = element;
              }}
              required
              pattern="[a-zA-Z0-9_-]+"
              value="test"
            />
          </Field>
          <Field label="Display name">
            <input
              ref={(element) => {
                label = element;
              }}
              required
              value="Run tests"
            />
          </Field>
        </div>
        <Field label="Executable">
          <input
            ref={(element) => {
              program = element;
            }}
            required
            value="node"
            spellcheck={false}
          />
        </Field>
        <Field
          label="Arguments (JSON array)"
          hint={
            'For npm on macOS/Linux: executable npm, arguments ["test"]. Windows setup notes explain the shell-free equivalent.'
          }
        >
          <textarea
            ref={(element) => {
              args = element;
            }}
            required
            rows={3}
            class="mono"
            spellcheck={false}
          >
            {'["--test"]'}
          </textarea>
        </Field>
        <p class="notice">
          A test script can modify files, access the network, or run other programs. Miter requests approval
          before executing it.
        </p>
        <Show when={error()}>
          <p class="error" role="alert">
            {error()}
          </p>
        </Show>
        <button type="submit" class="primary full" disabled={busy()}>
          Register profile
        </button>
      </form>
    </Modal>
  );
}
