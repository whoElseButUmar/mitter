import { reloadWorkspace } from '../workspace-reload';
import { errorMessage } from '../schemas/primitives';
import { LibraryDialogs } from './LibraryDialogs';
import { folderPickSchema } from '../ui/rpc-results';
import { projectSchema, workerSchema } from '../schemas/host-results';
import { callResult } from '../ui/rpc';
import { SettingsDialogs } from './SettingsDialogs';
import type { WorkspaceController } from '../ui/workspace-controller';
import { HealthPanel, ChangeReview } from '../ReleaseTools';
import { ContextArea } from '../ContextArea';
import { ReplyRecovery } from '../ReplyRecovery';
import { For, Show } from 'solid-js';
import { SetupPanel } from './SetupPanel';

import { Icon } from '../icons';
import { Modal } from '../components';
import { ProjectForm, WorkerForm } from '../forms';
import { startCreatedTask } from '../forms/WorkerForm';
import { AutomationForm } from '../AutomationForm';

function OpenProjectDialog(props: { controller: WorkspaceController }) {
  const controller = props.controller;
  const navigationRevision = controller.navigation().revision;
  const initialMode = () => {
    if (controller.modal() === 'project-create') {
      return 'create';
    }
    return 'open';
  };

  return (
    <ProjectForm
      initialMode={initialMode()}
      close={() => controller.setModal('')}
      pick={(purpose) => callResult(controller.rpc, folderPickSchema, 'project.pickFolder', { purpose })}
      save={(fields) => callResult(controller.rpc, projectSchema, 'project.add', fields)}
      create={(fields) => callResult(controller.rpc, projectSchema, 'project.create', fields)}
      opened={(added) => {
        controller.setSnapshot((state) => {
          if (state.projects.some((project) => project.id === added.id)) {
            return state;
          }
          return { ...state, projects: [...state.projects, added] };
        });
        if (controller.navigation().revision === navigationRevision) {
          controller.tabs.chooseProject(added.id);
        }
        controller.success('Project opened: ' + added.name);
      }}
    />
  );
}

