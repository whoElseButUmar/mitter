import {
  loadAsset,
  assetText,
  isTextAsset,
  htmlDocument,
  markdownDocument,
  type PreviewRPC,
} from './preview.js';
import { PreviewMessageSchema, PreviewReadySchema } from './preview/sandbox-messages.js';
import { validateFileTarget, type FileTarget } from './file-target.js';
import { requireWindow } from './dom/elements.js';

export type FileWindowDependencies = {
  target: FileTarget;
  rpc: PreviewRPC;
  sandboxURL: string;
  onTitle?: (title: string) => void;
};

/** The selected file takes the whole viewport. No project tabs, controls or
 * workspace state are mounted here. All project HTML stays in the same opaque
 * two-level sandbox as the inline preview; it never gets native-host APIs. */
export function mountFileWindow(root: HTMLElement, dependencies: FileWindowDependencies): () => void {
  const document = root.ownerDocument;
  const window = requireWindow(document);
  const target = validateFileTarget(dependencies.target);
  const abort = new AbortController();
  let blob = '';
  let alive = true;
  let removeReady: (() => void) | undefined;
  dependencies.onTitle?.(target.path.split('/').at(-1) || target.path);

  const status = document.createElement('p');
  status.className = 'file-window-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Opening file…';
  root.replaceChildren(status);

  function makeBlob(bytes: Uint8Array, mime: string): string {
    // Copy into an ArrayBuffer-backed view; Blob cannot accept shared backing stores.
    blob = window.URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
    return blob;
  }

  function showDocument(html: string, warnings: string[]): void {
    const frame = document.createElement('iframe');
    frame.className = 'file-window-document';
    frame.title = target.path;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';

    const ready = (event: MessageEvent<unknown>) => {
      const previewWindow = frame.contentWindow;

      if (
        !alive ||
        !previewWindow ||
        event.source !== previewWindow ||
        !PreviewReadySchema.safeParse(event.data).success
      ) {
        return;
      }

      const message = PreviewMessageSchema.safeParse({ kind: 'miter.preview', html });

      if (!message.success) {
        return;
      }

      previewWindow.postMessage(message.data, '*');
      window.removeEventListener('message', ready);
    };
    window.addEventListener('message', ready);
    removeReady = () => window.removeEventListener('message', ready);
    frame.src = dependencies.sandboxURL;
    root.replaceChildren(frame);

    if (warnings.length) {
      const details = document.createElement('details');
      details.className = 'file-window-limits';
      const summary = document.createElement('summary');
      summary.textContent = 'Preview limitations';
      details.append(summary);

      for (const warning of warnings) {
        const paragraph = document.createElement('p');
        paragraph.textContent = warning;
        details.append(paragraph);
      }

      root.append(details);
    }
  }

  function clearContent(): void {
    removeReady?.();
    removeReady = undefined;

    try {
      for (const content of root.querySelectorAll('img,audio,video')) {
        if (content instanceof window.HTMLElement) {
          content.onerror = null;
        }

        if (content instanceof window.HTMLMediaElement) {
          content.pause();
        }
      }
    } finally {
      root.replaceChildren();

      if (blob) {
        const url = blob;
        blob = '';
        window.URL.revokeObjectURL(url);
      }
    }
  }

  function statusError(message: string): void {
    clearContent();
    const paragraph = document.createElement('p');
    paragraph.className = 'file-window-status error';
    paragraph.setAttribute('role', 'alert');
    paragraph.textContent = message;
    root.replaceChildren(paragraph);
  }

  void (async () => {
    try {
      const asset = await loadAsset(dependencies.rpc, target.workerId, target.path, abort.signal);

      if (!alive) {
        return;
      }

      if (asset.mime === 'text/html') {
        const result = await htmlDocument(asset, (path) =>
          loadAsset(dependencies.rpc, target.workerId, path, abort.signal),
        );

        if (alive) {
          showDocument(result.html, result.warnings);
        }
      } else if (asset.mime === 'text/markdown') {
        showDocument(markdownDocument(assetText(asset)), []);
      } else if (asset.mime.startsWith('image/')) {
        const image = document.createElement('img');
        image.className = 'file-window-image';
        image.alt = target.path;
        image.src = makeBlob(asset.bytes, asset.mime);
        image.onerror = () => {
          if (alive) {
            statusError('This browser could not decode the image.');
          }
        };
        root.replaceChildren(image);
      } else if (asset.mime.startsWith('video/') || asset.mime.startsWith('audio/')) {
        let media: HTMLMediaElement = document.createElement('audio');

        if (asset.mime.startsWith('video/')) {
          media = document.createElement('video');
        }

        media.className = 'file-window-media';
        media.controls = true;
        media.preload = 'metadata';
        media.src = makeBlob(asset.bytes, asset.mime);
        media.onerror = () => {
          if (alive) {
            statusError('This browser could not decode the media file.');
          }
        };
        root.replaceChildren(media);
      } else if (asset.mime === 'application/pdf') {
        const pdf = document.createElement('iframe');
        pdf.title = target.path;
        pdf.className = 'file-window-document';
        pdf.src = makeBlob(asset.bytes, asset.mime);
        root.replaceChildren(pdf);
      } else if (isTextAsset(asset)) {
        const source = document.createElement('pre');
        source.className = 'file-window-source';
        source.tabIndex = 0;
        source.textContent = assetText(asset);
        root.replaceChildren(source);
      } else {
        statusError('This file has no browser preview. Open it with its associated app.');
      }
    } catch (error) {
      if (alive && !abort.signal.aborted) {
        let message = String(error);

        if (error instanceof Error) {
          message = error.message;
        }

        statusError(message);
      }
    }
  })();

  return () => {
    if (!alive) {
      return;
    }

    alive = false;
    abort.abort();
    clearContent();
  };
}
