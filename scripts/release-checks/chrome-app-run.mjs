import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { parseContract } from '../helpers/runtime.mjs';
import { installNativeHost } from './chrome-native.mjs';
import { ChromePipe } from './chrome-pipe.mjs';
import { browserTargetsSchema, extensionIdSchema, sessionIdSchema } from './chrome-schemas.mjs';
import { click, evaluate, page, press, waitFor } from './chrome-ui.mjs';
import { checkAppearanceSettings } from './chrome-settings.mjs';

const firstTask = 'Cozy Desk Kanban';
const secondTask = 'Studio inventory';
const entry = '<!doctype html><title>Run session</title>';
const picker = '.terminal-session-picker select';

async function completeProject(native) {
  const { openNodeSqlite } = await import('../../dist/apps/host/src/adapters/sqlite.js');
  const { Store } = await import('../../dist/apps/host/src/core/database.js');
  const { Service } = await import('../../dist/apps/host/src/core/service.js');
  const { referenceWorkflow } = await import('../../dist/apps/host/src/core/workflow.js');
  const store = new Store(openNodeSqlite(path.join(native.state, 'mitter.sqlite')));
  const service = new Service(store, native.state, referenceWorkflow, {
    propose() {
      throw new Error('The app run journey must not start a model.');
    },
    close() {},
  });
  try {
    await writeFile(path.join(native.project, 'index.html'), entry);
    const project = await service.handle('project.add', { name: 'Run session', root: native.project });
    for (const name of [secondTask, firstTask]) {
      const worker = await service.handle('worker.create', {
        projectId: project.id,
        name,
        goal: 'Check whether index.html exists.',
        mode: 'handoff',
        checks: [{ type: 'exists', path: 'index.html' }],
      });
      const summary = 'The existing project entry is available.';
      const changes = [];
      if (name === firstTask) {
        for (let index = 1; index <= 12; index++) {
          changes.push({
            type: 'write',
            path: 'notes/file-' + index + '.txt',
            base: 'missing',
            content: 'Saved project note ' + index,
          });
        }
      }
      await service.handle('worker.import', {
        workerId: worker.id,
        text: JSON.stringify({
          protocol: 'mitter/1',
          id: randomUUID(),
          workerId: worker.id,
          projectId: project.id,
          summary,
          actions: [...changes, { type: 'finish', summary }],
        }),
      });
      await service.handle('worker.run', { workerId: worker.id });
      await service.wait(worker.id);
      assert.equal(
        service.workers.get(worker.id)?.completion?.verification,
        'passed',
        'The file-existence check must pass before the browser exercises Run for ' + name,
      );
    }
  } finally {
    await service.close();
  }
}

