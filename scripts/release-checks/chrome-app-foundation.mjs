import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseContract } from '../helpers/runtime.mjs';
import { evaluate, press, waitFor } from './chrome-ui.mjs';

const fixture = 'window.mitterReleaseFixture.appFoundation';
const cssValue = z.string().max(500).describe('One computed CSS property from the isolated fixture.');
const dimension = z
  .number()
  .finite()
  .nonnegative()
  .describe('A measured size or scroll offset in CSS pixels.');
const observationSchema = z
  .strictObject({
    id: z.string().min(1).describe('The fixture control whose computed styles were read.'),
    focused: z.boolean().describe('The control is the shadow root’s active element.'),
    focusVisible: z.boolean().describe('The browser currently matches :focus-visible on the control.'),
    outline: z
      .strictObject({ style: cssValue, width: cssValue, color: cssValue })
      .describe('The rendered focus outline.'),
    background: cssValue,
    color: cssValue,
    border: cssValue,
    opacity: cssValue,
    cursor: cssValue,
    boxShadow: cssValue,
    appearance: cssValue,
    left: cssValue,
    right: cssValue,
    paddingInlineEnd: cssValue,
    overflow: cssValue,
    scrollbarWidth: cssValue,
    scrollbarColor: cssValue,
    transition: cssValue,
    animation: cssValue,
    scrollBehavior: cssValue,
    width: dimension,
    clientWidth: dimension,
    scrollWidth: dimension,
    clientHeight: dimension,
    scrollHeight: dimension,
    scrollTop: dimension,
  })
  .describe('Actual computed styles and geometry, without synthesizing focus or scrolling behavior.');

const stateSchema = z
  .strictObject({
    mounted: z.boolean().describe('The isolated fixture is attached to the page.'),
    isolated: z.boolean().describe('The controls belong to the fixture’s own shadow root.'),
    exactCSS: z.boolean().describe('The style element contains the exact exported foundation CSS.'),
    title: z.string().max(100).describe('The native text input value.'),
    titleValue: z.string().max(100).describe('The same input value read through native FormData.'),
    category: z.string().max(100).describe('The native select value.'),
    categoryValue: z.string().max(100).describe('The same selected value read through native FormData.'),
    valid: z.boolean().describe('Native form constraint validation currently succeeds.'),
    pickerSupported: z.boolean().describe('This browser supports the customizable native select picker.'),
    pickerOpen: z.boolean().describe('The native select currently matches :open.'),
    forcedColors: z.boolean().describe('The browser reports the active forced-colors media feature.'),
    reducedMotion: z.boolean().describe('The browser reports the reduced-motion preference.'),
    viewportWidth: dimension,
  })
  .describe('Native browser state from the app foundation fixture.');

const pointSchema = z
  .strictObject({
    x: z.number().finite().describe('The control’s center X coordinate in viewport CSS pixels.'),
    y: z.number().finite().describe('The control’s center Y coordinate in viewport CSS pixels.'),
  })
  .describe('A real control position used for trusted Chrome pointer input.');

const scrollTableSchema = z
  .strictObject({
    exactCSS: z.boolean().describe('The document uses the exact bundled foundation CSS.'),
    mode: z.literal('CSS1Compat').describe('Standards mode exposes real document overflow.'),
    documentWidth: dimension,
    documentScrollWidth: dimension,
    documentOverflow: cssValue,
    bodyOverflow: cssValue,
    viewportWidth: dimension,
    viewportScrollWidth: dimension,
    scrollLeft: dimension,
    labelWidth: dimension,
    labelHeight: dimension,
    labelClipPath: cssValue,
  })
  .describe('Native geometry of a wide table and its visually hidden header at a narrow viewport.');

const remoteElementSchema = z
  .object({
    result: z.object({ objectId: z.string().min(1).describe('Chrome reference to the table header.') }),
  })
  .describe('A live DOM reference used only for the native accessibility-tree check.');

const accessibilityNodesSchema = z
  .object({
    nodes: z.array(
      z.object({
        ignored: z.boolean().describe('Whether Chrome excludes this node from accessibility.'),
        role: z.object({ value: z.string().describe('The computed accessibility role.') }),
        name: z.object({ value: z.string().describe('The computed accessible name.') }).optional(),
      }),
    ),
  })
  .describe('The browser accessibility nodes for the fixture table header.');

