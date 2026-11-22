import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { progressKey } from '../../../../../packages/bridge/src/progress.ts';
import { browserExecutable } from '../quality/browser-executable.ts';
import { closeBrowser, launchPreviewBrowser } from '../quality/browser-launch.ts';
import { fixture, importBatch, makeEnvelope, makeProgress, runToBoundary } from './test-fixture.mjs';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF38AAAAASUVORK5CYII=';

function rememberExchange(store, worker, exchangeId) {
  const progress = makeProgress(worker, { stage: 'waiting_reply' });
  progress.lastReceipt = {
    workerId: worker.id,
    projectId: worker.projectId,
    goalHash: progress.goalHash,
    exchangeId,
    expectsReplyTo: true,
    textHash: 'c'.repeat(64),
    renderedHash: 'c'.repeat(64),
    at: 100,
  };
  store.set(progressKey(worker.id), progress);
}

test('generated image uploads require the current exchange and publish only from a complete exact reply', async (context) => {
  const { service, worker, store, root } = await fixture(context);
  const exchangeId = '9b904385-cd50-4f61-937f-ce884967b859';
  rememberExchange(store, worker, exchangeId);
  const actions = [{ type: 'saveImage', path: 'images/art.jpg', source: { type: 'generated', index: 1 } }];
  const envelope = makeEnvelope(worker, actions, { replyTo: exchangeId });
  const input = {
    workerId: worker.id,
    envelopeId: envelope.id,
    exchangeId,
    index: 1,
    contentType: 'image/png',
    offset: 0,
    total: pixel.length,
    data: pixel.slice(0, 8),
  };
  const importReply = () =>
    service.handle('worker.import', { workerId: worker.id, text: JSON.stringify(envelope) });
  await assert.rejects(
    service.handle('worker.stageImage', { ...input, exchangeId: 'other_exchange' }),
    /current reply/,
  );
  assert.deepEqual(await service.handle('worker.stageImage', input), { received: 8 });
  assert.deepEqual(await service.handle('worker.stageImage', input), { received: 8 });
  await assert.rejects(
    service.handle('worker.stageImage', { ...input, data: 'AAAAAAAA' }),
    /different bytes/,
  );
  await assert.rejects(importReply(), /generated image is missing/);

  await service.handle('worker.stageImage', { ...input, offset: 8, data: pixel.slice(8) });
  await importReply();
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review', worker.error);
  assert.deepEqual(await readFile(path.join(root, 'images/art.png')), Buffer.from(pixel, 'base64'));
  assert.match(await service.handle('worker.report', { workerId: worker.id }), /images.*art\.png/);
  assert.equal(store.get('miter.generatedImage.' + worker.id + '.1'), null);
});