async function checkFileHandoff(chrome, session) {
  const opener = `[...document.querySelectorAll('.task-handoff-actions button')].find(button => button.textContent.trim() === 'Open files')`;
  await waitFor(chrome, session, 'Boolean(' + opener + ')', 'completed-task file action');
  assert.equal(
    await evaluate(chrome, session, 'document.querySelector(".task-status-heading").textContent'),
    'Task complete',
    'An existing runnable entry does not imply browser verification.',
  );
  await waitFor(
    chrome,
    session,
    'document.querySelectorAll(".task-output .file-row").length === 12',
    'the completed task retains its changed file list',
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    await evaluate(chrome, session, opener + '.focus()');
    await press(chrome, session, 'Enter', 13);
    await waitFor(
      chrome,
      session,
      'document.querySelector("dialog[open] h2")?.textContent === "Files"',
      'project files dialog',
    );
    assert.equal(
      await evaluate(
        chrome,
        session,
        'document.querySelector(".file-browser-actions button")?.textContent.trim()',
      ),
      'Open folder',
    );
    if (attempt === 0) {
      await press(chrome, session, 'Escape', 27);
      await waitFor(chrome, session, '!document.querySelector("dialog[open]")', 'files dialog dismissed');
      assert.equal(await evaluate(chrome, session, 'document.activeElement === ' + opener), true);
    } else {
      await evaluate(
        chrome,
        session,
        `const filter = document.querySelector('dialog[open] input'); filter.value = 'a-file-that-does-not-exist';
          filter.dispatchEvent(new Event('input', {bubbles:true}));`,
      );
      await waitFor(
        chrome,
        session,
        'document.querySelector(".file-browser")?.textContent.includes("No matching files.")',
        'file search empty state',
      );
      await evaluate(
        chrome,
        session,
        `[...document.querySelectorAll('.file-browser button')].find(button => button.textContent.trim() === 'Clear filter').focus()`,
      );
      await press(chrome, session, 'Enter', 13);
      assert.equal(
        await evaluate(
          chrome,
          session,
          'document.activeElement === document.querySelector("dialog[open] input") && document.activeElement.value === ""',
        ),
        true,
        'Clearing a file search restores focus and leaves the project files intact.',
      );
    }
  }
  await evaluate(
    chrome,
    session,
    `[...document.querySelectorAll('.file-browser .file-row')].find(button => button.textContent.trim() === 'index.html').focus()`,
  );
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    `!document.querySelector('dialog[open]') && document.querySelector('.task-output').open &&
      document.querySelector('.file-caption span')?.textContent === 'index.html'`,
    'selected file opens the output disclosure',
  );
  await waitFor(
    chrome,
    session,
    'document.activeElement.matches(".file-caption")',
    'selected file receives keyboard focus',
  );
  assert.equal(
    await evaluate(
      chrome,
      session,
      `(() => { const caption = document.querySelector('.file-caption'); const box = caption.getBoundingClientRect();
        const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
        return box.top >= 0 && box.bottom <= innerHeight && caption.contains(hit); })()`,
    ),
    true,
    'Selecting a file makes its viewer reachable without a test scroll assist.',
  );
  await evaluate(chrome, session, opener + '.focus()');
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    '!!document.querySelector(".file-browser")',
    'same file can be chosen again',
  );
  await evaluate(
    chrome,
    session,
    `[...document.querySelectorAll('.file-browser .file-row')].find(button => button.textContent.trim() === 'index.html').focus()`,
  );
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    '!document.querySelector("dialog[open]") && document.activeElement.matches(".file-caption")',
    'same-file selection returns to its viewer',
  );

  await evaluate(chrome, session, opener + '.focus()');
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    '!!document.querySelector(".file-browser")',
    'file selection before a task change',
  );
  await evaluate(
    chrome,
    session,
    `[...document.querySelectorAll('.file-browser .file-row')].find(button => button.textContent.trim() === 'index.html').click();
      const nextTask = [...document.querySelectorAll('.task-tab')].find(button => button.textContent.trim() === ${JSON.stringify(secondTask)});
      nextTask.focus(); nextTask.click();`,
  );
  await waitFor(
    chrome,
    session,
    `document.querySelector('.task-heading-row h1')?.textContent === ${JSON.stringify(secondTask)}`,
    'new task owns the workspace after selection',
  );
  await evaluate(
    chrome,
    session,
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  const afterSwitch = await evaluate(
    chrome,
    session,
    `({oldFileFocused: Boolean(document.activeElement.closest('.file-viewer')),
    file: document.querySelector('.file-caption span')?.textContent || null})`,
  );
  assert.equal(
    !afterSwitch.oldFileFocused && afterSwitch.file === null,
    true,
    'The old file cannot steal focus after a task switch: ' + JSON.stringify(afterSwitch),
  );
  await selectTask(chrome, session, firstTask);
  await evaluate(chrome, session, opener + '.focus()');
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    '!!document.querySelector(".file-browser")',
    'file selection before another dialog',
  );
  await evaluate(
    chrome,
    session,
    `[...document.querySelectorAll('.file-browser .file-row')].find(button => button.textContent.trim() === 'index.html').click();
      const settings = document.querySelector('[aria-label=Settings]'); settings.focus(); settings.click();`,
  );
  await waitFor(
    chrome,
    session,
    'document.querySelector("dialog[open] h2")?.textContent === "Settings" && !!document.activeElement.closest("dialog[open]")',
    'new Settings dialog retains focus ahead of the old file request',
  );
  await press(chrome, session, 'Escape', 27);
  await waitFor(chrome, session, '!document.querySelector("dialog[open]")', 'Settings dismissed');
  await evaluate(
    chrome,
    session,
    `[...document.querySelectorAll('.statusbar button')].find(button => button.textContent.trim() === 'Terminal').click()`,
  );
  await waitFor(
    chrome,
    session,
    `!!document.querySelector('.terminal-dock button[aria-label="New shell"]:enabled')`,
    'terminal session inventory is ready',
  );
  assert.equal(
    await evaluate(
      chrome,
      session,
      `[...document.querySelectorAll('${picker} option')].filter(option => option.value).length`,
    ),
    0,
    'Browsing files never starts an app or a shell.',
  );
  await click(chrome, session, '[aria-label="Hide terminal"]');
}

