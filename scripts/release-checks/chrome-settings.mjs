import assert from 'node:assert/strict';
import path from 'node:path';
import { click, evaluate, press, waitFor } from './chrome-ui.mjs';

const advanced = 'details[data-model-advanced]';
const model = '.model-settings-form';
const preferenceKey = 'miter.terminal.appearance.v1';

function appearanceField(label) {
  return `[...document.querySelectorAll('.terminal-appearance label.field')].find(field => field.querySelector(':scope > span')?.textContent === ${JSON.stringify(label)})`;
}

async function storedModelAndTasks(native) {
  const { openNodeSqlite } = await import('../../dist/apps/host/src/adapters/sqlite.js');
  const database = openNodeSqlite(path.join(native.state, 'mitter.sqlite'), true);
  try {
    return {
      settings: database.prepare("SELECT value FROM kv WHERE key='settings'").get(),
      workers: database.prepare('SELECT value FROM workers ORDER BY id').all(),
    };
  } finally {
    database.close();
  }
}

async function toggleDetails(chrome, session, selector, open) {
  await evaluate(
    chrome,
    session,
    `document.querySelector(${JSON.stringify(selector + ' > summary')}).focus()`,
  );
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    `document.querySelector(${JSON.stringify(selector)}).open === ${JSON.stringify(open)}`,
    selector + ' toggled with the keyboard',
  );
}

async function checkDialogWidth(chrome, session) {
  for (const width of [1024, 320]) {
    await chrome.request(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 900, deviceScaleFactor: 1, mobile: false },
      session,
    );
    assert.equal(
      await evaluate(
        chrome,
        session,
        `(() => {
          const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
          const bounds = dialog.getBoundingClientRect();
          const controls = [...dialog.querySelectorAll('button, summary, input')].filter(control => control.checkVisibility());
          return bounds.left >= 0 && bounds.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth &&
            controls.every(control => { const box = control.getBoundingClientRect(); return box.left >= bounds.left && box.right <= bounds.right; });
        })()`,
      ),
      true,
      'Settings controls fit the dialog at ' + width + 'px.',
    );
  }
  await chrome.request('Emulation.clearDeviceMetricsOverride', {}, session);
}

async function checkModelDisclosure(chrome, session) {
  assert.equal(
    await evaluate(
      chrome,
      session,
      `!document.querySelector('${advanced}').open && !document.querySelector('.settings-data').open &&
        !document.querySelector('input[name=coderModelPath]').checkVisibility() &&
        !document.querySelector('[data-reset]').checkVisibility() &&
        document.querySelector('.settings-appearance').checkVisibility()`,
    ),
    true,
    'Settings starts with Appearance available and advanced model/reset controls collapsed.',
  );
  await checkDialogWidth(chrome, session);
  await toggleDetails(chrome, session, advanced, true);
  await evaluate(
    chrome,
    session,
    `const draft = document.querySelector('input[name=coderModelPath]');
      draft.value = '/controlled/unsaved-model.gguf'; draft.dispatchEvent(new Event('input', {bubbles:true}));
      const tokens = document.querySelector('input[name=contextSize]'); tokens.value = '';`,
  );
  await toggleDetails(chrome, session, advanced, false);
  await evaluate(chrome, session, `document.querySelector('${model}').requestSubmit()`);
  await waitFor(
    chrome,
    session,
    `document.querySelector('${advanced}').open && document.activeElement.matches('input[name=contextSize]')`,
    'native invalid model field reveals Advanced and receives focus',
  );
  assert.notEqual(
    await evaluate(chrome, session, `document.querySelector('${model}').getAttribute('aria-busy')`),
    'true',
  );
  await evaluate(chrome, session, `document.querySelector('input[name=contextSize]').value = '8192'`);
  await toggleDetails(chrome, session, '.settings-data', true);
  assert.equal(
    await evaluate(
      chrome,
      session,
      `document.querySelector('[data-reset]').checkVisibility() && !document.querySelector('form.data-reset-form')`,
    ),
    true,
    'Opening Application data only reveals its explicit reset action.',
  );
  await toggleDetails(chrome, session, '.settings-data', false);
  await toggleDetails(chrome, session, advanced, false);
}

async function changeThemeAndRestore(chrome, session) {
  const theme = appearanceField('Theme');
  const initial = await evaluate(
    chrome,
    session,
    `({value: ${theme}.querySelector('select').value, index: ${theme}.querySelector('select').selectedIndex,
      preview: getComputedStyle(document.querySelector('.terminal-theme-preview')).backgroundColor})`,
  );
  await evaluate(chrome, session, theme + '.querySelector(".select-trigger").focus()');
  await press(chrome, session, 'ArrowDown', 40);
  await press(chrome, session, 'End', 35);
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    `${theme}.querySelector('select').value !== ${JSON.stringify(initial.value)} &&
      getComputedStyle(document.querySelector('.terminal-theme-preview')).backgroundColor !== ${JSON.stringify(initial.preview)}`,
    'keyboard theme selection updates its preview',
  );
  const changed = await evaluate(chrome, session, theme + '.querySelector("select").value');
  await waitFor(
    chrome,
    session,
    `chrome.storage.local.get(${JSON.stringify(preferenceKey)}).then(values => values[${JSON.stringify(preferenceKey)}]?.themeId === ${JSON.stringify(changed)})`,
    'theme selection saves automatically',
  );
  await evaluate(chrome, session, theme + '.querySelector(".select-trigger").focus()');
  await press(chrome, session, 'ArrowDown', 40);
  await press(chrome, session, 'Home', 36);
  for (let index = 0; index < initial.index; index++) {
    await press(chrome, session, 'ArrowDown', 40);
  }
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    `chrome.storage.local.get(${JSON.stringify(preferenceKey)}).then(values => values[${JSON.stringify(preferenceKey)}]?.themeId === ${JSON.stringify(initial.value)} &&
      ${theme}.querySelector('select').value === ${JSON.stringify(initial.value)})`,
    'original theme restored through the same styled control',
  );
}

