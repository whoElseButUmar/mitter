import type { WorkspaceController } from '../ui/workspace-controller';
import type { Worker } from '../../../../packages/protocol/src/index';
import { navigationIndex } from '../../../../packages/ui/src/native/keyboard';
import type { OutputView } from '../ui/task-output';
import { FileViewer } from '../FileViewer';
import { TeamPanel } from '../TeamPanel';
import { ContextArea } from '../ContextArea';
import { createEffect, createUniqueId, For, Show } from 'solid-js';
import { Icon } from '../icons';
import { TaskFileTree } from '../components/TaskFileTree';

const outputViews: { id: OutputView; label: string }[] = [
  { id: 'result', label: 'Files' },
  { id: 'activity', label: 'Activity' },
  { id: 'team', label: 'Team' },
];

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
  const tabs = createUniqueId();
  const tabId = (id: OutputView) => tabs + '-' + id;
  const panelId = (id: OutputView) => tabId(id) + '-panel';
  const tabStop = (id: OutputView) => {
    if (view() === id) {
      return 0;
    }
    return -1;
  };
  let disclosure: HTMLDetailsElement | undefined;

  createEffect(() => {
    const open = expanded();
    // The browser can close <details> before its toggle event reaches Solid.
    // Assign directly so an explicit open also repairs that native DOM change.
    if (disclosure) {
      disclosure.open = open;
    }
  });

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
      <div class="editor-tabs" role="tablist" aria-label="Task output">
        <For each={outputViews}>
          {(tab, index) => (
            <button
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={view() === tab.id}
              aria-controls={panelId(tab.id)}
              tabindex={tabStop(tab.id)}
              classList={{ selected: view() === tab.id }}
              onClick={() => setView(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  return;
                }
                const next = navigationIndex(event.key, index(), outputViews.length);
                if (next === undefined) {
                  return;
                }
                const target = outputViews[next];
                if (target) {
                  event.preventDefault();
                  event.currentTarget.ownerDocument.getElementById(tabId(target.id))?.focus();
                }
              }}
            >
              {tab.label}
            </button>
          )}
        </For>
      </div>
      <div class="editor-surface">
        <section
          role="tabpanel"
          id={panelId('team')}
          aria-labelledby={tabId('team')}
          hidden={view() !== 'team'}
        >
          <Show when={view() === 'team'}>
            <TeamPanel
              workerId={task().id}
              rpc={rpc}
              copy={copy}
              success={success}
              revision={snapshot().events[0]?.time || 0}
            />
          </Show>
        </section>
        <section
          role="tabpanel"
          id={panelId('activity')}
          aria-labelledby={tabId('activity')}
          hidden={view() !== 'activity'}
          tabindex="0"
        >
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
                        <time dateTime={new Date(event.time).toISOString()}>
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
        </section>
        <section
          role="tabpanel"
          id={panelId('result')}
          aria-labelledby={tabId('result')}
          hidden={view() !== 'result'}
        >
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
              <span>Changed files</span>
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
            <Show
              when={files().length}
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
              <Show when={task().id} keyed>
                {(id) => (
                  <TaskFileTree
                    files={files()}
                    selected={file()}
                    previewRequest={output.previewRequest()}
                    preview={preview}
                    menu={(path) => fileMenu(id, path)}
                  />
                )}
              </Show>
            </Show>
          </ContextArea>
          <Show when={view() === 'result' && file()}>
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
        </section>
      </div>
    </details>
  );
}
