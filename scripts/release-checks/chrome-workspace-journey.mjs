import assert from 'node:assert/strict';
import path from 'node:path';
import { ownedTemporaryDirectory } from './chrome-native.mjs';
import { click, evaluate, press, waitFor } from './chrome-ui.mjs';

const selectedProject = 'document.querySelector(".project-tab[aria-selected=true]")?.textContent.trim()';

async function enterProject(chrome, session, fields) {
  await evaluate(
    chrome,
    session,
    `(() => {
    document.querySelector('.project-options').open = true;
    for (const [name, value] of Object.entries(${JSON.stringify(fields)})) {
      const input = document.querySelector('input[name="' + name + '"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('Missing project field: ' + name);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('form').requestSubmit();
  })()`,
  );
  await waitFor(chrome, session, 'document.querySelector("dialog[open]") === null', 'project saved');
}

/** Real workspace, controller and native host; folders stay inside the owned
 * release profile. Does not open a provider tab, OS picker or permission prompt.
 */
export async function checkWorkspaceJourney(chrome, session, projectRoot) {
  const parentRoot = await ownedTemporaryDirectory(path.dirname(projectRoot));
  const folderName = 'Journey project';
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
  await enterProject(chrome, session, { folderName, root: parentRoot });
  await waitFor(chrome, session, `${selectedProject} === "Journey project"`, 'new project selected');
  assert.equal(await evaluate(chrome, session, 'document.querySelectorAll(".task-tab").length'), 0);
  await click(chrome, session, '.project-home .primary');
  await waitFor(
    chrome,
    session,
    'document.querySelector("dialog[open] h2")?.textContent === "New task"',
    'first task opens',
  );
  await press(chrome, session, 'Escape', 27);

  await click(chrome, session, '.health-button');
  await click(chrome, session, '.setup-panel .home-actions button:not(.primary)');
  await enterProject(chrome, session, {
    root: path.join(parentRoot, folderName),
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
}
