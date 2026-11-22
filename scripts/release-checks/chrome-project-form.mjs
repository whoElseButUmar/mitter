import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseContract } from '../helpers/runtime.mjs';
import { click, evaluate, press, waitFor } from './chrome-ui.mjs';

const fixture = 'window.mitterReleaseFixture.projectForm';
const stateSchema = z
  .strictObject({
    requests: z
      .array(
        z
          .strictObject({
            parentRoot: z.string().describe('The exact selected parent path.'),
            folderName: z.string().describe('The reviewed single new folder name.'),
            name: z.string().describe('The project display name sent to the host.'),
            starter: z.literal('vite-ts-sqlite').optional().describe('The explicitly selected starter.'),
          })
          .describe('One explicit project creation request.'),
      )
      .describe('Requests captured by the controlled host.'),
    choices: z.array(z.enum(['project', 'parent'])).describe('The intended native folder picker purposes.'),
    opened: z.number().int().nonnegative().describe('Acknowledged projects opened by this form.'),
    pending: z.boolean().describe('Creation is waiting for the controlled host acknowledgement.'),
  })
  .describe('Observed production project form effects; no real folder is created by this fixture.');

async function state(chrome, session) {
  return parseContract(
    stateSchema,
    await evaluate(chrome, session, fixture + '.inspect()'),
    'project form effects',
  );
}

async function enter(chrome, session, name, value) {
  await evaluate(
    chrome,
    session,
    `(() => {
    const input = document.querySelector(${JSON.stringify('input[name=' + name + ']')});
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing project field.');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`,
  );
}

