import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { parseContract } from '../helpers/runtime.mjs';
import {
  targetIdSchema,
  sessionIdSchema,
  evaluationSchema,
  pageNavigationSchema,
  waitConditionSchema,
  fixtureStateSchema,
  domCountersSchema,
  attentionLayoutSchema,
} from './chrome-schemas.mjs';

export async function evaluate(chrome, session, expression, contextId = undefined) {
  const parameters = { expression, awaitPromise: true, returnByValue: true, userGesture: true };
  if (contextId !== undefined) {
    parameters.contextId = contextId;
  }

  const result = parseContract(
    evaluationSchema,
    await chrome.request('Runtime.evaluate', parameters, session),
    'Invalid browser evaluation reply. Inspect the Chrome release-check log.',
  );

  if (result.exceptionDetails) {
    throw new Error('Browser expression failed: ' + expression, { cause: result.exceptionDetails });
  }

  return result.result.value;
}

export async function waitFor(chrome, session, expression, label, contextId = undefined) {
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    const ready = parseContract(
      waitConditionSchema,
      await evaluate(chrome, session, expression, contextId),
      'Invalid Chrome readiness result for ' + label + '. Expected a boolean condition.',
    );

    if (ready) {
      return;
    }

    await delay(30);
  }

  throw new Error('Chrome did not reach: ' + label);
}

export async function page(chrome, url) {
  const { targetId } = parseContract(
    targetIdSchema,
    await chrome.request('Target.createTarget', { url: 'about:blank' }),
    'Chrome did not return the created page target ID.',
  );
  const { sessionId } = parseContract(
    sessionIdSchema,
    await chrome.request('Target.attachToTarget', { targetId, flatten: true }),
    'Chrome did not return the attached page session ID.',
  );

  await chrome.request('Runtime.enable', {}, sessionId);
  await chrome.request('Log.enable', {}, sessionId);
  await chrome.request('Page.enable', {}, sessionId);
  const navigation = parseContract(
    pageNavigationSchema,
    await chrome.request('Page.navigate', { url }, sessionId),
    'Chrome did not return a valid page navigation acknowledgement.',
  );

  if (navigation.errorText !== undefined) {
    throw new Error('Chrome navigation failed: ' + navigation.errorText);
  }

  await waitFor(chrome, sessionId, 'document.readyState === "complete"', 'page load');

  return { targetId, session: sessionId };
}

export async function press(chrome, session, key, code) {
  for (const type of ['keyDown', 'keyUp']) {
    const parameters = { type, key, code: key, windowsVirtualKeyCode: code };

    if (type === 'keyDown' && key === 'Enter') {
      parameters.text = '\r';
      parameters.unmodifiedText = '\r';
    }

    await chrome.request('Input.dispatchKeyEvent', parameters, session);
  }
}