async function clickDockButton(chrome, session, label) {
  const expression = `[...document.querySelectorAll('.terminal-dock button')].find(el => (el.getAttribute('aria-label') || el.innerText.trim()) === ${JSON.stringify(label)} && el.checkVisibility() && !el.disabled)`;
  await waitFor(chrome, session, 'Boolean(' + expression + ')', label);
  await evaluate(chrome, session, expression + '.focus()');
  await press(chrome, session, 'Enter', 13);
}

async function waitState(chrome, session, state) {
  try {
    await waitFor(
      chrome,
      session,
      `document.querySelector('.terminal-run-state')?.textContent.trim() === ${JSON.stringify(state)}`,
      'app session ' + state,
    );
  } catch (cause) {
    const observed = await evaluate(
      chrome,
      session,
      `({state: document.querySelector('.terminal-run-state')?.textContent,
        selected: document.querySelector('${picker}')?.selectedOptions[0]?.textContent,
        choices: [...document.querySelectorAll('${picker} option')].map(option => option.textContent),
        error: document.querySelector('.terminal-error')?.textContent})`,
    );
    throw new Error('App did not become ' + state + ': ' + JSON.stringify(observed), { cause });
  }
}

async function selectTask(chrome, session, name) {
  const tab = `[...document.querySelectorAll('.task-tab')].find(button => button.textContent.trim() === ${JSON.stringify(name)})`;
  if (await evaluate(chrome, session, 'Boolean(' + tab + ')')) {
    await evaluate(chrome, session, tab + '.click()');
  } else {
    await click(chrome, session, '[aria-label="All project tasks"]');
    await click(chrome, session, '[aria-label=' + JSON.stringify('Open ' + name) + ']');
  }
  await waitFor(
    chrome,
    session,
    `document.querySelector('.task-heading-row h1')?.textContent === ${JSON.stringify(name)}`,
    'selected task ' + name,
  );
}

async function selectSession(chrome, session, name) {
  await click(chrome, session, '.terminal-session-picker .select-trigger');
  const expression = `[...document.querySelectorAll('.select-popup:not([hidden]) [role=option]')].find(el => el.textContent.includes(${JSON.stringify(name)}) && el.getAttribute('aria-disabled') !== 'true')`;
  await waitFor(chrome, session, 'Boolean(' + expression + ')', 'session choice ' + name);
  await evaluate(chrome, session, expression + '.click()');
  await waitFor(
    chrome,
    session,
    `document.querySelector('${picker}')?.selectedOptions[0]?.textContent.includes(${JSON.stringify(name)}) === true`,
    'selected session ' + name,
  );
}

