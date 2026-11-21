import type { WorkspaceController } from '../ui/workspace-controller';
import type { Worker } from '../../../../packages/protocol/src/index';
import { checkDescription } from '../ui/task-view';
import { FileViewer } from '../FileViewer';
import { TeamPanel } from '../TeamPanel';
import { ContextArea } from '../ContextArea';
import { createEffect, For, Show } from 'solid-js';
import { Icon } from '../icons';
import { InfoPopover } from '../controls';

export function TaskEditor(props: { controller: WorkspaceController; task: Worker }) {
  const { snapshot, success, setNotice, output, rpc, copy, sendFollowup, showText, connected } =
    props.controller;
  const {
    files,
    file,
    view,
    setView,
    historyMore,
    historyBusy,
    historyError,
    retryHistory,
    filesLoading,
    filesError,
    retryFiles,
    browsing,
    activity,
    loadHistory,
    preview,
    openFileWindow,
    fileMenu,
    browseFiles,
    expanded,
    setExpanded,
  } = output;
  const task = () => props.task;
  let disclosure: HTMLDetailsElement | undefined;

  createEffect(() => {
    const open = expanded();
    // The browser can close <details> before its toggle event reaches Solid.
    // Assign directly so an explicit open also repairs that native DOM change.
    if (disclosure) {
      disclosure.open = open;
    }
  });

  const checksLabel = () => {
    const count = task().checks.length;
    if (count === 0) {
      return 'Checks';
    }
    return `Checks (${count})`;
  };

  return (
    <details
      class="task-output task-disclosure-panel"
      ref={(element) => {
        disclosure = element;
      }}
      onToggle={(event) => {
        if (expanded() !== event.currentTarget.open) {
          setExpanded(event.currentTarget.open);
        }
      }}
    >
      <summary>
        <Icon name="right" />
        Files and activity
      </summary>
      <div class="editor-tabs">
        <button
          classList={{
            selected: view() === 'result',
          }}
          onClick={() => setView('result')}
        >
          Files{' '}
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
        <InfoPopover label={checksLabel()} title="Completion checks">
          <p>
            Miter checks shared controls, runs domain tests, and tests web apps in Chrome on desktop and
            mobile.
          </p>
          <For each={task().checks}>{(check) => <p>{checkDescription(check)}</p>}</For>
        </InfoPopover>
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
              <Show when={historyBusy() && !activity().length}>
                <p class="preview-hint" role="status">
                  Loading activity…
                </p>
              </Show>
              <Show when={historyError()}>
                <div class="read-error">
                  <p class="error" role="alert">
                    Could not load activity. {historyError()}
                  </p>
                  <button
                    type="button"
                    disabled={!connected() || historyBusy()}
                    onClick={() => void retryHistory()}
                  >
                    Retry activity
                  </button>
                </div>
              </Show>
              <For
                each={activity()}
                fallback={
                  <Show when={!historyBusy() && !historyError()}>
                    <p class="muted">
                      <Show when={connected()} fallback="Reconnect to load activity.">
                        No activity yet.
                      </Show>
                    </p>
                  </Show>
                }
              >
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
              <Show when={historyMore() && !historyError()}>
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
                disabled: !connected() || browsing(),
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
              <button
                class="text-button"
                disabled={!connected() || browsing()}
                onClick={() => void browseFiles()}
              >
                <Show when={browsing()} fallback="Browse all…">
                  Loading files…
                </Show>
              </button>
            </div>
            <Show when={filesLoading()}>
              <p class="preview-hint" role="status">
                Loading changed files…
              </p>
            </Show>
            <Show when={filesError()}>
              <div class="read-error">
                <p class="error" role="alert">
                  Could not load changed files. {filesError()}
                </p>
                <button
                  type="button"
                  disabled={!connected() || filesLoading()}
                  onClick={() => void retryFiles()}
                >
                  Retry files
                </button>
              </div>
            </Show>
            <For
              each={files()}
              fallback={
                <Show when={!filesLoading() && !filesError()}>
                  <p class="preview-hint">
                    <Show when={connected()} fallback="Reconnect to load files.">
                      No changed files yet. Browse all to view existing files.
                    </Show>
                  </p>
                </Show>
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
                    <Icon name="file" />
                    <span>{fileEntry.path}</span>
                    <small>
                      <Show when={fileEntry.status === 'rolled_back'} fallback={fileEntry.bytes + ' B'}>
                        {'restored'}
                      </Show>
                    </small>
                    <Icon name="right" />
                  </button>
                </ContextArea>
              )}
            </For>
          </ContextArea>
          <Show when={file()}>
            {(path) => (
              <FileViewer
                workerId={task().id}
                path={path()}
                focusRequest={output.previewRequest()}
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
    </details>
  );
}
