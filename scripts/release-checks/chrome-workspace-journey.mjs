import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseContract } from '../helpers/runtime.mjs';
import { ownedTemporaryDirectory } from './chrome-native.mjs';
import { journeyFolderName } from './chrome-picker-host.mjs';
import { click, evaluate, press, waitFor } from './chrome-ui.mjs';

const selectedProject = 'document.querySelector(".project-tab[aria-selected=true]")?.textContent.trim()';

const screenshot =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR4nGMQMj544dEqhk/qFhMmLwAAK84Gd2fVDssAAAAASUVORK5CYII=';
const nodeIdSchema = z.int().positive().describe('Chrome DevTools identity of an existing DOM element.');
const documentNodeSchema = z
  .object({ root: z.object({ nodeId: nodeIdSchema }) })
  .describe('The main document node.');
const elementNodeSchema = z
  .object({ nodeId: nodeIdSchema })
  .describe('The DOM node selected for file input.');

async function selectImage(chrome, session, input, file) {
  const { root } = parseContract(
    documentNodeSchema,
    await chrome.request('DOM.getDocument', { depth: 0 }, session),
    'The browser did not expose the task document.',
  );
  const { nodeId } = parseContract(
    elementNodeSchema,
    await chrome.request('DOM.querySelector', { nodeId: root.nodeId, selector: input }, session),
    'The browser did not expose the image picker.',
  );
  await chrome.request('DOM.setFileInputFiles', { nodeId, files: [file] }, session);
}

async function pasteImage(chrome, session, input) {
  await evaluate(
    chrome,
    session,
    `(() => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(${JSON.stringify(screenshot)}), (byte) => byte.charCodeAt(0));
    data.items.add(new File([bytes], 'Pasted screenshot.png', { type: 'image/png' }));
    document.querySelector(${JSON.stringify(input)}).dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  })()`,
  );
}

async function waitForAttachment(chrome, session, container, name) {
  await waitFor(
    chrome,
    session,
    `(() => {
    const container = document.querySelector(${JSON.stringify(container)});
    const img = container?.querySelector('.attachment-previews img');
    return container?.querySelector('.attachment-name')?.textContent === ${JSON.stringify(name)} &&
      container.querySelectorAll('.attachment-previews li').length === 1 &&
      img?.complete === true && img.naturalWidth > 0;
  })()`,
    'saved thumbnail is visible for ' + name,
  );
}

async function reloadWorkspace(chrome, session) {
  await evaluate(chrome, session, 'globalThis.attachmentFixtureReload = true');
  await chrome.request('Page.reload', {}, session);
  await waitFor(
    chrome,
    session,
    'globalThis.attachmentFixtureReload === undefined && document.readyState === "complete"',
    'a fresh workspace document after reloading',
  );
}

async function enterProject(chrome, session, root, fields) {
  await click(chrome, session, '.folder-picker');
  await waitFor(
    chrome,
    session,
    `document.querySelector('.path-selection').textContent === ${JSON.stringify(root)}`,
    'folder selection from the native helper',
  );
  await evaluate(
    chrome,
    session,
    `(() => {
    const form = document.querySelector('dialog[open] form');
    form.querySelector('.project-options').open = true;
    for (const [name, value] of Object.entries(${JSON.stringify(fields)})) {
      const input = form.querySelector('input[name="' + name + '"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('Missing project field: ' + name);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    form.requestSubmit();
  })()`,
  );
  await waitFor(chrome, session, 'document.querySelector("dialog[open]") === null', 'project saved');
}

/** Real workspace, controller and native host; folders stay inside the owned
 * release profile. Does not open a provider tab, OS picker or permission prompt.
 */
