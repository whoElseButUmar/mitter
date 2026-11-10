import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/mini';
import { mountPreviewSandbox } from '../../src/preview-sandbox/sandbox.ts';
import {
  PREVIEW_HTML_LIMIT,
  PreviewMessageSchema,
  PreviewReadySchema,
} from '../../../../packages/ui/src/preview/sandbox-messages.ts';

const policy =
  "default-src 'none'; script-src 'unsafe-inline' data: blob:; " +
  "style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; " +
  "connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";
const prefix = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + policy + '">';

function fixture() {
  const listeners = new Set();
  const ready = [];
  const frames = [];
  const creations = [];
  const parent = { postMessage: (...args) => ready.push(args) };
  const document = {
    createElement(tag) {
      assert.equal(tag, 'iframe');
      const attributes = {};
      const frame = {
        setAttribute: (name, value) => {
          attributes[name] = value;
        },
        getAttribute: (name) => attributes[name],
      };
      creations.push(frame);

      return frame;
    },
    body: { replaceChildren: (frame) => frames.push(frame) },
  };
  const view = {
    parent,
    document,
    addEventListener(type, receive) {
      assert.equal(type, 'message');
      listeners.add(receive);
    },
    removeEventListener(type, receive) {
      assert.equal(type, 'message');
      listeners.delete(receive);
    },
  };
  const dispose = mountPreviewSandbox(view);
  const receive = [...listeners][0];

  return { view, parent, ready, frames, creations, listeners, receive, dispose };
}

test('the source-only sandbox emits its canonical readiness data without extension APIs', () => {
  const state = fixture();
  assert.deepEqual(state.ready, [[PreviewReadySchema.parse({ kind: 'miter.preview.ready' }), '*']]);
  assert.equal(state.listeners.size, 1);
  assert.deepEqual(state.frames, []);
  state.dispose();
});

test('only the pinned parent WindowProxy can supply data, regardless of a claimed opaque origin', () => {
  const state = fixture();
  const invalidSource = {};
  state.receive({ source: invalidSource, origin: 'null', data: { kind: 'miter.preview', html: 'spoofed' } });
  state.receive({ source: null, origin: 'null', data: { kind: 'miter.preview', html: 'spoofed' } });
  state.receive({
    source: invalidSource,
    get data() {
      throw new Error('Foreign data must not be inspected.');
    },
  });
  state.view.parent = invalidSource;
  state.receive({ source: invalidSource, data: { kind: 'miter.preview', html: 'changed parent' } });
  assert.deepEqual(state.creations, []);
  state.receive({
    source: state.parent,
    origin: 'null',
    data: { kind: 'miter.preview', html: 'original parent' },
  });
  assert.equal(state.frames.length, 1);
  assert.equal(state.frames[0].srcdoc, prefix + 'original parent');
  state.dispose();
});

test('malformed payloads do not create a frame or consume the one-use gate before valid data', () => {
  const state = fixture();

  for (const data of [
    undefined,
    null,
    false,
    1,
    'miter.preview',
    [],
    {},
    { kind: 'wrong', html: 'literal' },
    { kind: 'miter.preview' },
    { kind: 'miter.preview', html: null },
    { kind: 'miter.preview', html: false },
    { kind: 'miter.preview', html: {} },
    { kind: 'miter.preview', html: 'x'.repeat(PREVIEW_HTML_LIMIT + 1) },
    { kind: 'miter.preview', html: '😀'.repeat(PREVIEW_HTML_LIMIT / 2 + 1) },
    { kind: 'miter.preview', html: '😀'.repeat(PREVIEW_HTML_LIMIT / 2) + 'x' },
  ]) {
    state.receive({ source: state.parent, data });
    assert.deepEqual(state.creations, []);
  }

  state.receive({ source: state.parent, data: { kind: 'miter.preview', html: 'valid', unused: true } });
  assert.equal(state.frames.length, 1);
  assert.equal(state.frames[0].srcdoc, prefix + 'valid');
  state.dispose();
});

test('the exact HTML bound and empty HTML remain valid without normalization', () => {
  for (const html of ['', 'x'.repeat(PREVIEW_HTML_LIMIT), '😀'.repeat(PREVIEW_HTML_LIMIT / 2)]) {
    const state = fixture();
    const message = PreviewMessageSchema.parse({ kind: 'miter.preview', html });
    assert.equal(message.html, html);
    state.receive({ source: state.parent, data: message });
    assert.equal(state.frames[0].srcdoc, prefix + html);
    state.dispose();
  }
});

