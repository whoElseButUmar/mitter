import { workspaceStateSchema } from '../schemas/messages';
import { callResult } from '../ui/rpc';
import type { WorkspaceController } from '../ui/workspace-controller';
import type { FileListing, TaskOutput } from '../ui/task-output';
import { ContextArea } from '../ContextArea';
import { createEffect, createSignal, on, For, Show } from 'solid-js';
import { displayTaskName } from '../../../../packages/protocol/src/task-brief';
import { taskPresentation } from '../../../../packages/bridge/src/presentation';
import { Icon } from '../icons';
import { Modal } from '../components';
import { WorkspaceLibrary } from '../WorkspaceLibrary';
import { RenameForm } from '../forms/RenameForm';

export function LibraryDialogs(props: { controller: WorkspaceController }) {
  const {
    snapshot,
    navigation,

    success,
    modal,
    setModal,
    busy,

    bridges,
    applyNavigation,
    rpc,
    tabs,
    output,
  } = props.controller;
  const { library, renameTarget, navigate, menuItems, allProjectTabs } = tabs;
  const close = () => setModal('');

  return (
    <>
      <Show when={modal() === 'library'}>
        <Modal title="Workspace" close={close} wide>
          <WorkspaceLibrary
            view={library().view}
            scopeProjectId={library().scope}
            initialFilter={library().filter}
            state={navigation()}
            projects={snapshot().projects.map((projectEntry) => ({
              id: projectEntry.id,
              label: projectEntry.name,
              subtitle: projectEntry.root,
              status: allProjectTabs().find((tab) => tab.id === projectEntry.id)?.status || 'idle',
            }))}
            tasks={snapshot().workers.map((task) => ({
              id: task.id,
              projectId: task.projectId,
              label: displayTaskName(task),
              subtitle: task.goal,
              status: taskPresentation(
                task,
                bridges().find((status) => status.workerId === task.id),
              ).status,
              createdAt: task.createdAt,
            }))}
            open={(kind, id) => {
              void navigate({ type: 'open', kind, id }).then((next) => {
                if (next) {
                  close();
                }
              });
            }}
            restore={(key) => {
              void navigate({ type: 'restore', key }).then((next) => {
                if (next) {
                  close();
                  success('Tab restored.');
                }
              });
            }}
            clearHistory={async () => {
              const next = await callResult(rpc, workspaceStateSchema, 'workspace.action', {
                action: { type: 'clearHistory' },
              });
              applyNavigation(next);
            }}
            menu={menuItems}
          />
        </Modal>
      </Show>
      <Show keyed when={modal() === 'rename' && renameTarget()}>
        {(target) => (
          <RenameForm
            target={target}
            rpc={rpc}
            busy={busy}

            close={close}
            success={success}
          />
        )}
      </Show>
      <Show when={modal() === 'files' && output.fileLibrary()}>
        {(listing) => <FileBrowser output={output} listing={listing()} close={close} />}
      </Show>
    </>
  );
}

function FileBrowser(props: { output: TaskOutput; listing: FileListing; close: () => void }) {
  const [query, setQuery] = createSignal('');
  createEffect(on(props.output.fileLibrary, () => setQuery('')));

  return (
    <Modal title="Workspace files" close={props.close}>
      <label class="field">
        <span>Find a file</span>
        <input
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          autofocus
          placeholder="Filter by path…"
        />
      </label>
      <div class="file-browser">
        <For
          each={props.listing.files.filter((path) => path.toLowerCase().includes(query().toLowerCase()))}
          fallback={<p class="muted">No matching files.</p>}
        >
          {(path) => (
            <ContextArea items={props.output.fileMenu(props.listing.workerId, path)}>
              <button
                class="file-row"
                onClick={() => {
                  props.output.previewListedFile(props.listing, path);
                }}
              >
                <Icon name="file" size={14} />
                {path}
              </button>
            </ContextArea>
          )}
        </For>
      </div>
    </Modal>
  );
}
