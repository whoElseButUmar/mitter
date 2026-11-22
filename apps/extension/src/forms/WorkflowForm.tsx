import { createSignal, Index, onMount, Show } from 'solid-js';
import { Field, Modal } from '../components';
import { createProjectWorkflows } from '../ui/project-workflows';
import type { ViewRPC } from '../ui/rpc';

export function WorkflowForm(props: { projectId: string; rpc: ViewRPC; close: () => void }) {
  const { state, pending, error, run } = createProjectWorkflows(props.projectId, props.rpc);
  const [name, setName] = createSignal('');
  const [restart, setRestart] = createSignal(false);
  const [notice, setNotice] = createSignal('');
  const [removeId, setRemoveId] = createSignal('');
  const load = () => run({ kind: 'list' });
  onMount(() => void load());

  async function record() {
    setNotice('');
    setRemoveId('');
    if (await run({ kind: 'record' })) {
      setName('');
      setRestart(false);
    }
  }

  async function expectElement() {
    if (await run({ kind: 'expect' })) {
      setNotice('Click the expected element in the recording window, then save here.');
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = name().trim();
    if (trimmed && (await run({ kind: 'save', name: trimmed, verifyAfterRestart: restart() }))) {
      setNotice('Workflow saved.');
    }
  }

  async function cancel() {
    if (await run({ kind: 'cancel' })) {
      setNotice('Recording cancelled.');
    }
  }

  async function replay(id: string) {
    setNotice('');
    if (await run({ kind: 'replay', id })) {
      const finished = state()?.workflows.find((workflow) => workflow.id === id);
      if (finished?.lastResult) {
        let outcome = ' failed.';
        if (finished.lastResult.ok) {
          outcome = ' passed.';
        }
        setNotice(finished.name + outcome);
      }
    }
  }

  async function remove(id: string) {
    if (await run({ kind: 'delete', id })) {
      setRemoveId('');
      setNotice('Workflow removed.');
    }
  }

  const progress = () => {
    if (error()) {
      return '';
    }
    switch (pending()) {
      case 'record':
        return 'Opening the recording window…';
      case 'replay':
        return 'Replaying workflow…';
      case 'save':
        return 'Saving workflow…';
      case 'list':
        return 'Loading workflows…';
      default:
        return notice();
    }
  };

  return (
    <Modal title="Workflows" close={props.close}>
      <Show when={error()}>
        <p role="alert" class="error">
          {error()}
        </p>
        <button type="button" disabled={!!pending()} onClick={load}>
          Refresh workflows
        </button>
      </Show>
      <p role="status" class="small muted workflow-notice">
        {progress()}
      </p>
      <Show when={state()}>
        {(current) => (
          <>
            <Show
              when={current().recording}
              fallback={
                <>
                  <p class="muted small">
                    Record in a separate Chrome window using a disposable copy of your app. Use sample data.
                  </p>
                  <button type="button" class="primary" disabled={!!pending()} onClick={record}>
                    Record workflow
                  </button>
                </>
              }
            >
              <p class="muted small">
                Use the recording window to perform the steps. Pick an element you expect to see at the end.
              </p>
              <form onSubmit={save}>
                <button type="button" disabled={!!pending()} onClick={expectElement}>
                  Pick expected element
                </button>
                <Field label="Workflow name">
                  <input
                    type="text"
                    required
                    maxlength="80"
                    value={name()}
                    onInput={(event) => setName(event.currentTarget.value)}
                  />
                </Field>
                <label class="checkline">
                  <input
                    type="checkbox"
                    checked={restart()}
                    onChange={(event) => setRestart(event.currentTarget.checked)}
                  />
                  Verify after server restart
                </label>
                <div class="button-row">
                  <button class="primary" disabled={!!pending() || !name().trim()}>
                    Save workflow
                  </button>
                  <button type="button" disabled={!!pending()} onClick={cancel}>
                    Cancel recording
                  </button>
                </div>
              </form>
            </Show>
            <Show when={current().workflows.length}>
              <ul class="saved-entries workflow-list" aria-label="Saved workflows">
                <Index each={current().workflows}>
                  {(item) => (
                    <li>
                      <strong>{item().name}</strong>
                      <Show when={item().verifyAfterRestart}>
                        <span class="small muted">Includes server restart</span>
                      </Show>
                      <Show
                        when={item().lastResult}
                        fallback={<span class="small muted">Awaiting first replay</span>}
                      >
                        {(result) => (
                          <details open={!result().ok}>
                            <summary>
                              <Show when={result().ok} fallback="Failed">
                                Passed
                              </Show>
                            </summary>
                            <p class="small">{result().detail}</p>
                          </details>
                        )}
                      </Show>
                      <Show
                        when={removeId() === item().id}
                        fallback={
                          <div class="button-row">
                            <button
                              type="button"
                              aria-label={'Replay ' + item().name}
                              disabled={!!pending() || current().recording}
                              onClick={() => replay(item().id)}
                            >
                              Replay
                            </button>
                            <button
                              type="button"
                              aria-label={'Remove ' + item().name}
                              disabled={!!pending() || current().recording}
                              onClick={() => setRemoveId(item().id)}
                            >
                              Remove
                            </button>
                          </div>
                        }
                      >
                        <p>Remove {item().name} from this project’s checks?</p>
                        <div class="button-row">
                          <button type="button" disabled={!!pending()} onClick={() => setRemoveId('')}>
                            Keep workflow
                          </button>
                          <button type="button" disabled={!!pending()} onClick={() => remove(item().id)}>
                            Confirm removal
                          </button>
                        </div>
                      </Show>
                    </li>
                  )}
                </Index>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </Modal>
  );
}
