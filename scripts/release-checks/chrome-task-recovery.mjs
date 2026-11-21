import assert from 'node:assert/strict';
import { click, evaluate, waitFor } from './chrome-ui.mjs';

/** Only the already-owned private release page; never opens a provider or grants host access. */
export async function checkTaskRecovery(chrome, session) {
  try {
    for (const width of [1024, 320]) {
      await chrome.request(
        'Emulation.setDeviceMetricsOverride',
        { width, height: 720, deviceScaleFactor: 1, mobile: false },
        session,
      );
      await evaluate(chrome, session, 'window.mitterReleaseFixture.taskStart.mount()');
      await click(chrome, session, '.form-advanced > summary');
      await click(chrome, session, '[data-rule] + .select-control .select-trigger');
      assert.equal(
        await evaluate(
          chrome,
          session,
          `(() => {
            const option = document.querySelector('[data-command-check]');
            const row = document.querySelector('.select-popup:not([hidden]) [data-value="command"]');
            const hint = document.querySelector('[data-command-check-hint]');
            const profile = document.querySelector('[data-profile]');
            return option instanceof HTMLOptionElement && option.disabled &&
              row?.getAttribute('aria-disabled') === 'true' && row.getClientRects().length > 0 &&
              hint?.getClientRects().length > 0 && hint.textContent.includes('Actions → Test commands') &&
              profile instanceof HTMLSelectElement && profile.disabled && !profile.required;
          })()`,
        ),
        true,
        'Unavailable test commands must be visibly disabled with a way forward at ' + width + 'px.',
      );
      await click(chrome, session, '.select-popup:not([hidden]) [data-value="command"]');
      assert.equal(
        await evaluate(chrome, session, 'document.querySelector("[data-rule]").value'),
        'human',
        'Clicking the unavailable command cannot strand the form on an empty required picker.',
      );
      await evaluate(chrome, session, 'window.mitterReleaseFixture.dispose()');

      await evaluate(chrome, session, 'window.mitterReleaseFixture.taskRecovery.show()');
      await waitFor(
        chrome,
        session,
        'document.querySelector("[data-chat]")?.value === "42"',
        'remembered task conversation',
      );
      await click(chrome, session, '.start-options > summary');
      await click(chrome, session, '[data-find]');
      await evaluate(chrome, session, 'window.mitterReleaseFixture.taskRecovery.resolvePermission(true)');
      await waitFor(
        chrome,
        session,
        'document.querySelector("[data-chat]")?.options.length === 4',
        'controlled open conversations',
      );
      assert.deepEqual(
        await evaluate(
          chrome,
          session,
          'Array.from(document.querySelector("[data-chat]").options).map(option => option.textContent)',
        ),
        ['New ChatGPT chat', 'Planning (chat 1)', 'Planning (chat 2)', 'Project notes'],
        'Conversation labels must be readable and distinguish duplicate titles without internal IDs.',
      );
      assert.equal(
        await evaluate(chrome, session, 'document.querySelector(".destination-dot") === null'),
        true,
      );
      await evaluate(
        chrome,
        session,
        `(() => {
          for (const [selector, value] of [['[data-turns]', '8'], ['[data-minutes]', '15']]) {
            const input = document.querySelector(selector);
            if (!(input instanceof HTMLSelectElement)) {
              throw new Error('The production start limits are missing.');
            }
            input.value = value;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()`,
      );

      await click(chrome, session, '[data-start]');
      assert.equal(
        await evaluate(
          chrome,
          session,
          `['[data-chat]', '[data-turns]', '[data-minutes]'].every(selector => {
            const control = document.querySelector(selector);
            const trigger = control?.nextElementSibling?.querySelector('.select-trigger');
            return control instanceof HTMLSelectElement && control.disabled &&
              trigger instanceof HTMLButtonElement && trigger.disabled;
          }) && document.querySelector('[data-start]').disabled && document.querySelector('[data-find]').disabled`,
        ),
        true,
        'Permission waits must disable both form values and their visible controls.',
      );
      await evaluate(chrome, session, 'window.mitterReleaseFixture.taskRecovery.resolvePermission(false)');
      await waitFor(
        chrome,
        session,
        'document.querySelector("[data-start]")?.disabled === false',
        'unsent permission-denied retry',
      );
      assert.equal(
        await evaluate(
          chrome,
          session,
          `window.mitterReleaseFixture.taskRecovery.inspect().starts.length === 0 &&
            document.querySelector('[data-error]').textContent.includes('Nothing was sent.') &&
            !document.querySelector('[data-start]').hidden`,
        ),
        true,
      );

      await click(chrome, session, '[data-start]');
      await evaluate(chrome, session, 'window.mitterReleaseFixture.taskRecovery.resolvePermission(true)');
      await waitFor(
        chrome,
        session,
        'window.mitterReleaseFixture.taskRecovery.inspect().starts.length === 1',
        'one controlled task admission request',
      );
      assert.deepEqual(
        await evaluate(chrome, session, 'window.mitterReleaseFixture.taskRecovery.inspect().starts'),
        [{ consent: true, newChat: false, tabId: 42, maxTurns: 8, maxMinutes: 15 }],
      );
      await evaluate(chrome, session, 'window.mitterReleaseFixture.taskRecovery.rejectStart()');
      await waitFor(
        chrome,
        session,
        'document.querySelector("[data-cancel]")?.textContent === "Back to task"',
        'safe recovery after an uncertain start',
      );
      assert.equal(
        await evaluate(
          chrome,
          session,
          `(() => {
            const recovery = document.querySelector('[data-cancel]');
            const error = document.querySelector('[data-error]');
            recovery.scrollIntoView({ block: 'center' });
            const box = recovery.getBoundingClientRect();
            const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
            return recovery === document.activeElement && recovery.contains(hit) &&
              document.querySelector('[data-start]').hidden && error.getClientRects().length > 0 &&
              error.textContent.includes('check its status before trying again');
          })()`,
        ),
        true,
        'The recovery action must be focused, visible and reachable at ' + width + 'px.',
      );
      await evaluate(
        chrome,
        session,
        `(() => {
          document.querySelector('[data-start]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
          document.querySelector('[data-find]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        })()`,
      );
      assert.deepEqual(
        await evaluate(chrome, session, 'window.mitterReleaseFixture.taskRecovery.inspect()'),
        {
          authorizations: 3,
          inventories: 1,
          closed: 0,
          stopped: 0,
          starts: [{ consent: true, newChat: false, tabId: 42, maxTurns: 8, maxMinutes: 15 }],
        },
        'Rejected admission must never trigger another start, permission request or guessed cleanup.',
      );
      await click(chrome, session, '[data-cancel]');
      await waitFor(
        chrome,
        session,
        'document.querySelectorAll("dialog[open]").length === 0',
        'return to the task after uncertain start',
      );

      for (const mode of ['project', 'setup']) {
        await evaluate(
          chrome,
          session,
          `window.mitterReleaseFixture.taskRecovery.showNavigation(${JSON.stringify(mode)})`,
        );
        await click(chrome, session, '.home-actions .primary');
        assert.deepEqual(
          await evaluate(
            chrome,
            session,
            `(() => {
              const result = document.querySelector('[data-task-navigation]');
              return { modal: result.dataset.modal, projectId: result.dataset.projectId };
            })()`,
          ),
          { modal: 'worker', projectId: 'navigation_project' },
          mode + ': New task must call the real controller with its current project, never a MouseEvent.',
        );
      }
    }
    console.log('PASS: task command availability, permission waits and safe start recovery at 1024/320px.');
  } finally {
    await evaluate(
      chrome,
      session,
      'window.mitterReleaseFixture.dispose(); window.mitterReleaseFixture.taskRecovery.dispose()',
    );
    await chrome.request('Emulation.clearDeviceMetricsOverride', {}, session);
  }
}