async function state(chrome, session) {
  return parseContract(
    stateSchema,
    await evaluate(chrome, session, fixture + '.state()'),
    'Invalid app foundation browser state.',
  );
}

async function inspect(chrome, session, id, pseudo = '') {
  return parseContract(
    observationSchema,
    await evaluate(chrome, session, `${fixture}.inspect(${JSON.stringify(id)}, ${JSON.stringify(pseudo)})`),
    'Invalid app foundation computed-style observation.',
  );
}

async function pointer(chrome, session, id, click = true) {
  const point = parseContract(
    pointSchema,
    await evaluate(chrome, session, `${fixture}.point(${JSON.stringify(id)})`),
    'Invalid app foundation control coordinates.',
  );
  await chrome.request('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, session);
  if (click) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await chrome.request(
        'Input.dispatchMouseEvent',
        { type, ...point, button: 'left', clickCount: 1 },
        session,
      );
    }
  }
  return point;
}

function assertFocus(observation) {
  assert.equal(observation.focused, true, observation.id + ': native focus');
  assert.equal(observation.focusVisible, true, observation.id + ': browser focus-visible match');
  assert.equal(observation.outline.style, 'solid');
  assert.equal(observation.outline.width, '2px');
  assert.equal(observation.boxShadow, 'none', 'The focus ring must not be doubled by a shadow.');
}

async function checkScrollTable(chrome, session) {
  await evaluate(chrome, session, fixture + '.mountScrollTable()');
  const read = async () =>
    parseContract(
      scrollTableSchema,
      await evaluate(chrome, session, fixture + '.scrollTableState()'),
      'Invalid scroll table fixture geometry.',
    );
  const initial = await read();
  assert.equal(initial.exactCSS, true);
  assert.ok(
    initial.documentWidth > 280 && initial.documentWidth <= 320,
    'Use the narrow viewport minus its scrollbar gutter.',
  );
  assert.ok(
    initial.documentScrollWidth <= initial.documentWidth + 1,
    'Hidden table headers must not expand the document.',
  );
  assert.ok(!['hidden', 'clip'].includes(initial.documentOverflow), 'Do not hide document overflow to pass.');
  assert.ok(!['hidden', 'clip'].includes(initial.bodyOverflow), 'Do not hide body overflow to pass.');
  assert.ok(
    initial.viewportScrollWidth > initial.viewportWidth,
    'The wide table must still scroll horizontally.',
  );
  assert.equal(initial.labelWidth, 1);
  assert.equal(initial.labelHeight, 1);
  assert.equal(initial.labelClipPath, 'inset(50%)');

  const header = parseContract(
    remoteElementSchema,
    await chrome.request(
      'Runtime.evaluate',
      {
        expression:
          'document.getElementById("app-foundation-fixture").contentDocument.getElementById("table-actions")',
        returnByValue: false,
      },
      session,
    ),
    'Chrome did not return the fixture table header.',
  );
  try {
    const accessibility = parseContract(
      accessibilityNodesSchema,
      await chrome.request(
        'Accessibility.getPartialAXTree',
        { objectId: header.result.objectId, fetchRelatives: false },
        session,
      ),
      'Chrome did not return the table header accessibility node.',
    );
    assert.ok(
      accessibility.nodes.some(
        (node) => !node.ignored && node.role.value === 'columnheader' && node.name?.value === 'Actions',
      ),
      'The visually hidden Actions header remains accessible.',
    );
  } finally {
    await chrome.request('Runtime.releaseObject', { objectId: header.result.objectId }, session);
  }

  const point = await pointer(chrome, session, 'table-scroll');
  await chrome.request(
    'Input.dispatchMouseEvent',
    { type: 'mouseWheel', ...point, deltaX: 240, deltaY: 0 },
    session,
  );
  await waitFor(chrome, session, fixture + '.scrollTableState().scrollLeft > 0', 'horizontal table scroll');
  const scrolled = await read();
  assert.ok(
    scrolled.documentScrollWidth <= scrolled.documentWidth + 1,
    'Scrolling the table must not widen the page.',
  );
}

