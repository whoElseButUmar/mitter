import assert from 'node:assert/strict';
import { evaluate, waitFor, press } from './chrome-ui.mjs';

const fixture = 'window.mitterReleaseFixture.setup';

async function show(chrome, session, mode) {
  await evaluate(chrome, session, fixture + '.show(' + JSON.stringify(mode) + ')');
  await waitFor(chrome, session, 'document.querySelector(".setup-panel") !== null', 'setup panel');
}

async function activate(chrome, session, label) {
  const button = `[...document.querySelectorAll('.setup-panel button')].find(button => button.checkVisibility() && button.textContent.trim() === ${JSON.stringify(label)})`;
  await waitFor(chrome, session, 'Boolean(' + button + ')', label + ' available');
  await evaluate(chrome, session, button + '.focus()');
  await press(chrome, session, 'Enter', 13);
}

async function assertFits(chrome, session, mode, width) {
  assert.equal(
    await evaluate(
      chrome,
      session,
      `(() => {
        const panel = document.querySelector('.setup-panel');
        const box = panel.getBoundingClientRect();
        return panel.scrollWidth <= panel.clientWidth + 1 && box.left >= 0 && box.right <= innerWidth + 1 &&
          [...panel.querySelectorAll('button, summary')].filter(control => control.checkVisibility()).every(control => {
            const bounds = control.getBoundingClientRect(); return bounds.left >= box.left && bounds.right <= box.right + 1;
          });
      })()`,
    ),
    true,
    mode + ': setup and its controls fit at ' + width + 'px.',
  );
}

async function ready(chrome, session) {
  await waitFor(chrome, session, 'document.querySelector(".readiness-details") !== null', 'readiness report');
  assert.equal(
    await evaluate(
      chrome,
      session,
      `!document.querySelector('.readiness-details').open &&
        document.querySelector('.setup-account-note').textContent.includes('signed in to ChatGPT')`,
    ),
    true,
    'Readiness details start folded while the browser-account instruction stays visible.',
  );
}

async function checkConnecting(chrome, session) {
  await show(chrome, session, 'connecting');
  assert.deepEqual(
    await evaluate(
      chrome,
      session,
      `({visibleButtons: [...document.querySelectorAll('.connection-guide button')].filter(button => button.checkVisibility()).length,
        state: ${fixture}.inspect()})`,
    ),
    { visibleButtons: 0, state: { actions: [], readinessCalls: 0 } },
    'Initial Connecting waits without an unnecessary retry or readiness request.',
  );
  await evaluate(chrome, session, 'document.querySelector(".connection-guide > details > summary").focus()');
  await press(chrome, session, 'Enter', 13);
  await activate(chrome, session, 'Reconnect');
  assert.deepEqual(await evaluate(chrome, session, fixture + '.inspect()'), {
    actions: ['reconnect'],
    readinessCalls: 0,
  });
}

async function checkReconnect(chrome, session, mode) {
  await show(chrome, session, mode);
  let label = 'Reconnect';
  if (mode === 'missing') {
    label = 'Check connection';
    assert.equal(
      await evaluate(
        chrome,
        session,
        `(() => {
          const instruction = document.querySelector('.connection-guide [role=status]');
          const action = document.querySelector('.connection-guide button.primary');
          return instruction.checkVisibility() && instruction.textContent.includes('Install Miter.command') &&
            instruction.getBoundingClientRect().bottom <= action.getBoundingClientRect().top;
        })()`,
      ),
      true,
      'Missing-helper setup leads with its installer instruction before checking the connection.',
    );
  }
  await activate(chrome, session, label);
  assert.deepEqual(await evaluate(chrome, session, fixture + '.inspect()'), {
    actions: ['reconnect'],
    readinessCalls: 0,
  });
  await evaluate(chrome, session, fixture + '.transition("connecting")');
  assert.equal(
    await evaluate(
      chrome,
      session,
      `document.querySelector('.connection-guide h2').textContent === 'Connecting to Miter' &&
        ![...document.querySelectorAll('.connection-guide button')].some(button => button.checkVisibility())`,
    ),
    true,
    'An explicit connecting event shows a waiting state without a task mutation.',
  );
  await evaluate(chrome, session, fixture + '.transition("ready")');
  await ready(chrome, session);
  assert.deepEqual(await evaluate(chrome, session, fixture + '.inspect()'), {
    actions: ['reconnect'],
    readinessCalls: 1,
  });
  await evaluate(chrome, session, fixture + '.transition("disconnected")');
  assert.equal(
    await evaluate(chrome, session, 'document.querySelector(".readiness-details") === null'),
    true,
  );
  await activate(chrome, session, 'Reconnect');
  await evaluate(chrome, session, fixture + '.transition("ready")');
  await ready(chrome, session);
  assert.deepEqual(
    await evaluate(chrome, session, fixture + '.inspect()'),
    { actions: ['reconnect', 'reconnect'], readinessCalls: 2 },
    'Repeated helper recovery performs only connection actions and fresh readiness reads.',
  );
}

