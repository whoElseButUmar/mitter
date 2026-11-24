import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { previewCaptureLimit } from '../../../../../packages/protocol/src/rpc.js';
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
    <span id="save-name">Save note</span>
    <button id="open-list" onclick="document.querySelector('dialog').showModal()">Open list</button>
    <dialog><ul id="list" aria-label="Recent notes" style="width:650px;padding:20px"><li>First note</li></ul></dialog>`;
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
async function pickerButton(page, accessibleName) {
  const session = await page.createCDPSession();
  try {
    const { root } = await session.send('DOM.getDocument');
    const { nodes } = await session.send('Accessibility.queryAXTree', {
      nodeId: root.nodeId,
      accessibleName,
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

async function waitForPickerStatus(page, accessibleName) {
  const session = await page.createCDPSession();
  try {
    const { root } = await session.send('DOM.getDocument');
    for (let attempt = 0; attempt < 80; attempt++) {
      const { nodes } = await session.send('Accessibility.queryAXTree', {
        nodeId: root.nodeId,
        accessibleName,
      });
      if (nodes.length) {
        return;
      }
      await delay(25);
    }
    assert.fail('Missing picker status: ' + accessibleName);
  } finally {
    await session.detach();
  }
}

async function modifiedClick(page, key, selector, options) {
  await page.keyboard.down(key);
  try {
    await page.click(selector, options);
  } finally {
    await page.keyboard.up(key);
  }
}

async function assertHighlight(page, selector) {
  const session = await page.createCDPSession();
  try {
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId: toolbarId } = await session.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: 'miter-picker-toolbar',
    });
    const { node: toolbar } = await session.send('DOM.describeNode', { nodeId: toolbarId, pierce: true });
    const shadow = toolbar.shadowRoots?.[0];
    assert.ok(shadow);
    const { nodeId } = await session.send('DOM.querySelector', {
      nodeId: shadow.nodeId,
      selector: '.outline:not([hidden])',
    });
    const { model } = await session.send('DOM.getBoxModel', { nodeId });
    const expected = await page.$eval(selector, (element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return [left, top, right, top, right, bottom, left, bottom];
    });
    assert.deepEqual(model.border.map(Math.round), expected.map(Math.round));
  } finally {
    await session.detach();
  }
}

const singleCapture = '1 captured. Click to replace or Shift-click to add.';

test('plain clicks keep only the most recent successful capture', { skip: !chrome }, async (t) => {
  const { page, url } = await setup(t);
  const choice = pickInPage(page, url, AbortSignal.timeout(10_000));
  void choice.catch(() => {});
  await page.waitForSelector('#go');
  await page.click('#go');
  await waitForPickerStatus(page, singleCapture);
  await Promise.all([page.waitForNavigation(), modifiedClick(page, 'Alt', '#go')]);
  await waitForPickerStatus(page, singleCapture);

  await page.click('#save');
  await waitForPickerStatus(page, singleCapture);
  await page.click('#private');
  await waitForPickerStatus(page, 'Choose a visible area away from private fields.');
  await pickerButton(page, 'Done');
  assert.deepEqual(
    (await choice).map(({ name }) => name),
    ['Save note'],
  );
  assert.equal(await page.evaluate(() => document.body.dataset.activated), undefined);
});

test(
  'Chrome captures immediately, passes Option-click, and adds with Shift-click across navigation and a modal',
  { skip: !chrome },
  async (t) => {
    const { page, url } = await setup(t);
    const choice = pickInPage(page, url, AbortSignal.timeout(12_000));
    void choice.catch(() => {});
    await page.waitForSelector('#go');
    assert.equal(await page.evaluate(() => typeof window.miterPick), 'undefined');
    await page.hover('#go');
    await assertHighlight(page, '#go');
    assert.equal(await page.$eval('#go', (element) => element.matches(':hover')), false);
    await page.click('#go');
    await waitForPickerStatus(page, singleCapture);
    assert.equal(page.url(), url);
    await Promise.all([page.waitForNavigation(), modifiedClick(page, 'Alt', '#go')]);
    await waitForPickerStatus(page, singleCapture);
    await page.click('#private');
    await waitForPickerStatus(page, 'Choose a visible area away from private fields.');
    await modifiedClick(page, 'Shift', '#save');
    await waitForPickerStatus(page, '2 captured. Click to replace or Shift-click to add.');
    assert.equal(await page.evaluate(() => document.body.dataset.activated), undefined);
    await modifiedClick(page, 'Alt', '#open-list');
    await page.waitForSelector('dialog:modal #list');
    await modifiedClick(page, 'Shift', '#list', { offset: { x: 8, y: 8 } });
    await waitForPickerStatus(page, '3 captured. Click to replace or Shift-click to add.');
    await pickerButton(page, 'Done');
    const captures = await choice;
    assert.deepEqual(
      captures.map((capture) => capture.name),
      ['Edit note', 'Save note', 'Recent notes'],
    );
    const result = captures[1];
    assert.equal(result.role, 'button');
    assert.equal(result.name, 'Save note');
    assert.equal(result.route, '/edit.html');
    assert.equal(await page.$eval(result.selector, (el) => el.id), 'save');
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
    const listImageWidth = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      return image.naturalWidth;
    }, captures[2].screenshot);
    assert.ok(listImageWidth > 640);
    assert.deepEqual(result.viewport, { width: 800, height: 600 });
  },
);

test('clicking can replace a full selection', { skip: !chrome }, async (t) => {
  const { page, url } = await setup(t);
  const choice = pickInPage(page, url, AbortSignal.timeout(15_000));
  void choice.catch(() => {});
  await page.waitForSelector('#go');
  await page.click('#go');
  await waitForPickerStatus(page, singleCapture);

  for (let count = 2; count <= previewCaptureLimit; count++) {
    await modifiedClick(page, 'Shift', '#go');
    if (count < previewCaptureLimit) {
      await waitForPickerStatus(page, count + ' captured. Click to replace or Shift-click to add.');
    }
  }
  const fullSelection = previewCaptureLimit + ' captured. Click to replace or choose Done.';
  await waitForPickerStatus(page, fullSelection);
  await modifiedClick(page, 'Shift', '#go');
  await waitForPickerStatus(page, fullSelection);
  await page.click('#go');
  await waitForPickerStatus(page, singleCapture);
  await pickerButton(page, 'Done');
  assert.deepEqual(
    (await choice).map(({ name }) => name),
    ['Edit note'],
  );
});

test('Enter replaces, Shift+Enter adds, and Escape and abort cancel', { skip: !chrome }, async (t) => {
  const { page, url } = await setup(t);
  let choice = pickInPage(page, url, AbortSignal.timeout(10_000));
  void choice.catch(() => {});
  await page.waitForSelector('#go');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'go');
  await page.keyboard.press('Enter');
  await waitForPickerStatus(page, singleCapture);
  await Promise.all([page.waitForNavigation(), modifiedClick(page, 'Alt', '#go')]);
  await waitForPickerStatus(page, singleCapture);
  await page.focus('#open-list');
  await page.keyboard.down('Shift');
  try {
    await page.keyboard.press('Enter');
  } finally {
    await page.keyboard.up('Shift');
  }
  await waitForPickerStatus(page, '2 captured. Click to replace or Shift-click to add.');
  await page.focus('#save');
  await page.keyboard.press('Enter');
  await waitForPickerStatus(page, singleCapture);
  await pickerButton(page, 'Done');
  assert.deepEqual(
    (await choice).map(({ name }) => name),
    ['Save note'],
  );
  assert.equal(await page.evaluate(() => document.body.dataset.activated), undefined);
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
