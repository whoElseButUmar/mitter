import assert from 'node:assert/strict';
import { click, evaluate, press } from './chrome-ui.mjs';

export async function checkProjectHome(chrome, session) {
  try {
    for (const width of [1024, 320, 290]) {
      await chrome.request(
        'Emulation.setDeviceMetricsOverride',
        {
          width,
          height: 640,
          deviceScaleFactor: 1,
          mobile: false,
        },
        session,
      );
      for (const mode of [
        'projects',
        'tasks',
        'empty',
        'starter',
        'offline',
        'result',
        'result-unverified',
        'result-offline',
        'result-only',
      ]) {
        await evaluate(
          chrome,
          session,
          `window.mitterReleaseFixture.projectHome.show(${JSON.stringify(mode)})`,
        );
        assert.equal(
          await evaluate(
            chrome,
            session,
            `(() => {
          const panel = document.querySelector('.project-home');
          return panel.scrollWidth <= panel.clientWidth + 1 && panel.getBoundingClientRect().right <= innerWidth + 1;
        })()`,
          ),
          true,
          mode + ' fits at ' + width + 'px',
        );
        assert.equal(
          await evaluate(chrome, session, 'document.querySelector(".home-actions button").disabled'),
          mode === 'offline' || mode === 'result-offline',
        );
        if (mode.startsWith('result')) {
          let heading = 'App ready';
          if (mode === 'result-unverified') {
            heading = 'Task complete';
          }
          assert.deepEqual(
            await evaluate(
              chrome,
              session,
              `(() => {
                const result = document.querySelector('.project-result');
                const name = result.querySelector('.project-result-name').textContent;
                return { heading: result.querySelector('h2').textContent,
                  duplicate: [...document.querySelectorAll('.saved-entry-name')].some(entry => entry.textContent === name),
                  foreign: document.querySelector('.project-home').textContent.includes('Result belonging to another project'),
                  disabled: result.querySelector('button').disabled };
              })()`,
            ),
            { heading, duplicate: false, foreign: false, disabled: false },
            'The latest completion is scoped to this project, distinct from recent tasks and available offline.',
          );
          await evaluate(chrome, session, 'document.querySelector(".project-result button").focus()');
          await press(chrome, session, 'Enter', 13);
          assert.deepEqual(
            await evaluate(chrome, session, 'window.mitterReleaseFixture.projectHome.actions()'),
            ['latest_result'],
            'View result opens the exact task without starting it.',
          );
          if (mode === 'result-only') {
            assert.equal(
              await evaluate(chrome, session, 'document.querySelectorAll(".saved-entry").length'),
              0,
            );
            assert.equal(
              await evaluate(
                chrome,
                session,
                'document.querySelector(".project-home > .text-button") === null',
              ),
              true,
            );
          } else {
            assert.equal(
              await evaluate(chrome, session, 'document.querySelectorAll(".saved-entry").length'),
              6,
            );
            await click(chrome, session, '.saved-entry');
            await click(chrome, session, '.project-home > .text-button');
            assert.deepEqual(
              await evaluate(chrome, session, 'window.mitterReleaseFixture.projectHome.actions()'),
              ['latest_result', 'older_result', 'tasks'],
            );
          }
          continue;
        }
        if (mode === 'starter') {
          assert.deepEqual(
            await evaluate(chrome, session, 'window.mitterReleaseFixture.projectHome.actions()'),
            [],
          );
          assert.equal(
            await evaluate(
              chrome,
              session,
              'document.querySelector(".home-actions .primary").textContent.trim()',
            ),
            'Run app',
          );
          await evaluate(chrome, session, 'document.querySelector(".home-actions .primary").focus()');
          await press(chrome, session, 'Enter', 13);
          assert.deepEqual(
            await evaluate(chrome, session, 'window.mitterReleaseFixture.projectHome.actions()'),
            ['run:saved_project_0'],
          );
          continue;
        }
        if (mode === 'empty') {
          assert.equal(
            await evaluate(chrome, session, 'document.querySelectorAll(".saved-entry").length'),
            0,
          );
          await click(chrome, session, '.home-actions .primary');
          assert.equal(
            await evaluate(chrome, session, 'window.mitterReleaseFixture.projectHome.actions().join(",")'),
            'task',
          );
          continue;
        }
        assert.equal(await evaluate(chrome, session, 'document.querySelectorAll(".saved-entry").length'), 6);
        await click(chrome, session, '.saved-entry');
        await click(chrome, session, '.project-home > .text-button');
        let expected = 'saved_project_7,projects';
        if (mode === 'tasks') {
          expected = 'saved_task_7,tasks';
        }
        assert.equal(
          await evaluate(chrome, session, 'window.mitterReleaseFixture.projectHome.actions().join(",")'),
          expected,
        );
      }
    }
  } finally {
    await chrome.request('Emulation.clearDeviceMetricsOverride', {}, session);
    await evaluate(chrome, session, 'window.mitterReleaseFixture.dispose()');
  }
}