export async function checkWorkspaceJourney(chrome, session, projectRoot, modelPath) {
  const parentRoot = await ownedTemporaryDirectory(path.dirname(projectRoot));
  const screenshotPath = path.join(parentRoot, 'Selected screenshot.png');
  await writeFile(screenshotPath, Buffer.from(screenshot, 'base64'), { flag: 'wx' });
  const folderName = journeyFolderName;
  await waitFor(
    chrome,
    session,
    `${selectedProject} === "Chrome release check"`,
    'registered project appears',
  );
  await click(chrome, session, '[aria-label="Close Chrome release check tab"]');
  await waitFor(chrome, session, 'document.querySelector(".saved-entry") !== null', 'saved project appears');
  assert.equal(await evaluate(chrome, session, 'document.querySelectorAll(".project-tab").length'), 0);
  await click(chrome, session, '.saved-entry');
  await waitFor(chrome, session, `${selectedProject} === "Chrome release check"`, 'saved project opens');
  await click(chrome, session, '[aria-label="New project"]');
  await waitFor(
    chrome,
    session,
    'document.querySelector("input[name=folderName]") !== null',
    'create project dialog',
  );
  await enterProject(chrome, session, parentRoot, { folderName });
  await waitFor(chrome, session, `${selectedProject} === "Journey project"`, 'new project selected');
  assert.equal(await evaluate(chrome, session, 'document.querySelectorAll(".task-tab").length'), 0);
  await click(chrome, session, '.project-home .primary');
  await waitFor(
    chrome,
    session,
    'document.querySelector("dialog[open] h2")?.textContent === "New task"',
    'first task opens',
  );
  await evaluate(
    chrome,
    session,
    `(() => {
    const goal = document.querySelector('[data-goal]');
    goal.value = 'Create an offline journal.';
    goal.dispatchEvent(new Event('input', { bubbles: true }));
  })()`,
  );
  await waitFor(
    chrome,
    session,
    'document.querySelector("dialog .attach-images")?.disabled === false',
    'new task image picker',
  );
  await selectImage(chrome, session, '[data-task-attachments] input', screenshotPath);
  await waitForAttachment(chrome, session, 'dialog[open]', 'Selected screenshot.png');
  await reloadWorkspace(chrome, session);
  await waitFor(
    chrome,
    session,
    `${selectedProject} === "Journey project" && !!document.querySelector(".project-home .primary")`,
    'project restored after reload',
  );
  await click(chrome, session, '.project-home .primary');
  await waitForAttachment(chrome, session, 'dialog[open]', 'Selected screenshot.png');
  assert.equal(
    await evaluate(chrome, session, 'document.querySelector("[data-goal]").value'),
    'Create an offline journal.',
  );
  await evaluate(
    chrome,
    session,
    `(() => {
    const start = document.querySelector('[data-start-now]');
    if (start.checked) start.click();
  })()`,
  );
  await click(chrome, session, '[data-create]');
  await waitFor(
    chrome,
    session,
    '!!document.querySelector(".task-tab-row .list-tabs")',
    'draft task is saved',
  );
  await click(chrome, session, '.task-tab-row .list-tabs');
  await click(chrome, session, '.library-row .library-more .menu-trigger');
  await evaluate(
    chrome,
    session,
    `(() => {
    const edit = [...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.trim() === 'Edit task…');
    if (!edit) throw new Error('Missing Edit task action.');
    edit.click();
  })()`,
  );
  await waitFor(
    chrome,
    session,
    'document.querySelector("dialog[open] h2")?.textContent === "Edit task"',
    'draft task editor opens from the row menu',
  );
  await evaluate(
    chrome,
    session,
    `(() => {
    const title = document.querySelector('dialog[open] input');
    title.value = 'Evening journal';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    const details = document.querySelector('dialog[open] textarea');
    if (details.readOnly || details.value !== 'Create an offline journal.') throw new Error('Draft details should be editable.');
    details.value = 'Create an offline journal with a weekly view.';
    details.dispatchEvent(new Event('input', { bubbles: true }));
  })()`,
  );
  await click(chrome, session, 'dialog[open] button[type=submit]');
  await waitFor(
    chrome,
    session,
    `!document.querySelector('dialog[open]') &&
      document.querySelector('.task-tab-row [aria-selected=true]')?.textContent.includes('Evening journal') &&
      document.querySelector('.task-details')?.textContent.includes('Create an offline journal with a weekly view.')`,
    'title and details reach the workspace without starting the task',
  );

  await checkFollowupRewrite(chrome, session);

  await click(chrome, session, '.health-button');
  await click(chrome, session, '.setup-panel .home-actions button:not(.primary)');
  await enterProject(chrome, session, path.join(parentRoot, folderName), {
    name: 'Do not rename on reopen',
  });
  assert.equal(await evaluate(chrome, session, 'document.querySelectorAll(".project-tab").length'), 2);
  assert.equal(await evaluate(chrome, session, selectedProject), folderName);

  await click(chrome, session, '[aria-label="Close Journey project tab"]');
  await waitFor(chrome, session, 'document.querySelectorAll(".project-tab").length === 1', 'new tab closes');
  await click(chrome, session, '.project-tab-row .close-active-tab');
  await waitFor(
    chrome,
    session,
    'document.querySelector(".project-home h1")?.textContent === "Projects"',
    'saved projects return',
  );
  assert.equal(await evaluate(chrome, session, 'document.querySelectorAll(".workspace-tab-row").length'), 0);
  assert.equal(await evaluate(chrome, session, 'document.querySelectorAll(".saved-entry").length'), 2);
  await click(chrome, session, '.saved-entry');
  await waitFor(chrome, session, `${selectedProject} === "Journey project"`, 'new saved project reopens');

  await click(chrome, session, '.project-tab-row .list-tabs');
  await waitFor(
    chrome,
    session,
    '!!document.querySelector(".library-open[aria-current=true]")',
    'project list opens',
  );
  assert.equal(
    await evaluate(
      chrome,
      session,
      `(() => {
      const action = document.querySelector('.library-open[aria-current=true]');
      const row = action.closest('.library-row');
      const more = row.querySelector('.library-more');
      const transparent = 'rgba(0, 0, 0, 0)';
      return !!more && row.getBoundingClientRect().right === more.getBoundingClientRect().right &&
        getComputedStyle(row).backgroundColor !== transparent &&
        getComputedStyle(action).backgroundColor === transparent &&
        getComputedStyle(more).backgroundColor === transparent;
    })()`,
    ),
    true,
    'The current row highlight reaches its overflow menu.',
  );
  await press(chrome, session, 'Escape', 27);

  await click(chrome, session, '[aria-label="Settings"]');
  await click(chrome, session, '[data-model-advanced] > summary');
  await click(chrome, session, '[data-pick-model]');
  await waitFor(
    chrome,
    session,
    `document.querySelector('[data-model-selection]').textContent === ${JSON.stringify(modelPath)}`,
    'model selection from the native helper',
  );
  await click(chrome, session, '[data-clear-model]');
  assert.equal(await evaluate(chrome, session, 'document.querySelector("[data-clear-model]").hidden'), true);
  await press(chrome, session, 'Escape', 27);
}

