import assert from 'node:assert/strict';
import { evaluate, press, waitFor } from './chrome-ui.mjs';

const fixture = 'window.mitterReleaseFixture.feedback';

async function activate(chrome, session, selector) {
  await evaluate(chrome, session, `document.querySelector(${JSON.stringify(selector)}).focus()`);
  await press(chrome, session, 'Enter', 13);
}

async function fits(chrome, session, selector) {
  assert.equal(
    await evaluate(
      chrome,
      session,
      `[...document.querySelectorAll(${JSON.stringify(selector)})].filter(element => element.checkVisibility())
        .every(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })`,
    ),
    true,
    'Feedback and actions must fit inside the viewport: ' + selector,
  );
}

async function checkOutputReads(chrome, session) {
  const start = await evaluate(chrome, session, fixture + '.inspect().outputReads.length');
  await evaluate(chrome, session, fixture + '.showOutput()');
  await waitFor(
    chrome,
    session,
    fixture + '.inspect().outputReads.length === ' + (start + 1),
    'changed file read starts once',
  );
  assert.equal(
    await evaluate(
      chrome,
      session,
      'document.querySelector(".editor-surface").textContent.includes("Loading changed files…")',
    ),
    true,
  );
  assert.equal(
    await evaluate(
      chrome,
      session,
      'document.querySelector(".editor-surface").textContent.includes("No changed files yet.")',
    ),
    false,
    'Loading files must not briefly claim the workspace is empty.',
  );
  for (const [offset, label] of [
    [0, 'files'],
    [2, 'activity'],
  ]) {
    if (label === 'activity') {
      await evaluate(
        chrome,
        session,
        `[...document.querySelectorAll('.editor-tabs button')].find(button => button.textContent.trim() === 'Activity').focus()`,
      );
      await press(chrome, session, 'Enter', 13);
      await waitFor(
        chrome,
        session,
        fixture + '.inspect().outputReads.length === ' + (start + offset + 1),
        'activity read',
      );
      assert.equal(
        await evaluate(
          chrome,
          session,
          'document.querySelector(".activity-list").textContent.includes("Loading activity…")',
        ),
        true,
      );
    }
    await evaluate(
      chrome,
      session,
      fixture + `.finishOutput(${start + offset}, 'The helper is temporarily unavailable.')`,
    );
    await waitFor(
      chrome,
      session,
      '!!document.querySelector(".editor-surface [role=alert]")',
      label + ' inline failure',
    );
    await fits(chrome, session, '.editor-surface .read-error, .editor-surface .read-error button');
    await evaluate(
      chrome,
      session,
      `[...document.querySelectorAll('.editor-surface .read-error button')].find(button => button.textContent.trim() === ${JSON.stringify('Retry ' + label)}).focus()`,
    );
    await press(chrome, session, 'Enter', 13);
    await waitFor(
      chrome,
      session,
      fixture + '.inspect().outputReads.length === ' + (start + offset + 2),
      label + ' explicit retry',
    );
    await evaluate(chrome, session, fixture + `.finishOutput(${start + offset + 1})`);
    await waitFor(
      chrome,
      session,
      '!document.querySelector(".editor-surface [role=alert]") && !document.querySelector(".editor-surface [role=status]")',
      label + ' settled retry',
    );
  }
  assert.equal(
    await evaluate(
      chrome,
      session,
      'document.querySelector(".activity-list").textContent.includes("No activity yet.")',
    ),
    true,
  );
}