async function checkReadinessRetry(chrome, session, mode) {
  await show(chrome, session, mode);
  if (mode === 'unsupported') {
    await ready(chrome, session);
    assert.equal(
      await evaluate(
        chrome,
        session,
        `document.querySelector('.setup-attention[role=status]').checkVisibility() &&
          document.querySelector('.setup-attention[role=status]').textContent.includes('Automatic checks need setup')`,
      ),
      true,
      'Unavailable checks warn visibly without expanding technical requirements.',
    );
    await evaluate(chrome, session, fixture + '.respondWith("ready")');
    assert.equal(await evaluate(chrome, session, fixture + '.inspect().readinessCalls'), 1);
  } else {
    await waitFor(
      chrome,
      session,
      `document.querySelector('.setup-panel').textContent.includes('Could not check local requirements.')`,
      'readiness lookup failure',
    );
  }
  await activate(chrome, session, 'Check again');
  await ready(chrome, session);
  assert.deepEqual(await evaluate(chrome, session, fixture + '.inspect()'), {
    actions: [],
    readinessCalls: 2,
  });
  assert.equal(
    await evaluate(chrome, session, 'document.querySelector(".setup-attention[role=status]") === null'),
    true,
    'A fresh successful report clears the setup warning.',
  );
}

async function checkBuildMismatch(chrome, session, mode, width) {
  await show(chrome, session, mode);
  await assertFits(chrome, session, mode, width);
  const report = await evaluate(
    chrome,
    session,
    `(() => {
    const versions = document.querySelector('.build-versions');
    return { expanded:versions.open, rows: Array.from(versions.querySelectorAll('dt')).map(dt => [dt.textContent, dt.nextElementSibling.textContent]),
      recovery:document.querySelector('.connection-guide').innerText };
  })()`,
  );
  assert.equal(report.expanded, true);
  assert.equal(report.rows[0][0], 'Extension');
  const installed = report.rows[0][1];
  assert.match(installed, /build /);
  const mismatched = report.rows[1][1];
  if (mode === 'different-background-build') {
    assert.equal(report.rows[1][0], 'Background worker');
    assert.deepEqual(report.rows[2], ['Local helper', 'Not reported']);
  } else {
    assert.deepEqual(
      report.rows.map((row) => row[0]),
      ['Extension', 'Local helper'],
    );
  }
  assert.notEqual(mismatched, installed);
  assert.equal(mismatched.split(' ')[0], installed.split(' ')[0], 'Same version, different fingerprints');
  assert.match(report.recovery, /Load unpacked/);
  await activate(chrome, session, 'Reload extension');
  assert.deepEqual(await evaluate(chrome, session, fixture + '.inspect()'), {
    actions: ['reload'],
    readinessCalls: 0,
  });
  await evaluate(chrome, session, fixture + '.transition("ready")');
  await ready(chrome, session);
  const matching = await evaluate(
    chrome,
    session,
    `(() => {
    const versions = document.querySelector('.build-versions');
    return {expanded:versions.open, rows:Array.from(versions.querySelectorAll('dd')).map(dd=>dd.textContent)};
  })()`,
  );
  assert.deepEqual(matching, { expanded: false, rows: [installed, installed] });
  await evaluate(chrome, session, fixture + '.transition("disconnected")');
  assert.equal(
    await evaluate(chrome, session, "document.querySelector('.build-versions dd:last-child').textContent"),
    'Not reported',
    'A disconnected helper does not retain the previous build as current.',
  );
}

export async function checkSetup(chrome, session) {
  try {
    for (const width of [1024, 320, 290]) {
      await chrome.request(
        'Emulation.setDeviceMetricsOverride',
        { width, height: 640, deviceScaleFactor: 1, mobile: false },
        session,
      );
      for (const mode of [
        'ready',
        'missing',
        'unsupported',
        'version',
        'connecting',
        'disconnected',
        'background',
      ]) {
        await show(chrome, session, mode);
        if (mode === 'ready' || mode === 'unsupported') {
          await ready(chrome, session);
        }
        await assertFits(chrome, session, mode, width);
        assert.equal(
          await evaluate(
            chrome,
            session,
            '[...document.querySelectorAll(".setup-panel details")].every(details => !details.open)',
          ),
          true,
          'Setup diagnostics stay collapsed by default.',
        );
      }
      for (const mode of ['different-helper-build', 'different-background-build']) {
        await checkBuildMismatch(chrome, session, mode, width);
      }
      await checkConnecting(chrome, session);
      for (const mode of ['missing', 'disconnected', 'background']) {
        await checkReconnect(chrome, session, mode);
      }
      await checkReadinessRetry(chrome, session, 'unsupported');
      await checkReadinessRetry(chrome, session, 'readiness-error');
      await show(chrome, session, 'version');
      await activate(chrome, session, 'Reload extension');
      assert.deepEqual(await evaluate(chrome, session, fixture + '.inspect()'), {
        actions: ['reload'],
        readinessCalls: 0,
      });
      await show(chrome, session, 'ready');
      await ready(chrome, session);
      await evaluate(chrome, session, 'document.querySelector(".readiness-details > summary").focus()');
      await press(chrome, session, 'Enter', 13);
      assert.equal(
        await evaluate(chrome, session, 'document.querySelector(".readiness-details").open'),
        true,
      );
      await assertFits(chrome, session, 'expanded readiness', width);
      await activate(chrome, session, 'New project');
      assert.deepEqual(await evaluate(chrome, session, fixture + '.actions()'), ['create']);
    }
  } finally {
    await chrome.request('Emulation.clearDeviceMetricsOverride', {}, session);
    await evaluate(chrome, session, 'window.mitterReleaseFixture.dispose()');
  }
}
