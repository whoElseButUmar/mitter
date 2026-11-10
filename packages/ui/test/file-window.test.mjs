import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod/mini';
import { setImmediate } from 'node:timers/promises';
import { domFixture } from './dom-fixture.mjs';
import { mountFileWindow } from '../src/file-window.js';
import { PreviewMessageSchema, PreviewReadySchema } from '../src/preview/sandbox-messages.js';
import {
  PreviewMessageSchema as reexportedMessageSchema,
  PreviewReadySchema as reexportedReadySchema,
} from '../src/preview/schemas.js';

function reply(source, mime = 'text/plain') {
  const bytes = new TextEncoder().encode(source);
  return {
    path: 'file',
    mime,
    size: bytes.length,
    offset: 0,
    stamp: 'a'.repeat(64),
    eof: true,
    data: Buffer.from(bytes).toString('base64'),
  };
}

function mount(root, rpc) {
  return mountFileWindow(root, {
    target: { workerId: 'task', path: 'file' },
    rpc,
    sandboxURL: 'https://extension.test/preview-sandbox.html',
  });
}

test('file window displays literal BOM/CRLF source text without interpreting user markup', async () => {
  const { root } = domFixture();
  const source = '\ufeff<script>literal source</script>\r\n😀';
  const dispose = mount(root, async () => reply(source));
  await setImmediate();
  assert.equal(root.querySelector('pre').textContent, source);
  assert.equal(root.querySelector('script'), null);
  assert.equal(root.querySelector('pre').tabIndex, 0);
  dispose();
  assert.equal(root.children.length, 0);
});

test('file window readiness accepts only checked messages from its own opaque sandbox frame', async () => {
  const { root, window } = domFixture();
  const dispose = mount(root, async () => reply('# Safe markdown', 'text/markdown'));
  await setImmediate();
  const frame = root.querySelector('iframe');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.equal(window.listenerCount, 1);
  await window.emit('message', {
    source: {},
    data: { kind: 'miter.preview.ready' },
  });
  for (const data of [undefined, null, [], {}, { kind: null }, { kind: 'wrong' }]) {
    await window.emit('message', { source: frame.contentWindow, data });
  }

  const previewWindow = frame.contentWindow;
  frame.contentWindow = null;
  await window.emit('message', { source: null, data: { kind: 'miter.preview.ready' } });
  assert.equal(window.listenerCount, 1);
  frame.contentWindow = previewWindow;
  assert.deepEqual(frame.contentWindow.messages, []);
  await window.emit('message', {
    source: frame.contentWindow,
    data: { kind: 'miter.preview.ready' },
  });
  assert.equal(frame.contentWindow.messages[0].origin, '*');
  assert.match(frame.contentWindow.messages[0].message.html, /<h1>Safe markdown<\/h1>/);
  assert.equal(PreviewMessageSchema.safeParse(frame.contentWindow.messages[0].message).success, true);
  assert.equal(window.listenerCount, 0);
  await window.emit('message', { source: frame.contentWindow, data: { kind: 'miter.preview.ready' } });
  assert.equal(frame.contentWindow.messages.length, 1);
  dispose();
});

test('preview senders and receivers reuse the canonical described message schemas', () => {
  assert.equal(reexportedMessageSchema, PreviewMessageSchema);
  assert.equal(reexportedReadySchema, PreviewReadySchema);
  assert.equal(typeof z.globalRegistry.get(PreviewMessageSchema)?.description, 'string');
  assert.equal(typeof z.globalRegistry.get(PreviewReadySchema)?.description, 'string');
});

test('file-window disposal removes readiness listeners and ignores late reads', async () => {
  const { root, window } = domFixture();
  const dispose = mount(root, async () => reply('text', 'text/markdown'));
  await setImmediate();
  assert.equal(window.listenerCount, 1);
  dispose();
  assert.equal(window.listenerCount, 0);
  const pending = Promise.withResolvers();
  const stop = mount(root, () => pending.promise);
  stop();
  pending.resolve(reply('late'));
  await setImmediate();
  assert.equal(root.children.length, 0);
});

test('media disposal pauses playback and revokes exactly the blob created from original bytes', async () => {
  const { root, window } = domFixture();
  const blobs = [];
  const revoked = [];
  window.URL = {
    createObjectURL(blob) {
      blobs.push(blob);
      return 'blob:fixture';
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
  const source = 'unchanged media bytes';
  const dispose = mount(root, async () => reply(source, 'video/mp4'));
  await setImmediate();
  const media = root.querySelector('video');
  assert.equal(media.src, 'blob:fixture');
  assert.equal(media.controls, true);
  assert.equal(await blobs[0].text(), source);
  dispose();
  assert.equal(media.paused, true);
  assert.deepEqual(revoked, ['blob:fixture']);
});

for (const mime of ['image/jpeg', 'video/mp4', 'audio/mpeg']) {
  test('file decode failure releases its URL and reports readable feedback for ' + mime, async () => {
    const { root, window } = domFixture();
    const revoked = [];
    window.URL = {
      createObjectURL: () => 'blob:failed',
      revokeObjectURL: (url) => revoked.push(url),
    };
    const dispose = mount(root, async () => reply('Invalid encoded bytes', mime));
    await setImmediate();
    const content = root.children[0];
    await content.emit('error');
    const error = root.querySelector('[role=alert]');
    assert.ok(error, 'Decode failure must provide an accessible message');
    assert.match(error.textContent, /This browser could not decode/);
    assert.deepEqual(revoked, ['blob:failed']);
    if (!mime.startsWith('image/')) {
      assert.equal(content.paused, true);
    }
    dispose();
    dispose();
    assert.deepEqual(revoked, ['blob:failed']);
  });
}

test('file teardown revokes bytes and clears DOM even when pausing playback throws', async () => {
  const { root, document, window } = domFixture();
  const revoked = [];
  window.URL = {
    createObjectURL: () => 'blob:fixture',
    revokeObjectURL: (url) => revoked.push(url),
  };
  const dispose = mount(root, async () => reply('Original media bytes', 'video/mp4'));
  await setImmediate();
  const media = root.querySelector('video');
  const failure = new Error('Playback teardown failed');
  media.pause = () => {
    throw failure;
  };
  assert.throws(dispose, (reason) => reason === failure);
  assert.equal(root.children.length, 0);
  assert.deepEqual(revoked, ['blob:fixture']);
  const replacement = document.createElement('input');
  root.append(replacement);
  assert.doesNotThrow(dispose);
  assert.equal(root.children[0], replacement);
  assert.deepEqual(revoked, ['blob:fixture']);
});

test('malformed file replies produce actionable text rather than schema internals', async () => {
  const { root } = domFixture();
  const dispose = mount(root, async () => ({ ...reply('Source'), size: 'wrong' }));
  await setImmediate();
  assert.equal(
    root.querySelector('[role=alert]').textContent,
    'The file preview response is invalid. Reload the file.',
  );
  dispose();
});
