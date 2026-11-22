import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { browserExecutable } from '../quality/browser-executable.ts';
import { closeBrowser, launchPreviewBrowser } from '../quality/browser-launch.ts';
import { serveSnapshot } from './server.ts';
import { pickInPage, pickPreviewElement } from './element-picker.ts';

const chrome = await browserExecutable();
async function setup(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'miter-picker-test-'));
  t.after(() => fs.rm(temporary, { force: true, recursive: true }));
  await Promise.all(['home', 'tmp'].map((name) => fs.mkdir(path.join(temporary, name))));
  const first = '<a id="go" href="edit.html?token=private-value#private">Edit note</a>';
  const second = `<input type="password" id="private" value="must-stay-private">
    <button id="save" aria-labelledby="save-name" onclick="document.body.dataset.activated='yes'">OK</button>
    <span id="save-name">Save note</span>`;
  const assets = new Map(
    [
      ['index.html', first],
      ['edit.html', second],
    ].map(([key, value]) => [
      key,
      { bytes: Buffer.from('<!doctype html><title>Notes</title>' + value), mime: 'text/html; charset=utf-8' },
    ]),
  );
  const server = await serveSnapshot(
    { assets, bytes: 2048 },
    'miter-' + randomBytes(16).toString('hex') + '.localhost',
    randomBytes(16).toString('hex'),
  );
  t.after(() => server.close());
  const browser = await launchPreviewBrowser(chrome, temporary, server.url, true);
  t.after(() => closeBrowser(browser));
  return { page: await browser.newPage(), url: server.url };
}

// Accessibility sees the controls in the closed shadow tree without making
// their DOM or the host callback available to the preview's JavaScript.
async function choose(page) {
  const session = await page.createCDPSession();
  try {
    const { root } = await session.send('DOM.getDocument');
    const { nodes } = await session.send('Accessibility.queryAXTree', {
      nodeId: root.nodeId,
      accessibleName: 'Select element',
      role: 'button',
    });
    const button = nodes.find((node) => !!node.backendDOMNodeId);
    assert.ok(button);
    const { model } = await session.send('DOM.getBoxModel', { backendNodeId: button.backendDOMNodeId });
    const [left, top, right, , , bottom] = model.content;
    await page.mouse.click((left + right) / 2, (top + bottom) / 2);
  } finally {
    await session.detach();
  }
}

test(
  'Chrome can navigate, skip a private field and select without activating the control',
  { skip: !chrome },
  async (t) => {
    const { page, url } = await setup(t);
    const choice = pickInPage(page, url, AbortSignal.timeout(12_000));
    void choice.catch(() => {});
    await page.waitForSelector('#go');
    assert.equal(await page.evaluate(() => typeof window.miterPick), 'undefined');
    await Promise.all([page.waitForNavigation(), page.click('#go')]);
    await choose(page);
    await page.click('#private');
    await page.click('#save');
    const result = await choice;
    assert.equal(result.role, 'button');
    assert.equal(result.name, 'Save note');
    assert.equal(result.route, '/edit.html');
    assert.equal(await page.$eval(result.selector, (el) => el.id), 'save');
    assert.equal(await page.evaluate(() => document.body.dataset.activated), undefined);
    assert.match(result.screenshot, /^data:image\/jpeg;base64,\/9j\//);
    assert.ok(result.screenshot.length < 80_000);
    const clipped = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const { width, height } = document.querySelector('#save').getBoundingClientRect();
      return Math.abs(image.naturalWidth - width) <= 1 && Math.abs(image.naturalHeight - height) <= 1;
    }, result.screenshot);
    assert.equal(clipped, true);
    assert.deepEqual(result.viewport, { width: 800, height: 600 });
  },
);

test('Enter picks the focused element; Escape and abort cancel selection', { skip: !chrome }, async (t) => {
  const { page, url } = await setup(t);
  let choice = pickInPage(page, url, AbortSignal.timeout(10_000));
  void choice.catch(() => {});
  await page.waitForSelector('#go');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'go');
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyP');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  await page.keyboard.press('Enter');
  assert.equal((await choice).name, 'Edit note');
  assert.equal(page.url(), url);
  await page.goto('about:blank');
  choice = pickInPage(page, url, AbortSignal.timeout(10_000));
  void choice.catch(() => {});
  await page.waitForSelector('#go');
  await page.keyboard.press('Escape');
  await assert.rejects(choice, /cancel/i);
  await page.goto('about:blank');
  const controller = new AbortController();
  choice = pickInPage(page, url, controller.signal);
  void choice.catch(() => {});
  await page.waitForSelector('#go');
  controller.abort();
  await assert.rejects(choice);
});

test('a picker rejects unowned origins before starting Chrome', async () => {
  await assert.rejects(
    pickPreviewElement('http://127.0.0.1:3000', new AbortController().signal),
    /owned preview/,
  );
});

test(
  'aborting a visible picker closes its dedicated browser',
  { skip: !chrome || !process.env.MITER_TEST_VISIBLE_PICKER },
  async (t) => {
    const { url } = await setup(t);
    const controller = new AbortController();
    const choice = pickPreviewElement(url, controller.signal);
    void choice.catch(() => {});
    await delay(1800);
    controller.abort();
    await assert.rejects(choice, /selection ended/);
  },
);
