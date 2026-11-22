import { workspaceStateSchema } from '../schemas/messages';
import { callResult } from '../ui/rpc';
import type { WorkspaceController } from '../ui/workspace-controller';
import type { FileListing, TaskOutput } from '../ui/task-output';
import { ContextArea } from '../ContextArea';
import { createEffect, createSignal, on, For, Show } from 'solid-js';
import { canEditTaskDetails, displayTaskName } from '../../../../packages/protocol/src/task-brief';
import { taskPresentation } from '../../../../packages/bridge/src/presentation';
import { Icon } from '../icons';
import { Modal } from '../components';
import { WorkspaceLibrary } from '../WorkspaceLibrary';
import { RenameForm } from '../forms/RenameForm';
import { EditTaskForm } from '../forms/EditTaskForm';

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
        {(target) => {
          if (target.kind === 'project') {
            return <RenameForm target={target} rpc={rpc} busy={busy} close={close} success={success} />;
          }
          const task = snapshot().workers.find((candidate) => candidate.id === target.id);
          if (!task) {
            return;
          }
          const canEditDetails = () => {
            const state = snapshot();
            const current = state.workers.find((candidate) => candidate.id === task.id);
            return (
              !!current &&
              current.runId === task.runId &&
              canEditTaskDetails(current) &&
              !state.bridgeProgress?.some((progress) => progress.workerId === task.id) &&
              !bridges().some((bridge) => bridge.workerId === task.id && bridge.active)
            );
          };
          return (
            <EditTaskForm
              task={task}
              canEditDetails={canEditDetails}
              rpc={rpc}
              close={close}
              success={success}
            />
          );
        }}
      </Show>
      <Show when={modal() === 'files' && output.fileLibrary()}>
        {(listing) => (
          <FileBrowser
            output={output}
            listing={listing()}
            close={close}
            folderDisabled={!props.controller.connected() || busy()}
            reveal={(current) => {
              if (
                props.controller.connected() &&
                output.fileLibrary() === current &&
                props.controller.selected() === current.workerId
              ) {
                void props.controller.action('worker.reveal', { workerId: current.workerId });
              }
            }}
          />
        )}
      </Show>
    </>
  );
}

function FileBrowser(props: {
  output: TaskOutput;
  listing: FileListing;
  close: () => void;
  folderDisabled: boolean;
  reveal: (listing: FileListing) => void;
}) {
  const [query, setQuery] = createSignal('');
  let filter: HTMLInputElement | undefined;
  createEffect(on(props.output.fileLibrary, () => setQuery('')));

  return (
    <Modal title="Files" close={props.close}>
      <label class="field">
        <span>Find a file</span>
        <input
          ref={(element) => {
            filter = element;
          }}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          autofocus
          placeholder="Filter by path…"
        />
      </label>
      <div class="file-browser">
        <For
          each={props.listing.files.filter((path) => path.toLowerCase().includes(query().toLowerCase()))}
          fallback={
            <Show
              when={props.listing.files.length}
              fallback={<p class="muted">No files in this workspace yet.</p>}
            >
              <p class="muted" role="status">
                No matching files.
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  filter?.focus();
                }}
              >
                Clear filter
              </button>
            </Show>
          }
        >
          {(path) => (
            <ContextArea items={props.output.fileMenu(props.listing.workerId, path)}>
              <button
                class="file-row"
                onClick={() => {
                  props.output.previewListedFile(props.listing, path);
                }}
              >
                <Icon name="file" />
                {path}
              </button>
            </ContextArea>
          )}
        </For>
      </div>
      <div class="button-row end file-browser-actions">
        <button type="button" disabled={props.folderDisabled} onClick={() => props.reveal(props.listing)}>
          <Icon name="folder" />
          Open folder
        </button>
      </div>
    </Modal>
  );
}