async function openApp(chrome, session) {
  const before = parseContract(browserTargetsSchema, await chrome.request('Target.getTargets'), 'Owned tabs');
  await clickDockButton(chrome, session, 'Open app');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const targets = parseContract(
      browserTargetsSchema,
      await chrome.request('Target.getTargets'),
      'Owned tabs',
    );
    const opened = targets.targetInfos.find(
      (target) =>
        !before.targetInfos.some((old) => old.targetId === target.targetId) &&
        /^http:\/\/miter-[a-f0-9]{32}\.localhost:[1-9][0-9]{0,4}\/[a-f0-9]{32}\/index\.html$/.test(
          target.url,
        ),
    );
    if (opened) {
      await chrome.request('Target.closeTarget', { targetId: opened.targetId });
      return opened.url;
    }
    await delay(30);
  }
  throw new Error('Open app did not create its owned local preview tab.');
}

async function checkCompactHeader(chrome, session) {
  for (const width of [1024, 360, 320]) {
    await chrome.request(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 900, deviceScaleFactor: 1, mobile: false },
      session,
    );
    const scales = ['100%'];
    if (width === 320) {
      scales.push('220%');
    }
    for (const scale of scales) {
      await evaluate(chrome, session, `document.documentElement.style.fontSize = ${JSON.stringify(scale)}`);
      assert.equal(
        await evaluate(
          chrome,
          session,
          `(() => {
            const toolbar = document.querySelector('.terminal-toolbar');
            const bounds = toolbar.getBoundingClientRect();
            const controls = [...toolbar.querySelectorAll('button')].filter(button => button.checkVisibility());
            const boxes = controls.map(button => button.getBoundingClientRect());
            return toolbar.scrollWidth <= toolbar.clientWidth && bounds.left >= 0 && bounds.right <= innerWidth &&
              document.querySelector('.terminal-session-picker .select-trigger').textContent.includes(${JSON.stringify(firstTask)}) &&
              controls.every(button => button.getAttribute('aria-label')) &&
              boxes.every(box => box.width >= 24 && box.height >= 24 && box.left >= bounds.left && box.right <= bounds.right &&
                Math.abs((box.top + box.bottom) / 2 - (boxes[0].top + boxes[0].bottom) / 2) <= 1) &&
              !document.querySelector('.terminal-session-row') &&
              ![...toolbar.querySelectorAll('button')].some(button => button.textContent.includes('Appearance'));
          })()`,
        ),
        true,
        'Named terminal controls fit one row at ' + width + 'px and ' + scale + ' text.',
      );
    }
  }
  await evaluate(chrome, session, 'document.documentElement.style.removeProperty("font-size")');
  await chrome.request('Emulation.clearDeviceMetricsOverride', {}, session);
  await evaluate(
    chrome,
    session,
    'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))',
  );
}

