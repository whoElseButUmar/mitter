import {
  PreviewMessageSchema,
  PreviewReadySchema,
} from '../../../../packages/ui/src/preview/sandbox-messages.js';

// This manifest sandbox has no extension APIs. Project code gets a second opaque origin.
export function mountPreviewSandbox(view: Window): () => void {
  const parent = view.parent;
  let used = false;

  const receive = (event: MessageEvent<unknown>): void => {
    // Opaque sandbox origins are not identities. Pin the parent WindowProxy instead.
    if (event.source !== parent || used) {
      return;
    }

    const message = PreviewMessageSchema.safeParse(event.data);

    if (!message.success) {
      return;
    }

    used = true;
    const frame = view.document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.title = 'Isolated local file preview';
    const policy =
      "default-src 'none'; script-src 'unsafe-inline' data: blob:; " +
      "style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; " +
      "connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";

    // Install CSP before content. No project controls are exposed to the parent.
    frame.srcdoc =
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="' +
      policy +
      '">' +
      message.data.html;
    view.document.body.replaceChildren(frame);
  };
  view.addEventListener('message', receive);
  parent.postMessage(PreviewReadySchema.parse({ kind: 'miter.preview.ready' }), '*');

  return () => {
    used = true;
    view.removeEventListener('message', receive);
  };
}