export function WorkspaceDialogs(props: { controller: WorkspaceController }) {
  const {
    snapshot,
    setSnapshot,
    selected,
    formProjectId,
    success,
    setNotice,
    modal,
    setModal,
    textValue,
    handoff,
    setHandoff,
    busy,
    output,
    followupHistory,
    automationTarget,
    replyWorker,
    tabs,
    rpc,
    copy,
    rewriteDraft,
    resendPending,
    readHandoffClipboard,
    showText,
    importBatch,
  } = props.controller;

  const reviewScope = (): { path?: string } => {
    const path = output.file();

    if (path) {
      return { path };
    }

    return {};
  };

  const textDialogTitle = () => {
    if (modal() === 'report') {
      return 'Review report';
    }

    return 'Setup prompt';
  };

  return (
    <>
      <Show when={modal() === 'followups'}>
        <Modal title="Follow-up history" close={() => setModal('')}>
          <div class="followup-history">
            <For each={followupHistory()} fallback={<p class="muted">No follow-ups yet.</p>}>
              {(followup) => (
                <ContextArea
                  items={[
                    {
                      id: 'copy',
                      label: 'Copy request',
                      run: () => void copy(followup.instruction),
                    },
                  ]}
                >
                  <article>
                    <strong>{followup.status}</strong>
                    <time>{new Date(followup.createdAt).toLocaleString()}</time>
                    <p>{followup.instruction}</p>
                    <Show when={followup.selection}>
                      <small>{followup.selection?.path} · code selection</small>
                    </Show>
                    <Show when={followup.error}>
                      <p class="error">{followup.error}</p>
                    </Show>
                  </article>
                </ContextArea>
              )}
            </For>
          </div>
        </Modal>
      </Show>

      <Show when={modal() === 'resend'}>
        <Modal title="Resend the pending prompt" close={() => setModal('')} wide>
          <p class="muted">
            Miter is still watching for a reply. Resend sends these instructions with a new reply ID and uses
            one turn.
          </p>
          <textarea
            class="code-input"
            rows={8}
            readonly
            value={textValue()}
            aria-label="Exact pending prompt"
          />
          <div class="button-row end">
            <button onClick={() => copy(textValue())}>Copy prompt</button>
            <button onClick={() => setModal('')}>Cancel</button>
            <button class="primary" disabled={busy()} onClick={resendPending}>
              Resend once
            </button>
          </div>
        </Modal>
      </Show>
      <Show when={modal() === 'project' || modal() === 'project-create'}>
        <OpenProjectDialog controller={props.controller} />
      </Show>
      <Show when={modal() === 'worker'}>
        <WorkerForm
          rpc={rpc}
          rewrite={rewriteDraft}
          projects={snapshot().projects}
          scopedProjectId={formProjectId()}
          selection={props.controller.pickedElements()}
          close={() => setModal('')}
          authorize={() =>
            chrome.permissions.request({
              origins: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
            })
          }
          create={async (projectEntry) => {
            const created = await callResult(rpc, workerSchema, 'worker.create', projectEntry);
            setSnapshot((state) => {
              let workers = state.workers;
              if (!workers.some((task) => task.id === created.id)) {
                workers = [...workers, created];
              }

              return { ...state, workers };
            });
            return created;
          }}
          created={(id) => {
            tabs.choose(id);
            success('Task created.');
          }}
          start={(id, mode, expectedRun) => startCreatedTask(rpc, id, mode, expectedRun)}
          failed={(error) => setNotice(errorMessage(error))}
          stop={(id) =>
            rpc('bridge.halt', {
              workerId: id,
              id: crypto.randomUUID(),
            })
          }
        />
      </Show>

      <Show when={modal() === 'automation' && automationTarget()} keyed>
        {(target) => (
          <AutomationForm
            workerId={target.workerId}
            expectedRun={target.expectedRun}
            rpc={rpc}
            close={() => setModal('')}
            started={() => setNotice('')}
          />
        )}
      </Show>
      <Show when={modal() === 'reply-recovery'}>
        <Modal title="Use this reply" close={() => setModal('')}>
          <ReplyRecovery
            workerId={replyWorker()}
            rpc={rpc}
            close={() => setModal('')}
            applied={() => {
              setModal('');
              success('Reply queued. Continuing the same task.');
            }}
          />
        </Modal>
      </Show>
      <Show when={modal() === 'manual'}>
        <Modal title="Manual handoff" close={() => setModal('')}>
          <p class="muted">Use this only when you want to copy instructions yourself.</p>
          <div class="button-row">
            <button onClick={() => showText('bootstrap')}>Setup prompt</button>
            <button onClick={() => setModal('import')}>Paste handoff</button>
            <button onClick={() => showText('report')}>Review report</button>
          </div>
        </Modal>
      </Show>
      <Show when={modal() === 'health'}>
        <Modal title="Setup & connection" close={() => setModal('')} wide>
          <SetupPanel
            connected={props.controller.connected()}
            error={props.controller.connectionError()}
            builds={props.controller.connectionBuilds()}
            rpc={rpc}
            reconnect={() => props.controller.client.reconnect()}
            reload={reloadWorkspace}
            openProject={() => setModal('project')}
            createProject={() => setModal('project-create')}
            newTask={props.controller.newWorker}
            projectName={props.controller.project()?.name}
          />
          <Show when={props.controller.connected()}>
            <details class="setup-diagnostics setup-disclosure">
              <summary>
                <Icon name="down" />
                Advanced diagnostics and backups
              </summary>
              <HealthPanel rpc={rpc} copy={copy} notice={success} />
            </details>
          </Show>
        </Modal>
      </Show>
      <Show when={modal() === 'changes' && selected()}>
        <Modal title="Review file changes" close={() => setModal('')} wide>
          <ChangeReview workerId={selected()} {...reviewScope()} rpc={rpc} notice={success} />
        </Modal>
      </Show>
      <Show when={modal() === 'import'}>
        <Modal title="Paste handoff" close={() => setModal('')} wide>
          <p class="muted">Paste the complete mitter/1 JSON for this task.</p>
          <textarea
            class="code-input"
            rows={13}
            spellcheck={false}
            value={handoff()}
            onInput={(event) => setHandoff(event.currentTarget.value)}
            aria-label="Handoff JSON"
          />
          <div class="button-row spread">
            <button onClick={readHandoffClipboard}>Read clipboard</button>
            <button class="primary" disabled={busy() || !handoff().trim()} onClick={importBatch}>
              Import & run
            </button>
          </div>
        </Modal>
      </Show>
      <Show when={modal() === 'report' || modal() === 'prompt'}>
        <Modal title={textDialogTitle()} close={() => setModal('')} wide>
          <p class="muted">
            <Show
              when={modal() === 'report'}
              fallback={'Paste this into ChatGPT, then bring its complete JSON reply back.'}
            >
              {'Review before sharing. The report can contain project code and command output.'}
            </Show>
          </p>
          <textarea readonly class="code-input" rows={15} value={textValue()} />
          <div class="button-row end">
            <button onClick={() => setModal('')}>Close</button>
            <button class="primary" onClick={() => copy(textValue())}>
              <Icon name="copy" />
              Copy{' '}
              <Show when={modal() === 'report'} fallback={'prompt'}>
                {'report'}
              </Show>
            </button>
          </div>
        </Modal>
      </Show>
      <SettingsDialogs controller={props.controller} />
      <LibraryDialogs controller={props.controller} />
    </>
  );
}