async function checkLogsAndTooltips(chrome, session) {
  assert.equal(
    await evaluate(
      chrome,
      session,
      `document.querySelector('.terminal-log-toggle').getAttribute('aria-expanded') === 'false' &&
        document.querySelector('.terminal-run-output').hidden &&
        document.querySelector('.terminal-run-state').checkVisibility()`,
    ),
    true,
    'Status stays visible while process output starts hidden.',
  );
  await clickDockButton(chrome, session, 'Logs');
  await waitFor(
    chrome,
    session,
    `!document.querySelector('.terminal-run-output').hidden &&
      document.querySelector('.terminal-run-output').textContent.includes('Serving')`,
    'expanded real server output',
  );
  await clickDockButton(chrome, session, 'Logs');
  await evaluate(chrome, session, 'document.querySelector("[aria-label=Restart]").focus()');
  await waitFor(
    chrome,
    session,
    `[...document.querySelectorAll('[role=tooltip]')].some(tooltip => tooltip.checkVisibility() && tooltip.textContent === 'Restart')`,
    'keyboard tooltip for Restart',
  );
  await press(chrome, session, 'Escape', 27);
  assert.equal(
    await evaluate(
      chrome,
      session,
      `document.activeElement.getAttribute('aria-label') === 'Restart' &&
        ![...document.querySelectorAll('[role=tooltip]')].some(tooltip => tooltip.checkVisibility())`,
    ),
    true,
    'Escape dismisses the tooltip without moving keyboard focus.',
  );
  await evaluate(chrome, session, 'document.querySelector(".app-preview-launch button").focus()');
  for (const selector of ['[aria-label=Restart]', '[role=tooltip]:popover-open']) {
    const point = await evaluate(
      chrome,
      session,
      `(() => {const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return {x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2};})()`,
    );
    await chrome.request('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, session);
    await waitFor(
      chrome,
      session,
      `[...document.querySelectorAll('[role=tooltip]')].some(tooltip => tooltip.checkVisibility() && tooltip.textContent === 'Restart')`,
      'tooltip remains visible when the pointer enters its text',
    );
  }
  await press(chrome, session, 'Escape', 27);
  await evaluate(
    chrome,
    session,
    'document.querySelector(".terminal-session-picker .select-trigger").focus()',
  );
  await press(chrome, session, 'ArrowDown', 40);
  await waitFor(
    chrome,
    session,
    'document.querySelector(".terminal-session-picker .select-trigger").getAttribute("aria-expanded") === "true"',
    'keyboard session list opens',
  );
  await press(chrome, session, 'Escape', 27);
  assert.equal(
    await evaluate(
      chrome,
      session,
      `document.querySelector('.terminal-session-picker .select-trigger').getAttribute('aria-expanded') === 'false' &&
        document.activeElement.matches('.terminal-session-picker .select-trigger')`,
    ),
    true,
    'One Escape closes the session list without an intervening tooltip dismissal.',
  );
}

async function checkSidePanelTerminal(chrome, workspace, id) {
  await evaluate(
    chrome,
    workspace,
    'chrome.windows.getCurrent().then(win => chrome.sidePanel.open({windowId: win.id}))',
  );
  const url = 'chrome-extension://' + id + '/sidepanel.html';
  await waitFor(
    chrome,
    workspace,
    `chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}).then(rows => rows.some(row => row.documentUrl === ${JSON.stringify(url)}))`,
    'native Chrome side panel',
  );
  const targets = parseContract(
    browserTargetsSchema,
    await chrome.request('Target.getTargets'),
    'Chrome did not return the side panel target identities.',
  ).targetInfos.filter((target) => target.type === 'page' && target.url === url);
  assert.equal(targets.length, 1, 'The isolated browser must own exactly one Miter side panel.');
  const { sessionId } = parseContract(
    sessionIdSchema,
    await chrome.request('Target.attachToTarget', { targetId: targets[0].targetId, flatten: true }),
    'Chrome did not return the side panel debugging session.',
  );
  await chrome.request('Runtime.enable', {}, sessionId);
  const run = '.app-preview-launch button';
  await waitFor(
    chrome,
    sessionId,
    `document.querySelector('${run}')?.innerText.trim() === 'Run'`,
    'side panel Run',
  );
  await click(chrome, sessionId, run);
  await waitFor(
    chrome,
    sessionId,
    "document.querySelector('.terminal-run-state')?.textContent.trim() === 'running'",
    'app running in the side panel',
  );
  const shell = '.terminal-dock button[aria-label="New shell"]';
  await waitFor(
    chrome,
    sessionId,
    `Boolean(document.querySelector('${shell}:enabled'))`,
    'new shell available',
  );
  await click(chrome, sessionId, shell);
  await click(chrome, sessionId, '[data-miter-confirmation][open] button.primary');
  await waitFor(
    chrome,
    sessionId,
    "Boolean(document.querySelector('.terminal-dock .xterm-helper-textarea')?.offsetWidth)",
    'interactive shell in the side panel',
  );
  await evaluate(chrome, sessionId, "document.querySelector('.xterm-helper-textarea').focus()");
  for (const key of "printf 'panel-%d' 73") {
    await chrome.request('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key }, sessionId);
    await chrome.request('Input.dispatchKeyEvent', { type: 'keyUp', key }, sessionId);
  }
  await press(chrome, sessionId, 'Enter', 13);
  await waitFor(
    chrome,
    sessionId,
    "document.querySelector('.xterm')?.textContent.includes('panel-73') === true",
    'verified output from the real side panel shell',
  );
  await selectSession(chrome, sessionId, firstTask);
  await waitState(chrome, sessionId, 'running');
  assert.equal(
    await evaluate(chrome, sessionId, 'document.querySelector(".terminal-run-output").hidden'),
    true,
  );
  await click(chrome, sessionId, '.terminal-session-picker .select-trigger');
  await evaluate(
    chrome,
    sessionId,
    `[...document.querySelectorAll('.select-popup:not([hidden]) [role=option]')].find(option => {
      const value = option.getAttribute('data-value');
      return value && !value.startsWith('app:') && option.getAttribute('aria-disabled') !== 'true';
    }).click()`,
  );
  await waitFor(
    chrome,
    sessionId,
    "Boolean(document.querySelector('.terminal-dock .xterm-helper-textarea')?.offsetWidth)",
    'existing shell reselected without spawning another shell',
  );
  await click(chrome, sessionId, '[aria-label="Hide terminal"]');
  await waitFor(
    chrome,
    sessionId,
    `Boolean(document.querySelector('${run}:enabled')) && document.querySelector('.terminal-dock').hidden`,
    'ready Run while dock hidden',
  );
  await click(chrome, sessionId, run);
  await waitFor(
    chrome,
    sessionId,
    "document.querySelector('.terminal-run-state')?.textContent.trim() === 'running'",
    'Run reselected the app after hiding its side panel terminal with a shell active',
  );
  await clickDockButton(chrome, sessionId, 'Stop');
  await waitFor(
    chrome,
    sessionId,
    "document.querySelector('.terminal-run-state')?.textContent.trim() === 'stopped'",
    'side panel stopped the app while the shell stayed attached',
  );
  assert.equal(
    await evaluate(
      chrome,
      sessionId,
      `[...document.querySelector('${picker}').options].filter(option => option.value).length`,
    ),
    3,
  );
}

/** Cross the actual workspace → terminal dock → native host boundary using an isolated saved completion. */
export async function checkAppRun(executable, directory, extension, log, signal) {
  const owned = path.join(directory, 'app-run');
  await mkdir(owned, { mode: 0o700 });
  for (const name of ['home', 'tmp']) {
    await mkdir(path.join(owned, name), { mode: 0o700 });
  }
  const chrome = new ChromePipe(executable, owned, log, signal);
  try {
    const { id } = parseContract(
      extensionIdSchema,
      await chrome.request('Extensions.loadUnpacked', { path: extension }),
      'Chrome did not load the packaged extension for the app run journey.',
    );
    const native = await installNativeHost(owned, id);
    await completeProject(native);
    const app = await page(chrome, 'chrome-extension://' + id + '/workspace.html');
    const taskButton = '.app-preview-launch button';
    const dock = '.terminal-dock';
    const sessions = `[...document.querySelector('${picker}').options].filter(option => option.value)`;
    await waitFor(
      chrome,
      app.session,
      `document.querySelector('${taskButton}')?.innerText.trim() === 'Run'`,
      'verified app Run button',
    );
    await selectTask(chrome, app.session, firstTask);
    await checkAppearanceSettings(chrome, app.session, native);
    await selectTask(chrome, app.session, secondTask);
    await selectTask(chrome, app.session, firstTask);
    await checkFileHandoff(chrome, app.session);
    await click(chrome, app.session, taskButton);
    await waitFor(
      chrome,
      app.session,
      `Boolean(document.activeElement?.closest('${dock}') && document.querySelector('${picker}')?.value.startsWith('app:'))`,
      'new app run selected in the terminal',
    );
    await waitFor(
      chrome,
      app.session,
      `Boolean(document.querySelector('${dock} button[aria-label="Open app"]:enabled'))`,
      'ready application session',
    );
    await checkCompactHeader(chrome, app.session);
    await checkLogsAndTooltips(chrome, app.session);
    assert.equal(
      await evaluate(
        chrome,
        app.session,
        'getComputedStyle(document.querySelector(".terminal-run-output")).fontSize',
      ),
      '18px',
      'Settings appearance applied before the terminal was first mounted.',
    );
    const originalURL = await openApp(chrome, app.session);
    await clickDockButton(chrome, app.session, 'Restart');
    await waitFor(
      chrome,
      app.session,
      `!!document.querySelector('${dock} button[aria-label="Restart"]:enabled') && document.querySelector('.terminal-run-state').textContent === 'running'`,
      'restarted server ready',
    );
    assert.equal(
      await evaluate(chrome, app.session, 'document.activeElement.closest(".terminal-dock") !== null'),
      true,
      'Restarting the app keeps keyboard focus in its terminal.',
    );
    const restartedURL = await openApp(chrome, app.session);
    assert.notEqual(restartedURL, originalURL, 'Restart replaces the exact server session.');
    assert.equal(await evaluate(chrome, app.session, sessions + '.length'), 1);

    await unlink(path.join(native.project, 'index.html'));
    try {
      await clickDockButton(chrome, app.session, 'Restart');
      await waitState(chrome, app.session, 'failed');
      assert.equal(
        await evaluate(
          chrome,
          app.session,
          `document.querySelector('.terminal-app-failure').checkVisibility() &&
            document.querySelector('.terminal-error').checkVisibility() &&
            document.querySelector('.terminal-run-output').hidden`,
        ),
        true,
        'A failed launch remains visible while Logs is closed.',
      );
    } finally {
      await writeFile(path.join(native.project, 'index.html'), entry);
    }
    await clickDockButton(chrome, app.session, 'Run again');
    await waitState(chrome, app.session, 'running');
    assert.equal(
      await evaluate(chrome, app.session, 'document.activeElement.closest(".terminal-dock") !== null'),
      true,
      'Recovering a failed launch keeps keyboard focus in its terminal.',
    );
    assert.equal(
      await openApp(chrome, app.session),
      restartedURL,
      'Recovering a failed replacement reuses the exact server that remained available.',
    );
    await click(chrome, app.session, '[aria-label="Hide terminal"]');
    await click(chrome, app.session, taskButton);
    await waitFor(
      chrome,
      app.session,
      `Boolean(document.querySelector('${dock}')?.offsetWidth && document.querySelector('${picker}')?.value.startsWith('app:'))`,
      'running app reselected after reopening the terminal',
    );
    assert.equal(await evaluate(chrome, app.session, sessions + '.length'), 1);
    await selectTask(chrome, app.session, secondTask);
    await waitFor(
      chrome,
      app.session,
      `document.querySelector('.task-heading-row h1')?.textContent === ${JSON.stringify(secondTask)} && !!document.querySelector('${taskButton}:enabled')`,
      'second completed task',
    );
    await click(chrome, app.session, taskButton);
    await waitState(chrome, app.session, 'running');
    await waitFor(
      chrome,
      app.session,
      sessions + '.length === 2',
      'two independently selectable app sessions',
    );
    await selectSession(chrome, app.session, firstTask);
    await selectSession(chrome, app.session, secondTask);
    await clickDockButton(chrome, app.session, 'Stop');
    await waitState(chrome, app.session, 'stopped');
    await selectTask(chrome, app.session, firstTask);
    await selectSession(chrome, app.session, firstTask);
    await waitState(chrome, app.session, 'running');
    await clickDockButton(chrome, app.session, 'Stop');
    await waitFor(
      chrome,
      app.session,
      `document.querySelector('${dock} .terminal-run-state')?.textContent.trim() === 'stopped'`,
      'app server stopped in the terminal',
    );
    assert.equal(
      await evaluate(chrome, app.session, 'document.activeElement.closest(".terminal-dock") !== null'),
      true,
      'Stopping the app keeps keyboard focus in its terminal.',
    );
    await checkSidePanelTerminal(chrome, app.session, id);
    assert.deepEqual(
      chrome.events.filter((event) => event.method === 'Runtime.exceptionThrown'),
      [],
    );
  } finally {
    await chrome.close();
  }
}