export async function checkProjectForm(chrome, session) {
  try {
    await evaluate(chrome, session, fixture + '.mount()');
    assert.equal(await evaluate(chrome, session, "document.querySelector('select[name=starter]').value"), '');
    await click(chrome, session, 'button[type=submit]');
    assert.equal(
      await evaluate(chrome, session, 'document.activeElement?.getAttribute("name")'),
      'folderName',
    );
    assert.deepEqual((await state(chrome, session)).requests, []);
    await enter(chrome, session, 'folderName', 'Café project');
    await evaluate(chrome, session, 'document.querySelector(".project-options").open = false');
    await click(chrome, session, 'button[type=submit]');
    await waitFor(
      chrome,
      session,
      'document.activeElement === document.querySelector(".folder-picker")',
      'missing parent folder focuses its picker',
    );
    assert.equal(
      await evaluate(
        chrome,
        session,
        'document.querySelector(".error").textContent.includes("Choose a folder first")',
      ),
      true,
    );
    assert.deepEqual((await state(chrome, session)).requests, []);
    await evaluate(chrome, session, fixture + '.cancelPickerOnce()');
    await click(chrome, session, '.folder-picker');
    await waitFor(
      chrome,
      session,
      'document.querySelector(".folder-picker").disabled === false',
      'cancelled parent selection',
    );
    assert.equal(
      await evaluate(chrome, session, 'document.querySelector("input[name=folderName]").value'),
      'Café project',
    );
    await click(chrome, session, '.folder-picker');
    await waitFor(
      chrome,
      session,
      'document.querySelector(".path-selection").textContent === "/controlled/projects"',
      'chosen parent is visible',
    );
    assert.equal(
      await evaluate(chrome, session, 'document.querySelector("input[name=name]").value'),
      'Café project',
    );
    assert.equal(await evaluate(chrome, session, 'document.querySelector(".project-options").open'), false);
    assert.deepEqual((await state(chrome, session)).choices, ['parent', 'parent']);

    await chrome.request(
      'Emulation.setDeviceMetricsOverride',
      { width: 320, height: 600, deviceScaleFactor: 1, mobile: false },
      session,
    );
    assert.equal(
      await evaluate(
        chrome,
        session,
        `(() => {
      const dialog = document.querySelector('dialog[open]');
      const form = dialog?.querySelector('form');
      const bounds = dialog?.getBoundingClientRect();
      return !!bounds && !!form && bounds.left >= 0 && bounds.right <= innerWidth && form.scrollWidth <= form.clientWidth;
    })()`,
      ),
      true,
      'Project creation fits a narrow viewport without horizontal scrolling.',
    );

    await click(chrome, session, 'button[type=submit]');
    await evaluate(chrome, session, 'document.querySelector("form").requestSubmit()');
    const pending = await state(chrome, session);
    assert.deepEqual(pending.requests, [
      { parentRoot: '/controlled/projects', folderName: 'Café project', name: 'Café project' },
    ]);
    assert.equal(pending.pending, true);
    assert.equal(
      await evaluate(chrome, session, 'document.querySelector("button[type=submit]").textContent.trim()'),
      'Creating…',
    );
    await evaluate(chrome, session, fixture + '.finish()');
    await waitFor(
      chrome,
      session,
      'document.querySelector("dialog[open]") === null',
      'created project closes its owning dialog',
    );
    assert.equal((await state(chrome, session)).opened, 1);

    await evaluate(chrome, session, fixture + '.mount(); ' + fixture + '.failPickerOnce()');
    await click(chrome, session, '.folder-picker');
    await waitFor(
      chrome,
      session,
      '!document.querySelector(".project-options").open && document.querySelector(".error").textContent.includes("Controlled picker failure")',
      'picker failure explains the error and leaves the picker available',
    );
    await enter(chrome, session, 'folderName', 'Saved create draft');
    await click(chrome, session, '.folder-picker');
    await evaluate(chrome, session, 'document.querySelector(".project-options").open = true');
    await enter(chrome, session, 'name', 'Create display name');
    await click(chrome, session, '[role=combobox]');
    await click(chrome, session, '[role=option][data-value="vite-ts-sqlite"]');
    assert.equal(
      await evaluate(chrome, session, "document.querySelector('select[name=starter]').value"),
      'vite-ts-sqlite',
    );
    await click(chrome, session, '.project-mode-switch button[aria-pressed=false]');
    assert.equal(
      await evaluate(chrome, session, "document.querySelector('select[name=starter]') === null"),
      true,
    );
    assert.equal(await evaluate(chrome, session, 'document.querySelector(".path-selection").hidden'), true);
    await click(chrome, session, '.folder-picker');
    await enter(chrome, session, 'name', 'Open display name');
    await click(chrome, session, '.project-mode-switch button[aria-pressed=false]');
    assert.deepEqual(
      await evaluate(
        chrome,
        session,
        '[document.querySelector("input[name=folderName]").value, document.querySelector(".path-selection").textContent, document.querySelector("input[name=name]").value]',
      ),
      ['Saved create draft', '/controlled/projects', 'Create display name'],
      'Switching project actions preserves the independently edited create draft.',
    );
    await click(chrome, session, '.project-mode-switch button[aria-pressed=false]');
    assert.deepEqual(
      await evaluate(
        chrome,
        session,
        '[document.querySelector(".path-selection").textContent, document.querySelector("input[name=name]").value]',
      ),
      ['/controlled/existing', 'Open display name'],
    );
    await click(chrome, session, '.project-mode-switch button[aria-pressed=false]');
    await click(chrome, session, 'button[type=submit]');
    assert.equal((await state(chrome, session)).requests[0].starter, 'vite-ts-sqlite');
    await evaluate(chrome, session, fixture + '.fail()');
    await waitFor(
      chrome,
      session,
      'document.querySelector(".error").textContent.includes("Controlled creation failure") && !document.querySelector("button[type=submit]").disabled',
      'creation failure remains actionable without retrying',
    );
    assert.equal((await state(chrome, session)).requests.length, 1);
    assert.equal((await state(chrome, session)).opened, 0);
    await press(chrome, session, 'Escape', 27);
    await waitFor(
      chrome,
      session,
      'document.querySelector("dialog[open]") === null',
      'failed creation dismissal',
    );

    await evaluate(chrome, session, fixture + '.mount()');
    await enter(chrome, session, 'folderName', 'Cancelled owner');
    await click(chrome, session, '.folder-picker');
    await waitFor(
      chrome,
      session,
      'document.querySelector(".folder-picker").disabled === false',
      'second parent selection',
    );
    await evaluate(chrome, session, 'document.querySelector("button[type=submit]").focus()');
    await press(chrome, session, 'Enter', 13);
    await waitFor(chrome, session, fixture + '.inspect().pending', 'keyboard project submission');
    await press(chrome, session, 'Escape', 27);
    await waitFor(
      chrome,
      session,
      'document.querySelector("dialog[open]") === null',
      'creation owner dismissal',
    );
    await evaluate(chrome, session, fixture + '.finish()');
    assert.equal(
      (await state(chrome, session)).opened,
      0,
      'A late creation acknowledgement never selects a project after dismissal.',
    );
  } finally {
    await evaluate(chrome, session, 'window.mitterReleaseFixture.dispose()');
    await chrome.request('Emulation.clearDeviceMetricsOverride', {}, session);
  }
}