export async function click(chrome, session, selector) {
  await evaluate(
    chrome,
    session,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) {
        throw new Error('The requested control is missing.');
      }
      element.click();
    })()`,
  );
}

async function inspect(chrome, session) {
  return parseContract(
    fixtureStateSchema,
    await evaluate(chrome, session, 'window.mitterReleaseFixture.inspect()'),
    'Invalid production UI fixture observations. Rebuild the release fixture before retrying.',
  );
}

async function submitProject(chrome, session, name) {
  await evaluate(
    chrome,
    session,
    `(() => {
      const inputs = document.querySelectorAll('input[required]');
      if (inputs.length !== 2) {
        throw new Error('Expected two project fields.');
      }
      const values = ['/controlled/project', ${JSON.stringify(name)}];
      for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index];
        if (!(input instanceof HTMLInputElement)) {
          throw new Error('Expected native input.');
        }
        input.value = values[index];
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const form = document.querySelector('form');
      if (!(form instanceof HTMLFormElement)) {
        throw new Error('Expected project form.');
      }
      form.requestSubmit();
    })()`,
  );

  const state = await inspect(chrome, session);
  const pending = state.pendingSaves.at(-1);
  assert.ok(pending, 'A valid form starts one controlled save.');
  assert.equal(pending.name, name);
  assert.equal(pending.root, '/controlled/project');
  assert.equal(state.busy, true);

  return pending.id;
}

export async function checkDialogs(chrome, session) {
  await evaluate(chrome, session, 'window.mitterReleaseFixture.mountProject()');
  let state = await inspect(chrome, session);
  assert.equal(state.dialogs, 1);
  assert.equal(state.sameTreeLabel, true);
  assert.equal(state.fields.length, 2);
  assert.ok(state.fields.every((field) => !field.userInvalid && field.ariaInvalid === null));

  await evaluate(chrome, session, 'document.querySelector("button[type=submit]").focus()');
  await press(chrome, session, 'Enter', 13);
  await waitFor(
    chrome,
    session,
    'window.mitterReleaseFixture.inspect().fields[0]?.focused === true',
    'native invalid-field focus',
  );
  state = await inspect(chrome, session);
  assert.equal(state.pendingSaves.length, 0);
  assert.ok(state.fields[0]?.focused, 'Chrome focuses the first invalid required field.');
  assert.ok(state.fields.every((field) => field.userInvalid && field.ariaInvalid === 'true'));

  const failure = await submitProject(chrome, session, 'Readable error');
  await evaluate(
    chrome,
    session,
    `window.mitterReleaseFixture.finishSave(${failure}, 'Controlled save failure.')`,
  );
  await waitFor(chrome, session, '!window.mitterReleaseFixture.inspect().busy', 'save failure settlement');
  state = await inspect(chrome, session);
  assert.equal(state.dialogs, 1);
  assert.ok(
    state.alerts.some(
      (alert) =>
        alert.visible &&
        alert.text.includes('Controlled save failure.') &&
        alert.text.includes('Check the project list before repeating the action.'),
    ),
    'The visible error must include the cause and explain how to avoid repeating an uncertain write.',
  );
  assert.ok(state.fields.every((field) => !field.userInvalid && field.ariaInvalid === null));

  await press(chrome, session, 'Escape', 27);
  await waitFor(chrome, session, 'window.mitterReleaseFixture.inspect().dialogs === 0', 'Escape dismissal');
  assert.equal((await inspect(chrome, session)).activeId, 'fixture-open-project');

  for (const failureMessage of ['', 'Old save failed after replacement.']) {
    await evaluate(chrome, session, 'window.mitterReleaseFixture.mountProject()');
    const stale = await submitProject(chrome, session, 'Old project');
    await evaluate(chrome, session, 'window.mitterReleaseFixture.mountReplacement()');
    await evaluate(
      chrome,
      session,
      `window.mitterReleaseFixture.finishSave(${stale}, ${JSON.stringify(failureMessage)})`,
    );
    state = await inspect(chrome, session);
    assert.equal(state.title, 'Replacement dialog');
    assert.equal(state.replacementDraft, 'Newer draft');
    assert.equal(state.navigation, 'replacement');
    assert.equal(state.alerts.length, 0);
  }

  await evaluate(chrome, session, 'window.mitterReleaseFixture.mountProject()');
  const old = await submitProject(chrome, session, 'Old busy owner');
  await evaluate(chrome, session, 'window.mitterReleaseFixture.mountProject()');
  const newer = await submitProject(chrome, session, 'New busy owner');
  await evaluate(chrome, session, `window.mitterReleaseFixture.finishSave(${old})`);
  assert.equal((await inspect(chrome, session)).busy, true);
  await evaluate(
    chrome,
    session,
    `window.mitterReleaseFixture.finishSave(${newer}, 'Finish controlled save.')`,
  );
  await evaluate(chrome, session, 'window.mitterReleaseFixture.dispose()');
  await checkAttentionLayout(chrome, session);
}

function assertContained(inner, outer, label) {
  assert.ok(
    inner.left >= outer.left - 1 &&
      inner.right <= outer.right + 1 &&
      inner.top >= outer.top - 1 &&
      inner.bottom <= outer.bottom + 1,
    label + ' must remain inside its layout row.',
  );
}

function assertItemsContained(items, row, label) {
  for (const [index, item] of items.entries()) {
    assertContained(item.rect, row, label + ': ' + item.text);
    for (const next of items.slice(index + 1)) {
      assert.ok(
        item.rect.right <= next.rect.left + 1 ||
          next.rect.right <= item.rect.left + 1 ||
          item.rect.bottom <= next.rect.top + 1 ||
          next.rect.bottom <= item.rect.top + 1,
        label + ': ' + item.text + ' must not overlap ' + next.text + '.',
      );
    }
  }
}

export function assertAttentionLayout(value) {
  const layout = parseContract(
    attentionLayoutSchema,
    value,
    'Invalid task attention geometry. Inspect the production component fixture and Chrome log.',
  );
  const label = layout.viewport.width + '×' + layout.viewport.height;
  assert.equal(layout.role, 'status', label + ': retain the status announcement.');
  assert.equal(layout.live, 'polite', label + ': retain polite live announcements.');
  assert.equal(layout.domOrder, true, label + ': retain status, runner, recovery, and editor reading order.');
  assert.ok(
    layout.project.scrollWidth <= layout.project.clientWidth + 1,
    label + ': the task pane must not require horizontal scrolling.',
  );
  assertContained(layout.statusLabel, layout.status, label + ': status label');
  assertContained(layout.summary, layout.status, label + ': full attention reason');
  for (const line of layout.summaryLines) {
    assertContained(line, layout.summary, label + ': each reason line');
  }
  assert.ok(
    layout.status.bottom <= layout.runner.top + 1,
    label + ': status must end before runner controls.',
  );
  if (layout.error) {
    assert.ok(layout.status.bottom <= layout.error.top + 1, label + ': error must follow status.');
    assert.ok(
      layout.error.bottom <= layout.runner.top + 1,
      label + ': error must end before runner controls.',
    );
  }
  assertItemsContained(layout.runnerItems, layout.runner, label + ': runner controls');
  assert.ok(
    layout.runner.bottom <= layout.recovery.top + 1,
    label + ': recovery must follow runner controls.',
  );
  assertItemsContained(layout.recoveryItems, layout.recovery, label + ': recovery controls');
  assert.ok(
    layout.recovery.bottom <= layout.editor.top + 1,
    label + ': editor must follow recovery controls.',
  );

  return layout;
}

export async function checkAttentionLayout(chrome, session) {
  const deadline = Date.now() + 20000;
  const shortReason = 'The reply could not be confirmed. Check the linked chat before resending.';
  const longReason = (
    shortReason +
    ' Already-applied actions must not be replayed; the saved prompt and completed work are kept. '
  ).repeat(5);
  const unbrokenReason = longReason + 'https://example.invalid/recovery/' + 'pending-reply-'.repeat(30);
  const cases = [
    { height: 930, consoleOpen: false, receiving: false, reason: shortReason, workerError: '' },
    { height: 930, consoleOpen: true, receiving: false, reason: longReason, workerError: '' },
    {
      height: 420,
      consoleOpen: true,
      receiving: false,
      reason: unbrokenReason,
      workerError: 'The task is paused. Check its saved progress before repeating any action. '.repeat(3),
    },
    { height: 360, consoleOpen: true, receiving: true, reason: longReason, workerError: '' },
  ];

  function checkDeadline() {
    if (Date.now() >= deadline) {
      throw new Error('Task attention geometry checks exceeded their 20-second limit.');
    }
  }

  try {
    for (const width of [690, 360, 320, 290]) {
      for (const scenario of cases) {
        checkDeadline();
        await chrome.request(
          'Emulation.setDeviceMetricsOverride',
          { width, height: scenario.height, deviceScaleFactor: 1, mobile: false },
          session,
        );
        await evaluate(
          chrome,
          session,
          `window.mitterReleaseFixture.mountAttention(${JSON.stringify(scenario.reason)}, ${scenario.receiving}, ${scenario.consoleOpen}, ${JSON.stringify(scenario.workerError)})`,
        );
        const layout = assertAttentionLayout(
          await evaluate(
            chrome,
            session,
            `(() => {
              function required(selector) {
                const element = document.querySelector(selector);
                if (!(element instanceof HTMLElement)) {
                  throw new Error('Missing production attention element: ' + selector);
                }
                return element;
              }
              function rect(element) {
                const box = element.getBoundingClientRect();
                return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
              }
              function items(element) {
                return [...element.children].map(child => ({
                  text: child.textContent.trim(), tag: child.tagName, rect: rect(child),
                }));
              }
              const project = required('.project-view');
              const status = required('.task-state');
              const summary = required('.state-summary');
              const runner = required('.runner-controls');
              const recovery = required('.bridge-note');
              const editor = required('.editor-tabs');
              const console = document.querySelector('.debug-console');
              const error = document.querySelector('.error-banner');
              const range = document.createRange();
              range.selectNodeContents(summary);
              const summaryLines = [...range.getClientRects()].map(box => ({
                left: box.left, top: box.top, right: box.right, bottom: box.bottom,
              }));
              const regions = [status, runner, recovery, editor];
              let errorRect = null;
              let consoleRect = null;
              if (error) {
                errorRect = rect(error);
              }
              if (console) {
                consoleRect = rect(console);
              }
              return {
                viewport: { width: innerWidth, height: innerHeight },
                project: { rect: rect(project), clientWidth: project.clientWidth, scrollWidth: project.scrollWidth },
                status: rect(status), statusLabel: rect(required('.task-state .status')),
                summary: rect(summary), summaryLines, reason: summary.textContent,
                role: status.getAttribute('role'), live: status.getAttribute('aria-live'),
                runner: rect(runner), runnerItems: items(runner),
                recovery: rect(recovery), recoveryItems: items(recovery),
                error: errorRect, editor: rect(editor), console: consoleRect,
                domOrder: regions.every((element, index) => index === 0 ||
                  !!(regions[index - 1].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)),
              };
            })()`,
          ),
        );
        assert.deepEqual(layout.viewport, { width, height: scenario.height });
        assert.equal(
          layout.reason,
          scenario.reason,
          'The complete reason must remain readable, byte for byte.',
        );
        assert.equal(layout.console !== null, scenario.consoleOpen);
        let runnerLabels = ['Resend prompt…', 'Watching for reply', 'Stop', '3/15 turns', 'Open chat'];
        let recoveryLabels = ['Use reply…', 'Show details', 'Copy diagnostics'];
        let actions = ['resend', 'bridge.halt', 'bridge.openChat', 'use-reply', 'copy'];
        if (scenario.receiving) {
          runnerLabels = ['Receiving reply…', 'Stop', '3/15 turns', 'Open chat'];
          recoveryLabels = ['Show details', 'Copy diagnostics'];
          actions = ['bridge.halt', 'bridge.openChat', 'copy'];
        }
        assert.deepEqual(
          layout.runnerItems.map((item) => item.text),
          runnerLabels,
        );
        assert.deepEqual(
          layout.recoveryItems.map((item) => item.text),
          recoveryLabels,
        );
        assert.ok(layout.recoveryItems.every((item) => item.tag === 'BUTTON'));

        // Scroll and hit-test every real button; offscreen controls must remain
        // reachable above the Console rather than merely existing in the DOM.
        const controls = '.runner-controls button, .bridge-note button';
        const count =
          layout.runnerItems.filter((item) => item.tag === 'BUTTON').length + recoveryLabels.length;
        for (let index = 0; index < count; index++) {
          checkDeadline();
          const reachable = parseContract(
            waitConditionSchema,
            await evaluate(
              chrome,
              session,
              `(() => {
                const control = document.querySelectorAll(${JSON.stringify(controls)})[${index}];
                const project = document.querySelector('.project-view');
                if (!(control instanceof HTMLButtonElement) || !(project instanceof HTMLElement) || control.disabled) {
                  return false;
                }
                control.scrollIntoView({ block: 'center', inline: 'nearest' });
                control.focus({ preventScroll: true });
                const box = control.getBoundingClientRect();
                const pane = project.getBoundingClientRect();
                const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
                if (document.activeElement !== control || box.top < pane.top || box.bottom > pane.bottom ||
                    box.left < pane.left || box.right > pane.right || !hit || !control.contains(hit)) {
                  return false;
                }
                control.click();
                return true;
              })()`,
            ),
            'Invalid task recovery control reachability observation.',
          );
          assert.equal(
            reachable,
            true,
            width + '×' + scenario.height + ': each recovery button must be reachable.',
          );
        }
        assert.deepEqual(
          await evaluate(chrome, session, 'window.mitterReleaseFixture.attentionActions()'),
          actions,
        );
      }
    }
    checkDeadline();
    console.log(
      'PASS: full task attention text and recovery controls at 690/360/320/290px, short heights and open Console.',
    );
  } finally {
    try {
      await evaluate(chrome, session, 'window.mitterReleaseFixture.dispose()');
    } finally {
      await chrome.request('Emulation.clearDeviceMetricsOverride', {}, session);
    }
  }
}

async function collectedCounters(chrome, session) {
  let previous;

  for (let attempt = 0; attempt < 10; attempt++) {
    await delay(100);
    await chrome.request('HeapProfiler.collectGarbage', {}, session);
    const current = parseContract(
      domCountersSchema,
      await chrome.request('Memory.getDOMCounters', {}, session),
      'Chrome did not return valid collected DOM counters.',
    );

    if (
      previous &&
      current.documents === previous.documents &&
      current.nodes === previous.nodes &&
      current.jsEventListeners === previous.jsEventListeners
    ) {
      return current;
    }

    previous = current;
  }

  throw new Error('Chrome DOM counters did not settle after disposal; inspect the release log.');
}

export async function checkResources(chrome, session) {
  await evaluate(chrome, session, 'window.mitterReleaseFixture.mountPreview()');
  await waitFor(chrome, session, '!window.mitterReleaseFixture.inspect().preview.loading', 'preview load');
  let state = await inspect(chrome, session);
  assert.ok(state.preview.bytes > 0);
  assert.equal(state.preview.error, '');
  const url = state.preview.url;
  assert.ok(url.startsWith('blob:'));
  assert.equal(
    await evaluate(chrome, session, `fetch(${JSON.stringify(url)}).then(response => response.text())`),
    state.preview.source,
  );

  await evaluate(chrome, session, 'window.mitterReleaseFixture.dispose()');
  state = await inspect(chrome, session);
  assert.equal(state.preview.bytes, 0);
  assert.equal(state.preview.source, '');
  assert.equal(state.preview.url, '');
  assert.equal(
    await evaluate(chrome, session, `fetch(${JSON.stringify(url)}).then(() => false, () => true)`),
    true,
  );

  await evaluate(chrome, session, 'window.mitterReleaseFixture.mountPreview(true)');
  await evaluate(
    chrome,
    session,
    'window.mitterReleaseFixture.dispose(); window.mitterReleaseFixture.finishPreview()',
  );
  assert.equal((await inspect(chrome, session)).preview.bytes, 0);

  const fontsBefore = (await inspect(chrome, session)).fontCount;
  await evaluate(chrome, session, 'window.mitterReleaseFixture.mountFonts()');
  await waitFor(chrome, session, 'window.mitterReleaseFixture.inspect().fontReady', 'font preferences');
  await waitFor(
    chrome,
    session,
    `window.mitterReleaseFixture.inspect().fontCount > ${fontsBefore}`,
    'bundled FontFace load',
  );
  assert.deepEqual((await inspect(chrome, session)).fontErrors, []);
  await evaluate(chrome, session, 'window.mitterReleaseFixture.dispose()');
  assert.equal((await inspect(chrome, session)).fontCount, fontsBefore);

  // Warm the form/font paths before comparison; collection can reduce the baseline too.
  await evaluate(
    chrome,
    session,
    'window.mitterReleaseFixture.mountProject(); window.mitterReleaseFixture.dispose()',
  );
  const before = await collectedCounters(chrome, session);

  for (let iteration = 0; iteration < 30; iteration++) {
    await evaluate(
      chrome,
      session,
      `window.mitterReleaseFixture.mountProject();
       window.mitterReleaseFixture.dispose();
       window.mitterReleaseFixture.mountFonts();
       window.mitterReleaseFixture.dispose()`,
    );
  }

  const after = await collectedCounters(chrome, session);
  state = await inspect(chrome, session);
  assert.equal(state.dialogs, 0);
  assert.equal(state.fontCount, fontsBefore);
  assert.equal(state.savedFonts, 0);
  assert.equal(state.systemFonts, 0);
  assert.deepEqual(state.fontErrors, []);
  console.log('Collected DOM counters:', JSON.stringify({ before, after }));
  assert.ok(
    after.jsEventListeners <= before.jsEventListeners,
    'Repeated disposal must not grow retained listeners.',
  );
  assert.ok(after.nodes <= before.nodes, 'Repeated disposal must not grow retained DOM nodes.');
}