async function checkFollowupRewrite(chrome, session) {
  const followup = '.followup-composer';
  const send = `document.querySelector('${followup} button[type=submit]')`;
  await waitFor(chrome, session, `${send}?.disabled === true`, 'empty follow-up cannot be sent');
  await evaluate(
    chrome,
    session,
    `(() => {
      const draft = document.querySelector('${followup} textarea');
      draft.value = 'Keep the weekly view.';
      draft.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
  await waitFor(chrome, session, `${send}.disabled === false`, 'entering a follow-up enables Send');
  await pasteImage(chrome, session, followup + ' textarea');
  await waitForAttachment(chrome, session, followup, 'Pasted screenshot.png');
  await pasteImage(chrome, session, followup + ' textarea');
  await waitFor(
    chrome,
    session,
    'document.querySelector(".followup-composer .attachment-status")?.textContent === "This image is already attached."',
    'a second paste does not attach the same image again',
  );
  await click(chrome, session, `${followup} .rewrite-toggle`);
  assert.equal(await evaluate(chrome, session, `${send}.checkVisibility()`), false);
  await click(chrome, session, `${followup} .rewrite-options summary`);
  await click(chrome, session, `${followup} .rewrite-options button:not(.select-trigger)`);
  await waitFor(
    chrome,
    session,
    `document.querySelector('${followup} .rewrite-preview').checkVisibility()`,
    'the local rewrite is visible for review',
  );
  assert.equal(
    await evaluate(chrome, session, `document.querySelector('${followup} textarea').value`),
    'Keep the weekly view.',
  );
  await click(chrome, session, `${followup} .rewrite-panel button.primary:not([hidden])`);
  await waitFor(
    chrome,
    session,
    `${send}.checkVisibility() &&
      document.activeElement === document.querySelector('${followup} textarea') &&
      document.activeElement.value.startsWith('Requested change:')`,
    'using the rewrite restores Send and focuses the updated draft',
  );
  await waitForAttachment(chrome, session, followup, 'Pasted screenshot.png');
  await waitFor(
    chrome,
    session,
    'document.querySelector(".followup-composer .image-attachments")?.getAttribute("aria-busy") === "false"',
    'rewritten image draft is saved',
  );
  await reloadWorkspace(chrome, session);
  await waitForAttachment(chrome, session, followup, 'Pasted screenshot.png');
  assert.match(
    await evaluate(chrome, session, `document.querySelector('${followup} textarea').value`),
    /^Requested change:/,
  );
  await click(chrome, session, followup + ' [aria-label="Remove Pasted screenshot.png"]');
  await waitFor(
    chrome,
    session,
    'document.querySelectorAll(".followup-composer .attachment-previews li").length === 0',
    'image removed from the draft',
  );
}