test('non-BMP HTML uses the UTF-16 boundary without consuming invalid data or changing literal bytes', () => {
  const state = fixture();
  const oversized = '😀'.repeat(PREVIEW_HTML_LIMIT / 2 + 1);
  assert.equal(oversized.length, PREVIEW_HTML_LIMIT + 2);
  assert.equal(PreviewMessageSchema.safeParse({ kind: 'miter.preview', html: oversized }).success, false);
  state.receive({ source: state.parent, data: { kind: 'miter.preview', html: oversized } });
  assert.deepEqual(state.creations, []);

  const header = '\ufeff<p>Literal 😀</p>\r\n';
  const footer = '\r\n<script>unchanged();</script>\r\n';
  const remaining = PREVIEW_HTML_LIMIT - header.length - footer.length;
  const html = header + '😀'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2) + footer;
  assert.equal(html.length, PREVIEW_HTML_LIMIT);
  const parsed = PreviewMessageSchema.parse({ kind: 'miter.preview', html });
  assert.equal(parsed.html, html);
  state.receive({ source: state.parent, data: parsed });
  assert.equal(state.frames.length, 1);
  const installed = state.frames[0].srcdoc.slice(prefix.length);
  assert.equal(installed, html);
  assert.deepEqual(Buffer.from(installed, 'utf8'), Buffer.from(html, 'utf8'));
  state.dispose();
});

test('literal HTML follows the unchanged inner CSP in a second opaque script-only frame', () => {
  const state = fixture();
  const html =
    '\ufeff<!doctype html>\r\n<script>literal(\"😀\");</script>\r\n' +
    '<meta http-equiv="Content-Security-Policy" content="default-src *"><p>local</p>';
  state.receive({ source: state.parent, origin: 'null', data: { kind: 'miter.preview', html } });
  const frame = state.frames[0];
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.equal(frame.title, 'Isolated local file preview');
  assert.equal(frame.srcdoc, prefix + html);
  assert.doesNotMatch(
    frame.getAttribute('sandbox'),
    /allow-same-origin|allow-forms|allow-popups|allow-top-navigation/,
  );
  state.dispose();
});

test('one valid payload consumes the gate, so later data is neither inspected nor installed', () => {
  const state = fixture();
  state.receive({ source: state.parent, data: { kind: 'miter.preview', html: 'first' } });
  state.receive({ source: state.parent, data: { kind: 'miter.preview', html: 'second' } });
  state.receive({
    source: state.parent,
    get data() {
      throw new Error('Consumed data must not be inspected.');
    },
  });
  assert.equal(state.creations.length, 1);
  assert.equal(state.frames.length, 1);
  assert.equal(state.frames[0].srcdoc, prefix + 'first');
  state.dispose();
});

test('a valid payload stays consumed even when installing its frame fails', () => {
  const state = fixture();
  state.view.document.createElement = () => {
    throw new Error('Frame creation failed.');
  };
  assert.throws(
    () => state.receive({ source: state.parent, data: { kind: 'miter.preview', html: 'first' } }),
    /Frame creation failed/,
  );
  assert.doesNotThrow(() =>
    state.receive({ source: state.parent, data: { kind: 'miter.preview', html: 'second' } }),
  );
  assert.deepEqual(state.frames, []);
  state.dispose();
});

test('sandbox disposal removes its listener and fences a retained callback without consuming data', () => {
  const state = fixture();
  state.dispose();
  state.dispose();
  assert.equal(state.listeners.size, 0);
  state.receive({
    source: state.parent,
    get data() {
      throw new Error('Disposed data must not be inspected.');
    },
  });
  assert.deepEqual(state.frames, []);
});

test('shared sandbox schemas and fields are described and reject malformed ready data', () => {
  for (const schema of [PreviewMessageSchema, PreviewReadySchema]) {
    assert.equal(typeof z.globalRegistry.get(schema)?.description, 'string');

    for (const field of Object.values(schema.def.shape)) {
      assert.equal(typeof z.globalRegistry.get(field)?.description, 'string');
    }
  }

  for (const data of [undefined, null, [], {}, { kind: null }, { kind: 'miter.preview' }]) {
    assert.equal(PreviewReadySchema.safeParse(data).success, false);
  }
});