async function checkTerminalAppearance(chrome, session) {
  await evaluate(chrome, session, 'document.querySelector(".settings-appearance").focus()');
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    `[...document.querySelectorAll('dialog[open] h2')].some(heading => heading.textContent === 'Terminal appearance')`,
    'terminal appearance from Settings',
  );
  const size = appearanceField('Font size') + '.querySelector("input")';
  await waitFor(chrome, session, '!' + size + '.disabled', 'appearance preferences loaded');
  assert.equal(
    await evaluate(
      chrome,
      session,
      `!document.querySelector('.terminal-appearance-options').open &&
        ![...document.querySelectorAll('.terminal-appearance input[type=file]')].some(input => input.checkVisibility()) &&
        ${size}.checkVisibility() && ${appearanceField('Theme')}.querySelector('.select-trigger').checkVisibility() &&
        document.querySelector('.terminal-appearance .settings-footer').checkVisibility()`,
    ),
    true,
    'Appearance starts with theme, font, size and automatic-save feedback; technical options are collapsed.',
  );
  await checkDialogWidth(chrome, session);
  await toggleDetails(chrome, session, '.terminal-appearance-options', true);
  assert.equal(
    await evaluate(
      chrome,
      session,
      appearanceField('Line height') + '.querySelector("input").checkVisibility()',
    ),
    true,
  );
  await toggleDetails(chrome, session, '.terminal-appearance-options', false);
  await changeThemeAndRestore(chrome, session);
  await evaluate(
    chrome,
    session,
    `const size = ${size}; size.value = '18'; size.dispatchEvent(new Event('change', {bubbles:true}));`,
  );
  await waitFor(
    chrome,
    session,
    'getComputedStyle(document.querySelector(".terminal-theme-preview")).fontSize === "18px"',
    'font size reaches the appearance preview',
  );
  await press(chrome, session, 'Escape', 27);
  await waitFor(
    chrome,
    session,
    'document.querySelectorAll("dialog[open]").length === 1 && document.activeElement.matches(".settings-appearance")',
    'appearance closes back to its Settings launcher',
  );
  assert.equal(
    await evaluate(
      chrome,
      session,
      `document.querySelector('input[name=coderModelPath]').value === '/controlled/unsaved-model.gguf' &&
        !document.querySelector('${advanced}').open`,
    ),
    true,
    'Nested appearance preserves the unsaved model draft and disclosure state.',
  );
  await press(chrome, session, 'Enter', 13);
  await waitFor(chrome, session, size + '.value === "18"', 'appearance survives reopening');
  await press(chrome, session, 'Escape', 27);
  await waitFor(
    chrome,
    session,
    'document.querySelectorAll("dialog[open]").length === 1',
    'Settings remains',
  );
}

async function checkNotificationSettings(chrome, session) {
  await evaluate(chrome, session, 'document.querySelector(".settings-notifications").focus()');
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    `[...document.querySelectorAll('dialog[open] h2')].some(heading => heading.textContent === 'Notifications') &&
      document.querySelectorAll('dialog[open] input[type=checkbox]').length >= 2`,
    'notification preferences from Settings',
  );
  await checkDialogWidth(chrome, session);
  await press(chrome, session, 'Escape', 27);
  await waitFor(
    chrome,
    session,
    'document.querySelectorAll("dialog[open]").length === 1 && document.activeElement.matches(".settings-notifications")',
    'notifications close back to their Settings launcher',
  );
  assert.equal(
    await evaluate(
      chrome,
      session,
      `document.querySelector('input[name=coderModelPath]').value === '/controlled/unsaved-model.gguf' &&
        !document.querySelector('${advanced}').open`,
    ),
    true,
    'Nested notification preferences preserve the unsaved model draft and disclosure state.',
  );
}

export async function checkAppearanceSettings(chrome, session, native) {
  const initial = await storedModelAndTasks(native);
  await click(chrome, session, '[aria-label=Settings]');
  await waitFor(chrome, session, '!!document.querySelector("input[name=coderModelPath]")', 'model settings');
  await checkModelDisclosure(chrome, session);
  await checkTerminalAppearance(chrome, session);
  await checkNotificationSettings(chrome, session);
  await toggleDetails(chrome, session, advanced, true);
  await toggleDetails(chrome, session, '.settings-data', true);
  await evaluate(chrome, session, 'document.querySelector("[data-reset]").focus()');
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    '!!document.querySelector(".data-reset-form")',
    'explicit data reset confirmation',
  );
  assert.equal(
    await evaluate(
      chrome,
      session,
      'document.querySelector("[data-clear]").disabled && document.querySelector("[data-confirm]").value === ""',
    ),
    true,
    'The separate reset confirmation still requires typing CLEAR before deletion is available.',
  );
  await press(chrome, session, 'Escape', 27);
  await waitFor(
    chrome,
    session,
    '!document.querySelector("dialog[open]")',
    'data reset cancelled with Escape',
  );
  assert.deepEqual(
    await storedModelAndTasks(native),
    initial,
    'Opening Settings, editing an unsaved draft and changing appearance never saves models or starts tasks.',
  );
}
