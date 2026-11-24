import assert from 'node:assert/strict';
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorMessage, isMainModule, parseContract } from '../helpers/runtime.mjs';
import { runBounded } from './bounded-process.mjs';
import { ChromePipe, browserEnvironment } from './chrome-pipe.mjs';
import { checkPreviewSandbox } from './chrome-preview.mjs';
import { checkDomReader } from './chrome-dom-reader.mjs';
import { checkAppFoundation } from './chrome-app-foundation.mjs';
import { checkAppComponents } from './chrome-app-components.mjs';
import { checkSetup } from './chrome-setup.mjs';
import { checkProjectHome } from './chrome-project-home.mjs';
import { checkProjectForm } from './chrome-project-form.mjs';
import { checkWorkspaceJourney } from './chrome-workspace-journey.mjs';
import { preparePickerHost } from './chrome-picker-host.mjs';
import { checkTaskRecovery } from './chrome-task-recovery.mjs';
import { checkStaticPreview } from './chrome-static-preview.mjs';
import { checkAppRun } from './chrome-app-run.mjs';
import { checkDocs, openHelpItem } from './chrome-docs.mjs';
import { checkConfirmation } from './chrome-confirmation.mjs';
import { checkFeedback } from './chrome-feedback.mjs';
import { assertNoSystemHost, installNativeHost } from './chrome-native.mjs';
import { writePackagedFixture, assertPackagedFixtureStylesheets } from './chrome-styles.mjs';
import {
  browserVersionSchema,
  chromeDiagnosticsSchema,
  chromeLogNameSchema,
  extensionIdSchema,
  nativeCheckSchema,
  targetCloseSchema,
} from './chrome-schemas.mjs';
import { evaluate, waitFor, page, press, click, checkDialogs, checkResources } from './chrome-ui.mjs';

const root = path.resolve(import.meta.dirname, '../..');

async function checkTerminalAfterRebuild(chrome, session, extension) {
  const chunks = path.join(extension, 'chunks');
  const previousChunks = path.join(extension, 'previous-chunks');
  assert.equal(await evaluate(chrome, session, '!document.querySelector(".terminal-dock")'), true);

  // A source rebuild can replace all old chunks while this document stays open.
  await rename(chunks, previousChunks);
  try {
    await click(chrome, session, '.statusbar button[title^="App runs and shells"]');
    await waitFor(
      chrome,
      session,
      `document.querySelector('[aria-label="Local terminal"]')?.checkVisibility() === true`,
      'the first terminal open works after the loaded build’s chunks move',
    );
  } finally {
    await rename(previousChunks, chunks);
  }
}

