import { PreviewMessageSchema, PreviewReadySchema } from '../../packages/ui/src/preview/sandbox-messages.ts';

/** Owns only the disposable fixture's frames and canonical message listener. */
class PreviewFixture {
  /** @param {Window & typeof globalThis} view */
  constructor(view) {
    this.view = view;
    /** @type {HTMLIFrameElement | undefined} */
    this.preview = undefined;
    /** @type {HTMLIFrameElement | undefined} */
    this.peer = undefined;
    /** @type {import('./chrome-schemas.mjs').PreviewFixtureState['ready']} */
    this.ready = [];
    this.innerReady = 0;
    this.innerOrigin = '';
    this.malformedSent = 0;
    const ready = JSON.stringify(PreviewReadySchema.parse({ kind: 'miter.preview.ready' }));
    this.html =
      '\ufeff<!-- Literal BOM, CRLF, quotes and non-BMP text must survive. -->\r\n' +
      '<main id="literal-marker" data-quotes="&quot;unchanged&quot;">Literal 😀 &amp; exact</main>\r\n' +
      '<script>\r\n' +
      'let parentBlocked = false;\r\n' +
      'try { void parent.document; } catch { parentBlocked = true; }\r\n' +
      'if (parentBlocked && !globalThis.chrome?.runtime &&\r\n' +
      '    document.getElementById("literal-marker")?.textContent === "Literal 😀 & exact") {\r\n' +
      '  parent.parent.postMessage(' +
      ready +
      ', "*");\r\n' +
      '}\r\n</script>\r\n';

    /** @param {MessageEvent<unknown>} event */
    this.receive = (event) => {
      if (!PreviewReadySchema.safeParse(event.data).success) {
        return;
      }

      if (this.preview && event.source === this.preview.contentWindow) {
        this.ready.push({ frame: 'preview', origin: event.origin });
      } else if (this.peer && event.source === this.peer.contentWindow) {
        this.ready.push({ frame: 'peer', origin: event.origin });
      } else if (
        this.preview?.contentWindow?.length === 1 &&
        event.source === this.preview.contentWindow.frames[0]
      ) {
        this.innerReady++;
        this.innerOrigin = event.origin;
      }
    };
  }

  mount() {
    if (this.preview || this.peer || this.view.frames.length !== 0) {
      throw new Error('The preview regression requires a disposable fixture with no existing frames.');
    }

    this.view.addEventListener('message', this.receive);
    for (const name of ['preview', 'peer']) {
      const frame = this.view.document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.referrerPolicy = 'no-referrer';
      frame.title = 'Release preview ' + name;
      const url = new URL('./preview-sandbox.html', this.view.location.href);
      url.searchParams.set('release-preview', name);
      frame.src = url.href;
      if (name === 'preview') {
        this.preview = frame;
      } else {
        this.peer = frame;
      }
      this.view.document.body.append(frame);
    }
  }

  spoof() {
    const message = PreviewMessageSchema.parse({ kind: 'miter.preview', html: '<p>Foreign sender</p>' });
    // Indexed WindowProxy access works across opaque origins. The peer's inner
    // script, not the trusted parent, sends this valid payload to the first frame.
    this.peer?.contentWindow?.postMessage(
      PreviewMessageSchema.parse({
        kind: 'miter.preview',
        html: '<script>parent.parent.frames[0].postMessage(' + JSON.stringify(message) + ', "*");</script>',
      }),
      '*',
    );
  }

  malformed() {
    for (const data of [
      undefined,
      null,
      'miter.preview',
      {},
      { kind: 'wrong', html: 'wrong kind' },
      { kind: 'miter.preview' },
      { kind: 'miter.preview', html: null },
      { kind: 'miter.preview', html: 123 },
    ]) {
      this.preview?.contentWindow?.postMessage(data, '*');
      this.malformedSent++;
    }
  }

  send() {
    this.preview?.contentWindow?.postMessage(
      PreviewMessageSchema.parse({ kind: 'miter.preview', html: this.html }),
      '*',
    );
  }

  replay() {
    this.preview?.contentWindow?.postMessage(
      PreviewMessageSchema.parse({
        kind: 'miter.preview',
        html: '<p>Replay must not replace the preview</p>',
      }),
      '*',
    );
  }

  /** @returns {import('./chrome-schemas.mjs').PreviewFixtureState} */
  inspect() {
    return {
      html: this.html,
      ready: [...this.ready],
      innerReady: this.innerReady,
      innerOrigin: this.innerOrigin,
      malformedSent: this.malformedSent,
    };
  }

  destroy() {
    this.view.removeEventListener('message', this.receive);
    this.preview?.remove();
    this.peer?.remove();
    this.preview = undefined;
    this.peer = undefined;
    this.ready = [];
    this.innerReady = 0;
    this.innerOrigin = '';
    this.malformedSent = 0;
    this.html = '';
  }
}

Object.assign(window, { mitterPreviewFixture: new PreviewFixture(window) });