export async function checkFeedback(chrome, session) {
  try {
    for (const width of [1024, 320]) {
      await chrome.request(
        'Emulation.setDeviceMetricsOverride',
        { width, height: 800, deviceScaleFactor: 1, mobile: false },
        session,
      );
      await checkOutputReads(chrome, session);
      const firstRead = await evaluate(chrome, session, fixture + '.inspect().reads');
      await evaluate(chrome, session, fixture + '.showFile()');
      await waitFor(
        chrome,
        session,
        fixture + '.inspect().reads === ' + (firstRead + 1),
        'controlled file read',
      );
      assert.equal(
        await evaluate(
          chrome,
          session,
          'document.querySelector(".file-viewer [role=status]")?.textContent.trim()',
        ),
        'Loading file…',
      );
      await evaluate(
        chrome,
        session,
        fixture +
          `.finishFile(${firstRead}, '', 'The helper disconnected while reading notes.txt. Reconnect and try again.')`,
      );
      await waitFor(
        chrome,
        session,
        '!!document.querySelector(".file-viewer [role=alert]")',
        'file read failure',
      );
      assert.match(
        await evaluate(chrome, session, 'document.querySelector(".file-viewer [role=alert]").textContent'),
        /The helper disconnected while reading notes.txt. Reconnect and try again./,
      );
      await fits(chrome, session, '.file-viewer [role=alert], .file-viewer button');
      const retry = `[...document.querySelectorAll('.file-viewer button')].find(button => button.textContent.trim() === 'Retry file')`;
      await evaluate(chrome, session, retry + '.focus()');
      await press(chrome, session, 'Enter', 13);
      await waitFor(
        chrome,
        session,
        fixture + '.inspect().reads === ' + (firstRead + 2),
        'one explicit file retry',
      );
      await evaluate(chrome, session, fixture + `.finishFile(${firstRead + 1})`);
      await waitFor(
        chrome,
        session,
        'document.querySelector(".file-content")?.textContent === "Saved project notes."',
        'retried source bytes',
      );
      assert.equal(
        await evaluate(chrome, session, '!!document.querySelector(".file-viewer [role=alert]")'),
        false,
      );
      await evaluate(chrome, session, fixture + '.showFile()');
      await waitFor(chrome, session, fixture + '.inspect().reads === ' + (firstRead + 3), 'empty file read');
      await evaluate(chrome, session, fixture + `.finishFile(${firstRead + 2}, '')`);
      await waitFor(
        chrome,
        session,
        'document.querySelector(".file-viewer")?.textContent.includes("This file is empty.")',
        'explicit empty file state',
      );

      const preferenceRead = await evaluate(chrome, session, fixture + '.inspect().preferenceReads');
      await evaluate(chrome, session, fixture + '.showNotifications()');
      await waitFor(
        chrome,
        session,
        'document.querySelector("dialog[open] h2")?.textContent === "Notifications"',
        'notification preferences',
      );
      assert.equal(
        await evaluate(chrome, session, 'document.querySelector("dialog [role=status]")?.textContent'),
        'Loading notification settings…',
      );
      await evaluate(
        chrome,
        session,
        fixture + `.finishPreferences(${preferenceRead}, 'The helper is temporarily unavailable.')`,
      );
      await waitFor(
        chrome,
        session,
        '!!document.querySelector("dialog [role=alert]")',
        'notification settings read error',
      );
      await activate(chrome, session, 'dialog .modal-body button');
      await waitFor(
        chrome,
        session,
        fixture + '.inspect().preferenceReads === ' + (preferenceRead + 2),
        'explicit settings reload',
      );
      await evaluate(chrome, session, fixture + `.finishPreferences(${preferenceRead + 1})`);
      await waitFor(
        chrome,
        session,
        'document.querySelectorAll("dialog input[type=checkbox]").length === 2',
        'notification preference values',
      );
      const labels = await evaluate(
        chrome,
        session,
        '[...document.querySelectorAll("dialog .checkline span")].map(element => element.textContent.trim())',
      );
      assert.deepEqual(labels, ['Desktop notifications', 'Play a sound']);
      const desktopControl = 'document.querySelector("dialog input[type=checkbox]:first-of-type")';
      const sound = 'document.querySelectorAll("dialog input[type=checkbox]")[1]';
      const preferenceState =
        '[' + desktopControl + '.checked, ' + sound + '.checked, ' + sound + '.disabled]';
      assert.deepEqual(
        await evaluate(chrome, session, preferenceState),
        [false, true, false],
        'Sound is available while desktop notifications are off.',
      );
      await evaluate(chrome, session, sound + '.focus()');
      await press(chrome, session, ' ', 32);
      assert.deepEqual(await evaluate(chrome, session, preferenceState), [false, false, false]);
      await evaluate(chrome, session, desktopControl + '.focus()');
      await press(chrome, session, ' ', 32);
      assert.deepEqual(await evaluate(chrome, session, preferenceState), [true, false, false]);
      await press(chrome, session, ' ', 32);
      await evaluate(chrome, session, sound + '.focus()');
      await press(chrome, session, ' ', 32);
      assert.deepEqual(await evaluate(chrome, session, preferenceState), [false, true, false]);
      await fits(chrome, session, 'dialog .checkline, dialog button, dialog p');

      const saved = await evaluate(chrome, session, fixture + '.inspect().saves.length');
      await activate(chrome, session, 'dialog button.primary');
      await waitFor(
        chrome,
        session,
        fixture + '.inspect().saves.length === ' + (saved + 1),
        'preference save',
      );
      assert.deepEqual(await evaluate(chrome, session, fixture + `.inspect().saves[${saved}]`), {
        enabled: false,
        sound: true,
      });
      assert.equal(
        await evaluate(
          chrome,
          session,
          '[...document.querySelectorAll("dialog input[type=checkbox]")].every(input => input.disabled)',
        ),
        true,
      );
      assert.match(
        await evaluate(chrome, session, 'document.querySelector("dialog button.primary").textContent'),
        /Saving/,
      );
      await evaluate(
        chrome,
        session,
        fixture + `.finishSave(${saved}, 'Could not save notification settings. Try again.')`,
      );
      await waitFor(
        chrome,
        session,
        '!!document.querySelector("dialog [role=alert]")',
        'preferences save error',
      );
      assert.match(
        await evaluate(chrome, session, 'document.querySelector("dialog [role=alert]").textContent'),
        /Could not save/,
      );
      assert.equal(await evaluate(chrome, session, sound + '.checked'), true);

      await evaluate(chrome, session, desktopControl + '.focus()');
      const message =
        'Could not open the saved project. Its files are unchanged; check the folder and try again.';
      await evaluate(
        chrome,
        session,
        `${fixture}.notify(${JSON.stringify(message)}, true, true); ${fixture}.notify(${JSON.stringify(message)}, true, true)`,
      );
      await waitFor(
        chrome,
        session,
        '!!document.querySelector("dialog[open] .miter-toast")',
        'notification remains in active dialog',
      );
      assert.equal(await evaluate(chrome, session, 'document.querySelectorAll(".miter-toast").length'), 1);
      assert.equal(await evaluate(chrome, session, 'document.activeElement === ' + desktopControl), true);
      await fits(chrome, session, '.miter-toast, .miter-toast button');
      const calls = await evaluate(chrome, session, fixture + '.inspect().actionCalls');
      await activate(chrome, session, '.miter-toast-action');
      await evaluate(chrome, session, 'document.querySelector(".miter-toast-action").click()');
      assert.equal(await evaluate(chrome, session, fixture + '.inspect().actionCalls'), calls + 1);
      await evaluate(chrome, session, fixture + '.finishNotification("The folder is still unavailable.")');
      await waitFor(
        chrome,
        session,
        'document.querySelector(".miter-toast-content p")?.textContent === "The folder is still unavailable."',
        'notification failure',
      );
      await evaluate(chrome, session, 'document.querySelector(".miter-toast-close").focus()');
      await press(chrome, session, 'Escape', 27);
      assert.equal(await evaluate(chrome, session, 'document.querySelectorAll(".miter-toast").length'), 0);
      assert.equal(await evaluate(chrome, session, '!!document.querySelector("dialog[open]")'), true);
      assert.equal(await evaluate(chrome, session, 'document.activeElement === ' + desktopControl), true);
      await press(chrome, session, 'Escape', 27);
      await waitFor(chrome, session, '!document.querySelector("dialog[open]")', 'preferences dismissed');
      await evaluate(chrome, session, fixture + '.showNotifications()');
      await waitFor(
        chrome,
        session,
        fixture + '.inspect().preferenceReads === ' + (preferenceRead + 3),
        'new pending preference read',
      );
      await press(chrome, session, 'Escape', 27);
      await evaluate(chrome, session, fixture + `.finishPreferences(${preferenceRead + 2})`);
      assert.equal(
        await evaluate(chrome, session, '!!document.querySelector("dialog[open]")'),
        false,
        'Late preference reads cannot reopen a dismissed dialog.',
      );
    }
  } finally {
    await evaluate(chrome, session, 'window.mitterReleaseFixture.dispose()');
    await chrome.request('Emulation.clearDeviceMetricsOverride', {}, session);
  }
}
