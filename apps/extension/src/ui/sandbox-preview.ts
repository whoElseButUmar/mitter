import {
  PreviewMessageSchema,
  PreviewReadySchema,
} from '../../../../packages/ui/src/preview/sandbox-messages';

export function bindSandboxPreview(
  frame: Pick<HTMLIFrameElement, 'contentWindow'>,
  html: () => string,
  target: EventTarget = window,
): () => void {
  const send = (event: Event) => {
    if (!(event instanceof MessageEvent)) {
      return;
    }
    const previewWindow = frame.contentWindow;
    if (
      !previewWindow ||
      event.source !== previewWindow ||
      !PreviewReadySchema.safeParse(event.data).success
    ) {
      return;
    }

    // The preview sandbox has an opaque origin. Source identity, not origin,
    // authenticates this handshake; project HTML never reaches the workspace DOM.
    const message = PreviewMessageSchema.safeParse({ kind: 'miter.preview', html: html() });

    if (!message.success) {
      return;
    }

    previewWindow.postMessage(message.data, '*');
  };
  target.addEventListener('message', send);

  return () => target.removeEventListener('message', send);
}