test(
  'one web task serves both saved image sources in a verified live Chrome preview',
  {
    skip: process.platform !== 'darwin' || !process.env.MITER_TEST_IMAGE_RELEASE,
    timeout: 240000,
  },
  async (context) => {
    const { service, worker, store, root, dataDir } = await fixture(context);
    worker.goal = 'Build a gallery using a reusable web photo and a generated illustration.';
    const exchangeId = '4402fec4-4d3f-4885-8858-997ddc8e3506';
    rememberExchange(store, worker, exchangeId);
    const url = 'https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg';
    const actions = [
      { type: 'saveImage', path: 'image/web.jpg', source: { type: 'web', url } },
      { type: 'saveImage', path: 'image/art.png', source: { type: 'generated', index: 1 } },
    ];
    const reply = makeEnvelope(worker, actions, { replyTo: exchangeId });
    await service.handle('worker.stageImage', {
      workerId: worker.id,
      envelopeId: reply.id,
      exchangeId,
      index: 1,
      contentType: 'image/png',
      offset: 0,
      total: pixel.length,
      data: pixel,
    });
    await service.handle('worker.import', { workerId: worker.id, text: JSON.stringify(reply) });
    await runToBoundary(service, worker);
    assert.equal(worker.state, 'review', worker.error);
    const files = await service.handle('worker.files', { workerId: worker.id });
    assert.deepEqual(files.map(({ path }) => path).sort(), ['image/art.png', 'image/web.jpg']);
    assert.deepEqual(await readFile(path.join(root, 'image/art.png')), Buffer.from(pixel, 'base64'));

    const write = (path, content) => ({ type: 'write', path, content, base: 'missing' });
    await importBatch(service, worker, [
      { type: 'skill', name: 'app-design' },
      { type: 'skill', name: 'engineering-quality' },
      { type: 'write', path: 'foundation.css', asset: 'foundation.css', base: 'missing' },
      { type: 'write', path: 'components.mjs', asset: 'components.mjs', base: 'missing' },
      write(
        'index.html',
        `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Image gallery</title><meta name="description" content="View the two images in this collection.">
<link rel="icon" href="image/art.png"><link rel="stylesheet" href="foundation.css">
<link rel="stylesheet" href="gallery.css"><body class="ui">
<main><h1>Image gallery</h1><button class="ui-button" type="button" aria-pressed="false">Show illustration</button>
<img id="photo" src="image/web.jpg" width="128" height="128" alt="Wikimedia’s example image">
<img id="art" src="image/art.png" width="128" height="128" alt="Single-pixel test illustration" hidden></main>
<script src="gallery.mjs" type="module"></script></body></html>`,
      ),
      write(
        'gallery.css',
        'main { max-width: 40rem; margin: auto; padding: 1rem; } img { display: block; margin-top: 1rem; object-fit: contain; } img[hidden] { display: none; }',
      ),
      write(
        'gallery.mjs',
        `import './components.mjs';
import { selectImage } from './selection.mjs';
const button = document.querySelector('button');
const photo = document.querySelector('#photo');
const art = document.querySelector('#art');
button.addEventListener('click', () => {
  const show = selectImage(art.hidden);
  photo.hidden = show === 'art';
  art.hidden = show === 'photo';
  button.setAttribute('aria-pressed', String(!art.hidden));
});`,
      ),
      write('selection.mjs', "export const selectImage = (showArt) => showArt ? 'art' : 'photo';"),
      write(
        'selection.test.mjs',
        `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectImage } from './selection.mjs';
test('select either image', () => {
  assert.equal(selectImage(false), 'photo');
  assert.equal(selectImage(true), 'art');
});`,
      ),
      write(
        'miter.quality.json',
        JSON.stringify({
          version: 1,
          entry: 'index.html',
          styles: ['foundation.css'],
          components: ['components.mjs'],
          tests: ['selection.test.mjs'],
          journeys: [
            {
              name: 'View both images',
              steps: [
                { type: 'expect', selector: '#photo', visible: true },
                { type: 'click', selector: 'button' },
                { type: 'expect', selector: '#art', visible: true },
                { type: 'expect', selector: '#photo', visible: false },
              ],
            },
          ],
        }),
      ),
      { type: 'finish', summary: 'Show both imported images in the gallery.' },
    ]);
    await runToBoundary(service, worker);
    assert.equal(worker.state, 'complete', worker.error);
    assert.equal(worker.completion.verification, 'passed');
    const preview = await service.handle('worker.previewStart', {
      workerId: worker.id,
      expectedRun: { runId: worker.runId, epoch: 0 },
      mode: 'verified',
    });
    const executable = await browserExecutable();
    assert.ok(executable);
    const profile = await mkdtemp(path.join(dataDir, 'image-chrome-'));
    await Promise.all(['home', 'tmp'].map((name) => mkdir(path.join(profile, name))));
    const browser = await launchPreviewBrowser(executable, profile, preview.url);
    try {
      const page = await browser.newPage();
      await page.goto(preview.url);
      await page.waitForFunction(() => {
        const images = Array.from(document.images);
        return (
          images.length === 2 &&
          images.every(
            (image) =>
              image.complete &&
              image.naturalWidth > 0 &&
              new URL(image.currentSrc).origin === location.origin,
          )
        );
      });
      await page.click('button');
      await page.waitForSelector('#art', { visible: true });
    } finally {
      await closeBrowser(browser);
    }
  },
);
