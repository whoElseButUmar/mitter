import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { assertNoSystemHost, installNativeHost } from './chrome-native.mjs';
import { ChromePipe } from './chrome-pipe.mjs';
import { browserTargetsSchema, extensionIdSchema, sessionIdSchema } from './chrome-schemas.mjs';
import { evaluate, page, waitFor } from './chrome-ui.mjs';

const root = path.resolve(import.meta.dirname, '../..');

async function targets(chrome) {
  return browserTargetsSchema.parse(await chrome.request('Target.getTargets')).targetInfos;
}

async function recoveredWorkspace(chrome, url, previousWorker) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const current = await targets(chrome);
    const restarted = current.some(
      (target) =>
        target.type === 'service_worker' &&
        target.url === previousWorker.url &&
        target.targetId !== previousWorker.targetId,
    );
    const workspace = current.find((target) => target.type === 'page' && target.url === url);
    if (restarted && workspace) {
      const { sessionId } = sessionIdSchema.parse(
        await chrome.request('Target.attachToTarget', { targetId: workspace.targetId, flatten: true }),
      );
      await waitFor(
        chrome,
        sessionId,
        '!!document.querySelector(".settings-button:enabled")',
        'restored local helper connection',
      );
      return sessionId;
    }
    await delay(100);
  }
  throw new Error('Reload did not reopen the workspace with a fresh extension background.');
}

test(
  'a real workspace detects different helper source at the same release and reconnects after Reload extension',
  {
    skip: process.env.MITER_TEST_BUILD_RECOVERY !== '1',
    timeout: 90_000,
  },
  async (t) => {
    await assertNoSystemHost();
    const executable =
      process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'miter-build-recovery-')));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Chrome recovery trial timed out.')), 60_000);
    let chrome;
    let log;
    try {
      const release = path.join(directory, 'release');
      const dist = path.join(release, 'dist');
      const extension = path.join(directory, 'extension');
      await mkdir(release);
      await mkdir(path.join(directory, 'tmp'));
      await cp(path.join(root, 'dist'), dist, { recursive: true, verbatimSymlinks: true });
      await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, { recursive: true });
      await symlink(path.join(root, 'node_modules'), path.join(release, 'node_modules'), 'dir');
      await writeFile(path.join(release, 'package.json'), '{"type":"module"}\n');
      const modulePath = path.join(dist, 'packages/protocol/src/build-id.js');
      // Refuse an externally linked module before touching any emitted byte.
      assert.equal(await realpath(modulePath), modulePath);
      const moduleSource = await readFile(modulePath, 'utf8');
      const { BUILD_ID } = await import(pathToFileURL(modulePath));
      const { APP_VERSION, EXTENSION_ID } = await import(
        pathToFileURL(path.join(dist, 'packages/protocol/src/constants.js'))
      );
      assert.match(BUILD_ID, /^[a-f0-9]{16}$/, 'Run pnpm build to produce a fingerprinted helper.');
      const wrong = (BigInt('0x' + BUILD_ID) ^ 1n).toString(16).padStart(16, '0');
      const stamp = 'const __MITER_BUILD_ID__ = "' + BUILD_ID + '";';
      assert.ok(moduleSource.startsWith(stamp));
      await writeFile(modulePath, moduleSource.replace(stamp, stamp.replace(BUILD_ID, wrong)));
      await installNativeHost(directory, EXTENSION_ID, {
        hostScript: path.join(dist, 'apps/host/src/native.js'),
      });

      log = await open(path.join(directory, 'chrome.log'), 'w', 0o600);
      chrome = new ChromePipe(executable, directory, log.fd, controller.signal);
      // Chrome accepts loadUnpacked through CDP with developer mode off, then disables
      // that copy on runtime.reload(). Match the developer profile used by real installations.
      const manager = await page(chrome, 'chrome://extensions/');
      const toggle =
        'document.querySelector("extensions-manager")?.shadowRoot?.querySelector("extensions-toolbar")?.shadowRoot?.querySelector("#devMode")';
      await waitFor(chrome, manager.session, '!!(' + toggle + ')', 'isolated profile developer mode');
      await evaluate(
        chrome,
        manager.session,
        '(() => { const control = ' + toggle + '; if (!control.checked) control.click(); return true; })()',
      );
      await waitFor(
        chrome,
        manager.session,
        '(' + toggle + ').checked === true',
        'enable unpacked extension reloads',
      );
      const { id } = extensionIdSchema.parse(
        await chrome.request('Extensions.loadUnpacked', { path: extension }),
      );
      assert.equal(id, EXTENSION_ID);
      const url = 'chrome-extension://' + id + '/workspace.html';
      const app = await page(chrome, url);
      const rows =
        '(Array.from(document.querySelectorAll(".build-versions dd"), el => el.textContent.trim()))';
      const expected = APP_VERSION + ' (build ' + BUILD_ID + ')';
      const mismatched = APP_VERSION + ' (build ' + wrong + ')';
      await waitFor(
        chrome,
        app.session,
        rows + '.includes(' + JSON.stringify(mismatched) + ')',
        'different helper fingerprint',
      );
      assert.deepEqual(await evaluate(chrome, app.session, rows), [expected, mismatched]);
      assert.equal(
        await evaluate(chrome, app.session, '!!document.querySelector(".settings-button:enabled")'),
        false,
      );
      const previousWorker = (await targets(chrome)).find(
        (target) =>
          target.type === 'service_worker' && target.url.startsWith('chrome-extension://' + id + '/'),
      );
      assert.ok(previousWorker, 'The mismatched workspace must have a running background.');
      await writeFile(modulePath, moduleSource);

      // Invoke the production control exactly once. The application owns reopening the workspace.
      const clicked = await evaluate(
        chrome,
        app.session,
        `(() => {
      const reload = Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Reload extension');
      if (!reload || reload.disabled) return false;
      setTimeout(() => reload.click(), 100);
      return true;
    })()`,
      );
      assert.equal(clicked, true, 'Expected the enabled Reload extension action.');
      const recovered = await recoveredWorkspace(chrome, url, previousWorker);
      await waitFor(chrome, recovered, rows + '.length === 2', 'matching workspace and helper identities');
      assert.deepEqual(await evaluate(chrome, recovered, rows), [expected, expected]);
      t.diagnostic(
        'Same release ' +
          APP_VERSION +
          '. Extension ' +
          BUILD_ID +
          ', mismatched helper ' +
          wrong +
          ', recovered helper ' +
          BUILD_ID +
          '.',
      );
    } finally {
      clearTimeout(timer);
      try {
        await chrome?.close();
      } finally {
        await log?.close();
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  },
);
