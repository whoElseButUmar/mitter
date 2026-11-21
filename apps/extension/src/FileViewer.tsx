import { createFilePreview } from './ui/file-preview';
import { errorMessage } from './schemas/primitives';
import { SandboxedDocument } from './components/SandboxedDocument';
import { SelectedSource } from './components/SelectedSource';
import type { ChangeRequest } from './schemas/requests';
import { fileViewerMenu } from '../../../packages/ui/src/file-menu';
import { createEffect, onCleanup, Show, For } from 'solid-js';
import { isTextAsset, type PreviewRPC } from '../../../packages/ui/src/preview';
import { ContextArea } from './ContextArea';
import { MenuButton } from './controls';
import type { MenuItem } from '../../../packages/ui/src/menu';

export type { ChangeRequest } from './schemas/requests';

export function FileViewer(props: {
  workerId: string;
  path: string;
  rpc: PreviewRPC;
  request: (request: ChangeRequest) => Promise<unknown>;
  notice: (message: string) => void;
  copy: (text: string) => Promise<void>;
  success?: (message: string) => void;
  openWindow: () => void;
  focusRequest?: number;
}) {
  const { asset, source, hash, html, url, mode, setMode, error, loading, warnings, setReload } =
    createFilePreview(props);
  let caption: HTMLDivElement | undefined;

  createEffect(() => {
    const request = props.focusRequest;
    const workerId = props.workerId;
    const path = props.path;
    if (request === undefined) {
      return;
    }
    let current = true;
    onCleanup(() => {
      current = false;
    });
    // File selection closes its dialog first; focus the selected file after
    // that dialog has restored its opener, without reviving an old selection.
    queueMicrotask(() => {
      if (
        current &&
        props.focusRequest === request &&
        props.workerId === workerId &&
        props.path === path &&
        caption?.isConnected &&
        caption.checkVisibility() &&
        !caption.ownerDocument.querySelector('dialog[open]')
      ) {
        caption.focus({ preventScroll: true });
        caption.scrollIntoView({ block: 'start', inline: 'nearest' });
      }
    });
  });

  const open = (application: 'finder' | 'vscode') => {
    void props
      .rpc('worker.openFile', {
        workerId: props.workerId,
        path: props.path,
        application,
      })
      .then(() => {
        if (application === 'finder') {
          return props.success?.('Revealed file in file manager.');
        }

        return props.success?.('Opened file in VS Code.');
      })
      .catch((event) => props.notice(errorMessage(event)));
  };

  const menu = (): MenuItem[] =>
    fileViewerMenu({
      openWindow: props.openWindow,
      reveal: () => open('finder'),
      openEditor: () => open('vscode'),
      copyPath: () => void props.copy(props.path),
      copySource: () => void props.copy(source()),
      reload: () => setReload((value) => value + 1),
      hasSource: !!source(),
      truncated: (asset()?.size ?? 0) > 256000,
    });

  const hasTextAsset = () => {
    const currentAsset = asset();
    return currentAsset && isTextAsset(currentAsset);
  };

  return (
    <ContextArea label="File actions" items={menu()} class="file-viewer">
      <div
        class="file-caption"
        ref={(element) => {
          caption = element;
        }}
        tabindex="-1"
        role="group"
        aria-label={'File: ' + props.path}
      >
        <span title={props.path}>{props.path}</span>
        <div class="spacer" />
        <Show when={hasTextAsset()}>
          <button
            aria-pressed={mode() === 'source'}
            classList={{
              selected: mode() === 'source',
            }}
            onClick={() => setMode('source')}
          >
            Source
          </button>
        </Show>
        <Show
          when={
            html() ||
            asset()?.mime.startsWith('image/') ||
            asset()?.mime.startsWith('audio/') ||
            asset()?.mime.startsWith('video/') ||
            asset()?.mime === 'application/pdf'
          }
        >
          <button
            aria-pressed={mode() === 'preview'}
            classList={{
              selected: mode() === 'preview',
            }}
            onClick={() => setMode('preview')}
          >
            Preview
          </button>
        </Show>
        <MenuButton label="File" items={menu()} />
      </div>
      <Show when={loading()}>
        <p class="preview-hint" role="status">
          Loading file…
        </p>
      </Show>
      <Show when={error()}>
        <div class="read-error">
          <p class="error" role="alert">
            Could not load this file. {error()}
          </p>
          <button type="button" disabled={loading()} onClick={() => setReload((value) => value + 1)}>
            Retry file
          </button>
        </div>
      </Show>
      <Show when={!loading() && !error() && asset()}>
        {(currentAsset) => (
          <Show when={currentAsset().size > 0} fallback={<p class="preview-hint">This file is empty.</p>}>
            <Show
              when={mode() === 'source'}
              fallback={
                <div class="rendered-preview">
                  <Show keyed when={html()}>
                    {(value) => <SandboxedDocument html={value} />}
                  </Show>
                  <Show when={!html() && currentAsset().mime.startsWith('image/')}>
                    <img src={url()} alt={props.path} />
                  </Show>
                  <Show when={currentAsset().mime.startsWith('video/')}>
                    <video controls src={url()} preload="metadata" />
                  </Show>
                  <Show when={currentAsset().mime.startsWith('audio/')}>
                    <audio controls src={url()} preload="metadata" />
                  </Show>
                  <Show when={currentAsset().mime === 'application/pdf'}>
                    <iframe class="rendered-document" title="PDF preview" src={url()} />
                    <p class="preview-hint">
                      PDF uses Chrome’s viewer. Use File → Preview in new window if the embedded viewer is
                      unavailable.
                    </p>
                  </Show>
                  <Show
                    when={
                      !html() &&
                      !/^(image|audio|video)\//.test(currentAsset().mime) &&
                      currentAsset().mime !== 'application/pdf'
                    }
                  >
                    <p class="preview-hint">No rendered preview for this file. Open it in your editor.</p>
                  </Show>
                  <Show when={warnings().length}>
                    <details class="preview-warnings">
                      <summary>Preview limitations ({warnings().length})</summary>
                      <For each={warnings()}>{(warning) => <p>{warning}</p>}</For>
                    </details>
                  </Show>
                </div>
              }
            >
              <Show
                keyed
                when={hash() && props.workerId + ':' + props.path + ':' + hash()}
                fallback={
                  <pre class="file-content" tabindex="0">
                    {source()}
                  </pre>
                }
              >
                {(_previewIdentity) => (
                  <>
                    <p class="selection-hint">
                      Select code to request a change. Alt + Enter also opens the request.
                    </p>
                    <SelectedSource
                      workerId={props.workerId}
                      path={props.path}
                      source={source()}
                      hash={hash()}
                      request={props.request}
                      copy={props.copy}
                    />
                  </>
                )}
              </Show>
            </Show>
          </Show>
        )}
      </Show>
    </ContextArea>
  );
}
