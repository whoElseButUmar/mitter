import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { browserExecutable } from './browser-executable.ts';
import { checkNativeValidation } from './browser-validation.ts';

const executablePath = await browserExecutable();

test(
  'native empty-submit feedback is detected while custom errors, hidden and complete controls are preserved',
  { skip: !executablePath, timeout: 15000 },
  async () => {
    const browser = await puppeteer.launch({
      executablePath,
      pipe: true,
      headless: true,
      args: [
        '--disable-background-networking',
        '--no-first-run',
        '--no-default-browser-check',
        '--proxy-server=http://127.0.0.1:9',
        '--proxy-bypass-list=<-loopback>',
        '--use-mock-keychain',
        '--password-store=basic',
      ],
    });
    const child = browser.process();
    try {
      const page = await browser.newPage();
      await page.setContent(`<main class="ui">
        <form id="native"><label>Tool <input required></label><button>Save</button></form>
        <form id="custom"><label>Borrower <input id="borrower" required aria-describedby="error"></label>
          <button>Save</button><p id="error" role="alert"></p></form>
        <form id="check"><label>Title <input required></label><button>Check</button></form>
        <form id="novalidate" novalidate><label>Name <input required></label><button>Save</button></form>
        <form id="prefilled"><label>Item <input required value="Saw"></label><button>Save</button></form>
        <form id="disabled"><label>Title <input required></label><button disabled>Save</button></form>
        <form id="hidden" hidden><label>Name <input required></label><button>Save</button></form>
      </main>
      <form id="plain"><label>Name <input required></label><button>Save</button></form>
      <script>
        const custom = document.querySelector('#custom');
        custom.addEventListener('invalid', event => {
          event.preventDefault();
          document.querySelector('#error').textContent = 'Enter a borrower.';
          event.target.setAttribute('aria-invalid','true');
          event.target.focus();
        }, true);
        document.querySelector('#check button').onclick = event => {
          event.preventDefault();
          event.target.form.checkValidity();
        };
        for(const id of ['prefilled','novalidate','hidden','disabled','plain']) {
          document.querySelector('#'+id+' button').addEventListener('click', () => document.body.dataset.unexpected = id);
        }
      </script>`);
      const findings = await page.evaluate(checkNativeValidation);
      assert.equal(findings.length, 1, JSON.stringify(findings));
      assert.match(findings[0], /^#native shows browser-native validation/);
      assert.equal(await page.$eval('#error', (node) => node.textContent), 'Enter a borrower.');
      assert.equal(await page.$eval('#borrower', (node) => node.getAttribute('aria-invalid')), 'true');
      assert.equal(await page.$eval('body', (node) => node.dataset.unexpected), undefined);
    } finally {
      try {
        await browser.close();
      } finally {
        child?.stderr?.destroy();
        child?.stdout?.destroy();
      }
    }
  },
);