export async function checkAppFoundation(chrome, session) {
  try {
    await chrome.request('Page.bringToFront', {}, session);
    await chrome.request(
      'Emulation.setEmulatedMedia',
      {
        features: [
          { name: 'prefers-reduced-motion', value: 'no-preference' },
          { name: 'forced-colors', value: 'none' },
        ],
      },
      session,
    );
    await chrome.request(
      'Emulation.setDeviceMetricsOverride',
      { width: 320, height: 900, deviceScaleFactor: 1, mobile: false },
      session,
    );
    await evaluate(chrome, session, fixture + '.mount()');
    const initial = await state(chrome, session);
    assert.equal(initial.mounted && initial.isolated && initial.exactCSS, true);
    assert.equal(initial.viewportWidth, 320);
    assert.equal(initial.valid, false, 'An empty required native input stays invalid.');

    const primary = await inspect(chrome, session, 'primary');
    const theme = await inspect(chrome, session, 'theme');
    assert.notEqual(primary.background, theme.background, 'The primary action uses its theme color.');
    await pointer(chrome, session, 'primary');
    const clicked = await inspect(chrome, session, 'primary');
    assert.equal(clicked.focused, true);
    assert.equal(clicked.focusVisible, false, 'A pointer-focused button does not need a focus ring.');
    assert.equal(clicked.outline.style, 'none');
    assert.equal(clicked.background, primary.background, 'Hover preserves the primary background.');
    assert.equal(clicked.color, primary.color, 'Hover preserves the primary foreground.');
    await pointer(chrome, session, 'previous');
    await press(chrome, session, 'Tab', 9);
    assertFocus(await inspect(chrome, session, 'primary'));

    await pointer(chrome, session, 'title');
    assertFocus(await inspect(chrome, session, 'title'));
    await chrome.request('Input.insertText', { text: 'Shiftboard' }, session);
    const edited = await state(chrome, session);
    assert.equal(edited.title, 'Shiftboard');
    assert.equal(edited.titleValue, edited.title, 'Native form submission preserves typed bytes.');
    assert.equal(edited.valid, true);

    const ltrChevron = await inspect(chrome, session, 'select-wrap', '::after');
    assert.equal(ltrChevron.right, '16px');
    assert.equal((await inspect(chrome, session, 'category')).paddingInlineEnd, '40px');
    await evaluate(chrome, session, fixture + '.direction("rtl")');
    assert.equal((await inspect(chrome, session, 'select-wrap', '::after')).left, '16px');
    await evaluate(chrome, session, fixture + '.direction("ltr")');

    if (initial.pickerSupported) {
      assert.equal((await inspect(chrome, session, 'category')).appearance, 'base-select');
      await pointer(chrome, session, 'category');
      await waitFor(chrome, session, fixture + '.state().pickerOpen', 'customizable select open');
      const picker = await inspect(chrome, session, 'category', '::picker(select)');
      const popup = await inspect(chrome, session, 'popup');
      assert.equal(picker.appearance, 'base-select');
      assert.equal(picker.background, popup.background);
      assert.equal(picker.color, popup.color);
      assert.equal(picker.border, popup.border);
      const optionBefore = await inspect(chrome, session, 'archive-option');
      assert.ok(
        optionBefore.width > 0 && optionBefore.clientHeight > 0,
        'The themed option is actually rendered.',
      );
      await pointer(chrome, session, 'archive-option');
      await waitFor(chrome, session, '!' + fixture + '.state().pickerOpen', 'native picker selection');
      const selected = await state(chrome, session);
      assert.equal(selected.category, 'archive');
      assert.equal(selected.categoryValue, selected.category);
      await pointer(chrome, session, 'category');
      await waitFor(chrome, session, fixture + '.state().pickerOpen', 'native picker reopened');
      await press(chrome, session, 'Escape', 27);
      await waitFor(chrome, session, '!' + fixture + '.state().pickerOpen', 'native picker Escape');
      assert.equal((await state(chrome, session)).category, 'archive');
    }

    await pointer(chrome, session, 'disabled');
    const disabled = await inspect(chrome, session, 'disabled');
    assert.equal(disabled.focused, false, 'A disabled native button cannot receive pointer focus.');
    assert.equal(disabled.opacity, '0.6');
    assert.equal(disabled.cursor, 'not-allowed');
    assert.equal(
      (await inspect(chrome, session, 'error')).border,
      (await inspect(chrome, session, 'error-text')).color,
      'Invalid controls and linked errors share the error token.',
    );

    const scroll = await inspect(chrome, session, 'scroll');
    assert.equal(scroll.overflow, 'auto');
    assert.equal(scroll.scrollbarWidth, 'thin');
    assert.notEqual(scroll.scrollbarColor, 'auto');
    assert.ok(scroll.scrollHeight > scroll.clientHeight);
    const wheelPoint = await pointer(chrome, session, 'scroll');
    await chrome.request(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: 80 },
      session,
    );
    await waitFor(chrome, session, fixture + '.inspect("scroll").scrollTop > 0', 'native wheel scroll');
    // Finish each native gesture before testing the next one. A positive offset
    // alone can be an intermediate compositor frame of the previous scroll.
    await waitFor(chrome, session, fixture + '.scrollCompletions() > 0', 'native wheel scroll completion');
    const beforeHome = await evaluate(chrome, session, fixture + '.scrollCompletions()');
    assert.equal(typeof beforeHome, 'number');
    assert.ok(Number.isSafeInteger(beforeHome));
    await press(chrome, session, 'Home', 36);
    await waitFor(chrome, session, fixture + '.inspect("scroll").scrollTop === 0', 'native Home scroll');
    await waitFor(
      chrome,
      session,
      fixture + '.scrollCompletions() > ' + beforeHome,
      'native Home scroll completion',
    );
    assertFocus(await inspect(chrome, session, 'scroll'));
    await press(chrome, session, 'PageDown', 34);
    try {
      await waitFor(chrome, session, fixture + '.inspect("scroll").scrollTop > 0', 'native keyboard scroll');
    } catch (error) {
      throw new Error(
        'Native keyboard scroll state: ' + JSON.stringify(await inspect(chrome, session, 'scroll')),
        { cause: error },
      );
    }

    for (const id of ['theme', 'form', 'title', 'category', 'popup', 'scroll']) {
      const layout = await inspect(chrome, session, id);
      assert.ok(layout.width <= 320, id + ': fit a 320px viewport');
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1, id + ': avoid horizontal clipping');
    }

    assert.notEqual((await inspect(chrome, session, 'motion')).animation, 'none');
    await chrome.request(
      'Emulation.setEmulatedMedia',
      {
        features: [
          { name: 'prefers-reduced-motion', value: 'reduce' },
          { name: 'forced-colors', value: 'active' },
        ],
      },
      session,
    );
    const preferences = await state(chrome, session);
    assert.equal(preferences.reducedMotion && preferences.forcedColors, true);
    const motion = await inspect(chrome, session, 'motion');
    assert.equal(motion.animation, 'none');
    assert.equal(motion.transition, '0s');
    assert.equal(motion.scrollBehavior, 'auto');
    await pointer(chrome, session, 'title');
    const forcedInput = await inspect(chrome, session, 'title');
    assertFocus(forcedInput);
    assert.notEqual(forcedInput.outline.color, forcedInput.background);
    assert.equal((await inspect(chrome, session, 'disabled')).opacity, '1');
    await checkScrollTable(chrome, session);
    return { pickerSupported: initial.pickerSupported, viewportWidth: initial.viewportWidth };
  } finally {
    try {
      await evaluate(chrome, session, fixture + '.dispose(); ' + fixture + '.dispose()');
      assert.equal(
        await evaluate(chrome, session, 'document.getElementById("app-foundation-fixture") === null'),
        true,
      );
    } finally {
      try {
        await chrome.request('Emulation.setEmulatedMedia', { features: [] }, session);
      } finally {
        await chrome.request('Emulation.clearDeviceMetricsOverride', {}, session);
      }
    }
  }
}
