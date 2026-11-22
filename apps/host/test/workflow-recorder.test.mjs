import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { browserExecutable } from '../src/core/quality/browser-executable.ts';
import { installRecorder } from '../src/core/workflows/recorder-page.ts';

test(
  'the recorder follows navigation, protects private controls, and selects a result without activating it',
  { timeout: 25000 },
  async (t) => {
    const executablePath = await browserExecutable();
    if (!executablePath) {
      t.skip('Chrome is unavailable.');
      return;
    }
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/next') {
        response.end('<button id="result" onclick="this.remove()">Packed</button>');
        return;
      }
      response.end('<input type="password"><input name="item"><a href="/next">Submit</a>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const origin = 'http://127.0.0.1:' + server.address().port;
    const browser = await puppeteer.launch({
      executablePath,
      pipe: true,
      args: ['--no-first-run', '--disable-background-networking', '--use-mock-keychain'],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(origin);
    const steps = [];
    const recorder = await installRecorder(page, origin, (step) => steps.push(step));
    try {
      assert.equal(await page.evaluate(() => typeof globalThis.miterRecordStep), 'undefined');
      await page.type('input[type=password]', 'sensitive');
      await page.type('[name=item]', 'Hat');
      await Promise.all([page.waitForNavigation(), page.click('a')]);
      await recorder.arm();
      await assert.rejects(recorder.arm(), /Choose the expected result/);
      await page.click('#result');
      assert.equal(await page.$eval('#result', (el) => el.textContent), 'Packed');
      assert.deepEqual(steps.at(-1), { type: 'expect', selector: '#result', visible: true, text: 'Packed' });
      assert.equal(steps.filter((s) => s.type === 'click').length, 1);
      assert.deepEqual(
        steps.filter((s) => s.type === 'fill').map((s) => s.value),
        ['H', 'Ha', 'Hat'],
      );
    } finally {
      await recorder.dispose();
    }
  },
);