async function main() {
  if (process.argv.length > 2 || !['darwin', 'linux'].includes(process.platform)) {
    throw new Error(
      'Usage: CHROME_PATH=/absolute/chrome node scripts/release-checks/chrome.mjs (macOS or Linux).',
    );
  }

  let executable = process.env.CHROME_PATH;

  if (executable === undefined && process.platform === 'darwin') {
    executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  if (!executable || !path.isAbsolute(executable)) {
    throw new Error('Set CHROME_PATH to your installed Chrome executable’s absolute path.');
  }

  const logName = parseContract(
    chromeLogNameSchema,
    process.env.MITTER_CHROME_LOG ?? 'chrome.log',
    'MITTER_CHROME_LOG must be a .log basename inside .cache/release-checks, not a path.',
  );
  const controller = new AbortController();
  const signal = controller.signal;
  const interrupt = () => controller.abort(new Error('Live Chrome check interrupted.'));
  const timer = setTimeout(() => {
    controller.abort(new Error('Live Chrome check exceeded its two-minute limit, including preparation.'));
  }, 120000);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  let directory;
  let log;
  let chrome;
  const logPath = path.join(root, '.cache/release-checks', logName);

  try {
    await access(executable);
    await assertNoSystemHost();
    signal.throwIfAborted();
    directory = await mkdtemp(path.join(os.tmpdir(), 'mitter-chrome-'));
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, '', { mode: 0o600 });
    log = await open(logPath, 'a');
    // Preparation validates ownership against the original system temp root.
    // Chrome itself switches to its private tmp directory after preparation creates it.
    const env = {
      ...browserEnvironment(directory),
      TMPDIR: os.tmpdir(),
      TMP: os.tmpdir(),
      TEMP: os.tmpdir(),
    };

    for (const args of [
      ['scripts/verify-build.mjs'],
      ['scripts/release-checks/chrome-prepare.mjs', directory],
    ]) {
      await runBounded({ cwd: root, env, args, log: logPath, timeoutMs: 30000, signal });
    }

    signal.throwIfAborted();
    chrome = new ChromePipe(executable, directory, log.fd, signal);
    const version = parseContract(
      browserVersionSchema,
      await chrome.request('Browser.getVersion'),
      'Chrome did not return its browser version.',
    );
    console.log('Live browser:', version.product);
    const { id } = parseContract(
      extensionIdSchema,
      await chrome.request('Extensions.loadUnpacked', { path: path.join(directory, 'extension') }),
      'Chrome did not return a valid unpacked extension ID.',
    );
    console.log('Loaded packaged extension:', id);
    const { hostScript, modelPath } = await preparePickerHost(directory);
    const native = await installNativeHost(directory, id, { hostScript });
    signal.throwIfAborted();

    const app = await page(chrome, `chrome-extension://${id}/workspace.html`);
    await waitFor(
      chrome,
      app.session,
      'document.querySelector(".app-shell") !== null',
      'packaged workspace mount',
    );
    assert.equal(await evaluate(chrome, app.session, 'chrome.runtime.id'), id);
    await waitFor(
      chrome,
      app.session,
      '!!document.querySelector(".settings-button:enabled")',
      'helper connected',
    );
    assert.equal(
      await evaluate(chrome, app.session, '!!document.querySelector(".titlebar .health-button")'),
      false,
    );
    await openHelpItem(chrome, app.session, 'Setup & connection');
    await waitFor(
      chrome,
      app.session,
      'document.querySelector("dialog[open] h2")?.textContent === "Setup & connection"',
      'packaged health dialog',
    );
    await press(chrome, app.session, 'Escape', 27);
    await waitFor(
      chrome,
      app.session,
      'document.querySelector("dialog[open]") === null',
      'packaged dialog dismissal',
    );
    await checkAppRun(executable, directory, path.join(directory, 'extension'), log.fd, signal);
    console.log(
      'PASS: Run opens the completed app in a browser tab and manages its existing terminal session.',
    );
    await checkDocs(chrome, app.session, id);
    console.log('PASS: Help opens searchable docs with keyboard navigation, deep links and live schemas.');
    const workspacePage = path.join(directory, 'extension', 'workspace.html');
    const productionWorkspace = await readFile(workspacePage, 'utf8');
    const packagedStyles = await writePackagedFixture(
      chrome,
      app.session,
      path.join(directory, 'extension'),
      id,
    );
    console.log('PASS: packaged extension loads, mounts, and opens/dismisses its health dialog.');

    const fixture = await page(chrome, `chrome-extension://${id}/workspace.html?release-fixture=1`);
    await waitFor(
      chrome,
      fixture.session,
      'typeof window.mitterReleaseFixture === "object"',
      'Solid DOM fixture mount',
    );
    await assertPackagedFixtureStylesheets(chrome, fixture.session, packagedStyles);
    await appendFile(logPath, '\nPackaged fixture stylesheets: ' + JSON.stringify(packagedStyles) + '\n');
    const nativeResult = parseContract(
      nativeCheckSchema,
      await evaluate(
        chrome,
        fixture.session,
        `window.mitterReleaseFixture.checkNative(${JSON.stringify(native.project)})`,
      ),
      'The isolated native host did not return a valid smoke-check result.',
    );
    assert.equal(nativeResult.root, await realpath(native.project));
    assert.ok((await lstat(path.join(native.state, 'mitter.sqlite'))).isFile());
    console.log('PASS: production client/background/native host save and read back a temporary project.');
    await appendFile(logPath, '\nNative round trip: ' + JSON.stringify(nativeResult) + '\n');
    // The loaded fixture keeps its document while the real workspace reloads.
    await writeFile(workspacePage, productionWorkspace, 'utf8');
    await checkWorkspaceJourney(chrome, app.session, native.project, modelPath);
    await checkTerminalAfterRebuild(chrome, app.session, path.join(directory, 'extension'));
    parseContract(
      targetCloseSchema,
      await chrome.request('Target.closeTarget', { targetId: app.targetId }),
      'Chrome did not confirm closure of the packaged workspace page.',
    );
    console.log(
      'PASS: real workspace create/open/reopen project, first task and saved navigation without duplicates.',
    );
    console.log('PASS: picking and pasting images, preserving draft attachments through reload and rewrite.');
    console.log('PASS: the first terminal open works even after the loaded build’s chunks move.');

    const readerEvidence = await checkDomReader(chrome, fixture.session, id, {
      onEvidence: (evidence) =>
        appendFile(logPath, '\nOffline packaged page-reader evidence: ' + JSON.stringify(evidence) + '\n'),
    });
    console.log(
      `PASS: packaged ISOLATED top-frame page bridge; ${readerEvidence.length} offline DOM-reader observations, exact source bytes, receipt barriers, read-only probe and digest/session fencing.`,
    );

    await checkDialogs(chrome, fixture.session);
    await checkTaskRecovery(chrome, fixture.session);
    await checkSetup(chrome, fixture.session);
    await checkProjectHome(chrome, fixture.session);
    await checkProjectForm(chrome, fixture.session);
    await checkConfirmation(chrome, fixture.session);
    console.log(
      'PASS: styled confirmations, keyboard focus, duplicate prevention, stale ownership and cleanup.',
    );
    await checkFeedback(chrome, fixture.session);
    console.log(
      'PASS: file loading, retry and empty states; independent notification settings and in-dialog feedback.',
    );
    console.log(
      'PASS: first-run setup, missing helper, version mismatch, unsupported checks and recovery controls at 1024/320/290px.',
    );
    const foundation = await checkAppFoundation(chrome, fixture.session);
    console.log('Working app components:', await checkAppComponents(chrome, directory, id));
    await appendFile(logPath, '\nApp foundation browser checks: ' + JSON.stringify(foundation) + '\n');
    console.log(
      'PASS: bundled app foundation styles, native forms, pointer/keyboard focus, RTL, scrolling and accessibility preferences.',
    );
    console.log('PASS: task attention layout uses only the packaged workspace stylesheets.');
    console.log(
      'PASS: native validation, in-dialog errors, Escape/focus restoration, and stale-save ownership.',
    );
    await checkResources(chrome, fixture.session);
    await checkPreviewSandbox(chrome, fixture.session, id);
    console.log(
      'PASS: packaged preview ready/payload, opaque sender rejection, malformed-data fencing, exact render and one-use gate.',
    );
    await evaluate(chrome, fixture.session, 'window.mitterReleaseFixture.destroy()');
    const exceptions = chrome.events.filter((event) => event.method === 'Runtime.exceptionThrown');
    assert.deepEqual(exceptions, [], 'Live pages must not produce uncaught exceptions.');
    console.log(
      'PASS: preview Blob release, late-read fencing, FontFace cleanup, and 30 mount/dispose cycles.',
    );
    const staticPreview = await checkStaticPreview(executable, directory, log.fd, signal);
    await appendFile(logPath, '\nStatic app preview: ' + JSON.stringify(staticPreview) + '\n');
    console.log(
      'PASS: real static preview HTTP server, module imports, CSS, reload storage and separate origins.',
    );
    await appendFile(
      logPath,
      '\nPASS: live Chrome, isolated native round trip, offline packaged page reader, packaged sandbox and production component checks.\n',
    );
  } finally {
    clearTimeout(timer);
    try {
      try {
        try {
          if (chrome !== undefined) {
            const diagnostics = parseContract(
              chromeDiagnosticsSchema,
              chrome.events,
              'Invalid retained Chrome diagnostics. Inspect the live release-check output.',
            );
            await appendFile(logPath, '\nChrome diagnostics: ' + JSON.stringify(diagnostics) + '\n');
          }
        } finally {
          await chrome?.close();
        }
      } finally {
        try {
          await log?.close();
        } finally {
          if (directory !== undefined) {
            await rm(directory, { recursive: true, force: true, maxRetries: 3 });
            console.log(
              'Removed temporary Chrome profile, registration, extension, HOME and state. Log: ' + logPath,
            );
          }
        }
      }
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error('Live Chrome verification failed:', errorMessage(error));
    process.exitCode = 1;
  }
}
