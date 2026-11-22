import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { parseContract } from '../helpers/runtime.mjs';
import { browserTargetsSchema, sessionIdSchema } from './chrome-schemas.mjs';
import { evaluate, waitFor, click, press } from './chrome-ui.mjs';

export async function checkDocs(chrome, workspace, extensionId) {
  await evaluate(
    chrome,
    workspace,
    `[...document.querySelectorAll('.statusbar .menu-trigger')]
      .find(button => button.textContent.trim() === 'Help').click()`,
  );
  await waitFor(
    chrome,
    workspace,
    `[...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent.trim() === 'Documentation')`,
    'Documentation appears in Help',
  );
  await evaluate(
    chrome,
    workspace,
    `[...document.querySelectorAll('[role="menuitem"]')]
      .find(item => item.textContent.trim() === 'Documentation').click()`,
  );

  const url = 'chrome-extension://' + extensionId + '/docs.html';
  const deadline = Date.now() + 5000;
  let target;
  while (!target && Date.now() < deadline) {
    const { targetInfos } = parseContract(
      browserTargetsSchema,
      await chrome.request('Target.getTargets'),
      'Read the documentation tab opened from Help.',
    );
    target = targetInfos.find((entry) => entry.type === 'page' && entry.url === url);
    if (!target) {
      await delay(40);
    }
  }
  assert.ok(target, 'Help opens the bundled documentation page in a tab.');

  try {
    const { sessionId } = parseContract(
      sessionIdSchema,
      await chrome.request('Target.attachToTarget', { targetId: target.targetId, flatten: true }),
      'Attach to the packaged documentation page.',
    );
    await chrome.request('Page.enable', {}, sessionId);
    await waitFor(
      chrome,
      sessionId,
      'document.querySelector("h1")?.textContent === "Introduction"',
      'docs introduction',
    );
    await click(chrome, sessionId, '.docs-article a[href="#getting-started"]');
    await waitFor(
      chrome,
      sessionId,
      'location.hash === "#getting-started" && document.activeElement?.textContent === "Getting started"',
      'the first guide opens and receives focus',
    );

    await evaluate(chrome, sessionId, 'document.querySelector("#docs-search").focus()');
    await chrome.request('Input.insertText', { text: 'replyTo' }, sessionId);
    await waitFor(
      chrome,
      sessionId,
      `!!document.querySelector('.docs-result-list a[href="#reply-shape"]')`,
      'replyTo finds the ChatGPT reply format',
    );
    await click(chrome, sessionId, '.docs-result-list a[href="#reply-shape"]');
    await waitFor(
      chrome,
      sessionId,
      'location.hash === "#reply-shape" && !!document.querySelector(".docs-schema")',
      'reply format deep link',
    );
    await click(chrome, sessionId, '.docs-schema summary');
    await waitFor(
      chrome,
      sessionId,
      `(() => {
        const code = document.querySelector('.docs-schema[open] pre');
        return code?.checkVisibility() === true && JSON.parse(code.textContent).required.includes('replyTo');
      })()`,
      'the generated automatic reply schema includes required correlation',
    );

    await evaluate(
      chrome,
      sessionId,
      `Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async content => { window.docsTestCopy = content; }
      })`,
    );
    await click(chrome, sessionId, '.docs-schema[open] button');
    await waitFor(
      chrome,
      sessionId,
      `window.docsTestCopy === document.querySelector('.docs-schema[open] pre').textContent`,
      'the copy button copies the schema',
    );

    await chrome.request(
      'Emulation.setDeviceMetricsOverride',
      { width: 320, height: 700, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await waitFor(
      chrome,
      sessionId,
      'document.querySelector(".docs-browse").checkVisibility()',
      'compact topic navigation',
    );
    assert.equal(await evaluate(chrome, sessionId, 'document.documentElement.scrollWidth'), 320);
    assert.equal(
      await evaluate(chrome, sessionId, 'document.querySelector("#docs-topics").checkVisibility()'),
      false,
    );
    await evaluate(chrome, sessionId, 'document.querySelector(".docs-browse").focus()');
    await press(chrome, sessionId, 'Enter', 13);
    await waitFor(
      chrome,
      sessionId,
      'document.querySelector("#docs-topics").checkVisibility()',
      'keyboard opens compact topic navigation',
    );
    await chrome.request('Page.reload', {}, sessionId);
    await waitFor(
      chrome,
      sessionId,
      'document.readyState === "complete" && document.querySelector("h1")?.textContent === "ChatGPT reply format"',
      'reload keeps the selected documentation topic',
    );
  } finally {
    await chrome.request('Target.closeTarget', { targetId: target.targetId });
  }
}
