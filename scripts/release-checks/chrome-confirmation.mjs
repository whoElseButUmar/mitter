import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseContract } from '../helpers/runtime.mjs';
import { click, evaluate, press, waitFor } from './chrome-ui.mjs';

const fixture = 'window.mitterReleaseFixture.confirmation';
const observationSchema = z
  .strictObject({
    count: z.number().int().nonnegative().describe('Connected confirmation dialogs.'),
    modal: z.boolean().describe('The native dialog is in the modal top layer.'),
    title: z.string().describe('The visible dialog heading.'),
    message: z.string().describe('The exact displayed warning.'),
    focused: z.string().describe('The currently focused control text.'),
    openerFocused: z.boolean().describe('Native dialog closing restored the fixture opener.'),
    pending: z.boolean().describe('The confirmation promise is unsettled.'),
    result: z.boolean().nullable().describe('The approval result, absent until settlement.'),
    failure: z.string().describe('An opening failure, if one occurred.'),
    fitsViewport: z.boolean().describe('The complete dialog fits within the viewport.'),
    footerVisible: z.boolean().describe('The dialog actions remain inside the viewport.'),
    bodyScrolls: z.boolean().describe('The warning body is a native scrolling region.'),
    labelled: z.boolean().describe('The native dialog references its visible heading.'),
    described: z.boolean().describe('The native dialog references its exact warning text.'),
  })
  .describe('Actual native confirmation state and computed geometry.');

async function inspect(chrome, session) {
  return parseContract(
    observationSchema,
    await evaluate(chrome, session, fixture + '.inspect()'),
    'confirmation observation',
  );
}

async function settled(chrome, session) {
  await waitFor(chrome, session, fixture + '.inspect().pending === false', 'confirmation settlement');
  return inspect(chrome, session);
}

export async function checkConfirmation(chrome, session) {
  try {
    await evaluate(chrome, session, fixture + '.open()');
    const initial = await inspect(chrome, session);
    assert.equal(initial.count, 1);
    assert.equal(initial.modal && initial.labelled && initial.described, true);
    assert.equal(initial.focused, 'Cancel', 'Opening the modal focuses its safe Cancel action.');
    assert.equal(
      initial.message,
      'Paste multiple lines or control characters into the real shell? This may execute commands.',
    );
    assert.equal(await evaluate(chrome, session, fixture + '.duplicate()'), false);
    assert.equal((await inspect(chrome, session)).count, 1);
    await press(chrome, session, 'Tab', 9);
    assert.equal(
      (await inspect(chrome, session)).focused,
      'Paste into shell',
      'The first Tab moves to the confirmation button.',
    );
    await press(chrome, session, 'Tab', 9);
    const boundary = parseContract(
      z
        .strictObject({
          tag: z.string().describe('The document active element tag after passing the last dialog button.'),
          documentFocused: z.boolean().describe('The browser reports focus on this document.'),
          inDialog: z.boolean().describe('The active element is inside the modal dialog.'),
        })
        .describe('The native browser focus boundary, without adding a JavaScript focus trap.'),
      await evaluate(
        chrome,
        session,
        `({
        tag: document.activeElement?.tagName ?? '',
        documentFocused: document.hasFocus(),
        inDialog: document.querySelector('[data-miter-confirmation]')?.contains(document.activeElement) ?? false,
      })`,
      ),
      'confirmation focus boundary',
    );
    console.log('Confirmation keyboard boundary:', JSON.stringify(boundary));
    assert.equal(
      boundary.inDialog || boundary.tag === 'BODY',
      true,
      'Native Tab may pass through the document focus boundary, but never another page control.',
    );
    if (!boundary.inDialog) {
      await evaluate(chrome, session, `document.querySelector('[data-confirmation-opener]').focus()`);
      assert.equal(
        (await inspect(chrome, session)).openerFocused,
        false,
        'The inert opener cannot acquire focus while the modal is open.',
      );
      await press(chrome, session, 'Tab', 9);
    }
    assert.equal(
      (await inspect(chrome, session)).focused,
      'Cancel',
      'The next page focus returns to Cancel.',
    );
    await press(chrome, session, 'Escape', 27);
    const escaped = await settled(chrome, session);
    assert.equal(escaped.result, false);
    assert.equal(escaped.count, 0);
    assert.equal(escaped.openerFocused, true);

    await evaluate(chrome, session, fixture + '.open()');
    await press(chrome, session, 'Enter', 13);
    assert.equal((await settled(chrome, session)).result, false, 'Enter defaults to the safe Cancel action.');

    await evaluate(chrome, session, fixture + '.open()');
    await click(chrome, session, '[data-miter-confirmation] button.primary');
    assert.equal((await settled(chrome, session)).result, true);

    await evaluate(chrome, session, fixture + '.open(); ' + fixture + '.invalidate()');
    await click(chrome, session, '[data-miter-confirmation] button.primary');
    assert.equal(
      (await settled(chrome, session)).result,
      false,
      'Changed ownership cannot approve an action.',
    );

    await evaluate(chrome, session, fixture + '.open(); ' + fixture + '.abort()');
    const aborted = await settled(chrome, session);
    assert.equal(aborted.result, false);
    assert.equal(aborted.count, 0);

    await evaluate(chrome, session, fixture + '.failOpen()');
    const failed = await settled(chrome, session);
    assert.equal(failed.result, null, 'Opening failure rejects instead of resolving false first.');
    assert.match(failed.failure, /No action was approved/);
    assert.equal(failed.count, 0);

    await chrome.request(
      'Emulation.setDeviceMetricsOverride',
      { width: 320, height: 500, deviceScaleFactor: 1, mobile: false },
      session,
    );
    await evaluate(chrome, session, fixture + '.open(true)');
    const narrow = await inspect(chrome, session);
    assert.equal(
      narrow.fitsViewport && narrow.footerVisible && narrow.bodyScrolls,
      true,
      'Long warnings scroll inside a 320px dialog with visible actions.',
    );
    await evaluate(chrome, session, fixture + '.dispose(); ' + fixture + '.dispose()');
    const disposed = await settled(chrome, session);
    assert.equal(disposed.result, false);
    assert.equal(disposed.count, 0);
  } finally {
    await evaluate(chrome, session, fixture + '.dispose()');
    await chrome.request('Emulation.clearDeviceMetricsOverride', {}, session);
  }
}
