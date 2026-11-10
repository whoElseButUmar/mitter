import type { WorkspaceController } from '../ui/workspace-controller';
import type { Worker } from '../../../../packages/protocol/src/index';
import { checkDescription } from '../ui/task-view';
import { FileViewer } from '../FileViewer';
import { TeamPanel } from '../TeamPanel';
import { ContextArea } from '../ContextArea';
import { For, Show } from 'solid-js';
import { Icon } from '../icons';
import { InfoPopover } from '../controls';

export function TaskEditor(props: { controller: WorkspaceController; task: Worker }) {
  const { snapshot, success, setNotice, output, rpc, copy, sendFollowup, showText } = props.controller;
  const {
    files,
    file,
    view,
    setView,
    historyMore,
    historyBusy,
    activity,
    loadHistory,
    preview,
    openFileWindow,
    fileMenu,
    browseFiles,
  } = output;
  const task = () => props.task;

  const checksLabel = () => {
    const count = task().checks.length;
    if (count > 1) {
      return count + ' checks';
    }

    return count + ' check';
  };

  return (
    <>
      <div class="editor-tabs">
        <button
          classList={{
            selected: view() === 'result',
          }}
          onClick={() => setView('result')}
        >
          Files & result{' '}
          <Show when={files().length}>
            <span>{files().length}</span>
          </Show>
        </button>
        <button
          classList={{
            selected: view() === 'activity',
          }}
          onClick={() => setView('activity')}
        >
          Activity
        </button>
        <button
          classList={{
            selected: view() === 'team',
          }}
          onClick={() => setView('team')}
        >
          Team
        </button>
        <div class="spacer" />
        <Show when={task().checks.length}>
          <InfoPopover label={checksLabel()} title="Completion checks">
            <For each={task().checks}>{(check) => <p>{checkDescription(check)}</p>}</For>
          </InfoPopover>
        </Show>
      </div>
      <section class="editor-surface">
        <Show when={view() === 'team'}>
          <TeamPanel
            workerId={task().id}
            rpc={rpc}
            copy={copy}
            success={success}
            revision={snapshot().events[0]?.time || 0}
          />
        </Show>
        <Show when={view() === 'activity'}>
          <ContextArea
            items={[
              {
                id: 'copy-all',
                label: 'Copy task activity',
                run: () =>
                  void copy(
                    activity()
                      .map((event) => new Date(event.time).toISOString() + ' ' + event.message)
                      .join('\n'),
                  ),
              },
              {
                id: 'report',
                label: 'View full report…',
                run: () => void showText('report'),
              },
            ]}
          >
            <div class="activity-list">
              <For each={activity()} fallback={<p class="muted">No activity yet.</p>}>
                {(event) => (
                  <ContextArea
                    items={[
                      {
                        id: 'copy',
                        label: 'Copy event',
                        run: () => void copy(event.message),
                      },
                      {
                        id: 'timestamp',
                        label: 'Copy timestamp',
                        run: () => void copy(new Date(event.time).toISOString()),
                      },
                    ]}
                  >
                    <div class={`activity-line kind-${event.kind}`}>
                      <time>
                        {new Date(event.time).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                      <span>
                        <Show when={event.kind === 'action'} fallback={event.message}>
                          {event.message.split(': {')[0]}
                        </Show>
                      </span>
                    </div>
                  </ContextArea>
                )}
              </For>
              <Show when={historyMore()}>
                <button class="history-load" disabled={historyBusy()} onClick={() => void loadHistory()}>
                  <Show when={historyBusy()} fallback={'Load older activity'}>
                    {'Loading…'}
                  </Show>
                </button>
              </Show>
            </div>
          </ContextArea>
        </Show>
        <Show when={view() === 'result'}>
          <ContextArea
            items={[
              {
                id: 'browse',
                label: 'Browse workspace files…',
                run: () => void browseFiles(),
              },
              {
                id: 'copy',
                label: 'Copy changed file list',
                disabled: !files().length,
                run: () =>
                  void copy(
                    files()
                      .map((fileEntry) => fileEntry.path)
                      .join('\n'),
                  ),
              },
            ]}
          >
            <div class="files-heading">
              <span>
                <Show when={files().length} fallback={'Workspace files'}>
                  {'Changed files'}
                </Show>
              </span>
              <button class="text-button" onClick={() => void browseFiles()}>
                Browse all…
              </button>
            </div>
            <For
              each={files()}
              fallback={
                <p class="preview-hint">No file edits yet. Existing files are available in Browse all.</p>
              }
            >
              {(fileEntry) => (
                <ContextArea items={fileMenu(task().id, fileEntry.path)}>
                  <button
                    classList={{
                      'file-row': true,
                      selected: file() === fileEntry.path,
                    }}
                    onClick={() => preview(fileEntry.path)}
                  >
                    <Icon name="file" size={15} />
                    <span>{fileEntry.path}</span>
                    <small>
                      <Show when={fileEntry.status === 'rolled_back'} fallback={fileEntry.bytes + ' B'}>
                        {'restored'}
                      </Show>
                    </small>
                    <Icon name="arrow" size={13} />
                  </button>
                </ContextArea>
              )}
            </For>
          </ContextArea>
          <Show
            when={file()}
            fallback={<p class="preview-hint">Choose a file to preview it or select code for a change.</p>}
          >
            {(path) => (
              <FileViewer
                workerId={task().id}
                path={path()}
                rpc={rpc}
                request={(result) => sendFollowup(task().id, result)}
                copy={copy}
                notice={setNotice}
                success={success}
                openWindow={() => openFileWindow(task().id, path())}
              />
            )}
          </Show>
        </Show>
      </section>
    </>
  );
}
