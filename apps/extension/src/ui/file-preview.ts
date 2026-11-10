import { errorMessage } from '../schemas/primitives';
import { createEffect, createSignal, onCleanup } from 'solid-js';
import {
  loadAsset,
  assetText,
  isTextAsset,
  htmlDocument,
  markdownDocument,
  type PreviewAsset,
  type PreviewRPC,
} from '../../../../packages/ui/src/preview';

export function createFilePreview(props: { workerId: string; path: string; rpc: PreviewRPC }) {
  const [asset, setAsset] = createSignal<PreviewAsset>();

  const [source, setSource] = createSignal('');

  const [hash, setHash] = createSignal('');

  const [html, setHTML] = createSignal('');

  const [url, setURL] = createSignal('');

  const [mode, setMode] = createSignal('source');

  const [error, setError] = createSignal('');

  const [loading, setLoading] = createSignal(true);

  const [warnings, setWarnings] = createSignal<string[]>([]);

  const [reload, setReload] = createSignal(0);

  let generation = 0;
  let controller: AbortController | undefined;
  let objectURL = '';
  function revoke() {
    if (objectURL) {
      URL.revokeObjectURL(objectURL);
    }
    objectURL = '';
    setURL('');
  }
  createEffect(() => {
    const id = props.workerId;
    const path = props.path;
    reload();
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    revoke();
    setAsset(undefined);
    setError('');
    setLoading(true);
    setHTML('');
    setSource('');
    setHash('');
    setWarnings([]);
    void (async () => {
      try {
        const loadedAsset = await loadAsset(props.rpc, id, path, signal);
        if (current !== generation) {
          return;
        }
        setAsset(loadedAsset);
        objectURL = URL.createObjectURL(
          new Blob([new Uint8Array(loadedAsset.bytes).buffer], {
            type: loadedAsset.mime,
          }),
        );
        setURL(objectURL);
        if (isTextAsset(loadedAsset)) {
          const text = assetText(loadedAsset);
          setSource(text.slice(0, 256000));
          if (text.length > 256000) {
            setWarnings([
              'Source display is limited to 256,000 characters. Copy/open the file in your editor for the full content.',
            ]);
          }
          if (text.length <= 120000 && loadedAsset.size <= 120000) {
            const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(loadedAsset.bytes).buffer);
            if (current !== generation) {
              return;
            }
            setHash([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
          }
          if (loadedAsset.mime === 'text/html') {
            const documentPreview = await htmlDocument(loadedAsset, (dependencyPath) =>
              loadAsset(props.rpc, id, dependencyPath, signal),
            );
            if (current !== generation) {
              return;
            }
            setHTML(documentPreview.html);
            setWarnings(documentPreview.warnings);
            setMode('preview');
          } else if (loadedAsset.mime === 'text/markdown') {
            setHTML(markdownDocument(text));
            setMode('preview');
          } else if (loadedAsset.mime.startsWith('image/')) {
            setMode('preview');
          } else {
            setMode('source');
          }
        } else {
          setMode('preview');
        }
      } catch (event) {
        if (!signal.aborted && current === generation) {
          setError(errorMessage(event));
        }
      } finally {
        if (current === generation) {
          setLoading(false);
        }
      }
    })();
  });

  onCleanup(() => {
    generation++;
    controller?.abort();
    controller = undefined;
    revoke();
    setAsset(undefined);
    setSource('');
    setHash('');
    setHTML('');
    setWarnings([]);
    setError('');
    setLoading(false);
  });

  return {
    asset,
    source,
    hash,
    html,
    url,
    mode,
    setMode,
    error,
    loading,
    warnings,
    setReload,
  };
}
