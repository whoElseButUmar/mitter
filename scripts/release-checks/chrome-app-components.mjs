import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { page, evaluate, press, waitFor } from './chrome-ui.mjs';

const fixtureHTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="./foundation.css"><style>
body { margin:0; padding:16px; min-block-size:120vh; } .demo { display:grid; gap:12px; max-width:440px; }
.filler { height:900px; } .ui-dialog-body { padding:24px; }
#plain-scroll { overflow:auto; block-size:80px; }
.date-columns { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; max-inline-size:344px; }
.date-columns > div { min-inline-size:0; }
</style></head><body class="ui"><main class="demo">
<label for="date">Date</label><input id="date" class="ui-control" value="2026-11-10" required>
<section class="date-columns" aria-label="Date range filters">
<div><label for="date-from">From</label><input id="date-from" class="ui-control" value="2026-11-10"></div>
<div><label for="date-through">Through</label><input id="date-through" class="ui-control" value="2026-11-30"></div>
</section>
<label for="time">Time</label><input id="time" class="ui-control" value="09:00" required>
<div id="opener"><button class="ui-button" id="edit" type="button">Edit reservation</button></div>
<button id="remove" class="ui-button" type="button">Remove reservation</button><output id="result"></output>
<label for="notes">Notes</label><textarea id="notes" class="ui-control" rows="2">First line
Second line
Third line
Fourth line</textarea>
<section id="plain-scroll" tabindex="0" aria-label="History"><p>First entry</p><p>Second entry</p><p>Third entry</p><p>Last entry</p></section>
<dialog id="editor" class="ui-dialog" aria-labelledby="heading">
<header class="ui-dialog-header"><h2 id="heading">Reservation</h2></header>
<section class="ui-dialog-body ui-scroll" tabindex="0" aria-label="Details"><p>Scrollable details</p><div class="filler"></div><p>Last detail</p></section>
<footer class="ui-dialog-footer"><button id="save" class="ui-button" type="button">Save reservation</button></footer>
</dialog><div class="filler" aria-hidden="true"></div></main><script type="module">
import { createDatePicker, createTimeInput, createDialog, confirmAction } from './components.mjs';
const date = createDatePicker(document.querySelector('#date'), { min:'2026-11-01',max:'2026-12-31' });
const rangeDates = ['date-from','date-through'].map((id) => createDatePicker(document.getElementById(id)));
const time = createTimeInput(document.querySelector('#time'));
const editor = document.querySelector('#editor');
const modal = createDialog(editor, { returnFocus:() => document.querySelector('#edit') });
function bind() { document.querySelector('#edit').addEventListener('click', (event) => modal.open(event.currentTarget)); }
bind();
document.querySelector('#save').addEventListener('click', () => {
  modal.close(); document.querySelector('#opener').innerHTML='<button class="ui-button" id="edit" type="button">Edit reservation</button>'; bind();
});
document.querySelector('#remove').addEventListener('click', async (event) => {
  document.querySelector('#result').textContent=String(await confirmAction({root:document.body.closest('.ui'),title:'Remove reservation?',message:'This frees the room.',trigger:event.currentTarget}));
});
window.componentFixture = { ready:true, dispose() { date.dispose();rangeDates.forEach((picker) => picker.dispose());time.dispose();modal.dispose(); } };
</script></body></html>`;

async function clickSelector(chrome, session, selector) {
  const serialized = JSON.stringify(selector);
  const point = await evaluate(
    chrome,
    session,
    `(() => {
    const target = document.querySelector(${serialized}); target.scrollIntoView({block:'nearest'});
    const box = target.getBoundingClientRect(); return {x:box.left+box.width/2,y:box.top+Math.min(box.height/2,12)};
  })()`,
  );
  assert.ok(point && typeof point.x === 'number' && typeof point.y === 'number');
  for (const type of ['mousePressed', 'mouseReleased']) {
    await chrome.request(
      'Input.dispatchMouseEvent',
      { type, ...point, button: 'left', clickCount: 1 },
      session,
    );
  }
}

async function fillInput(chrome, session, selector, value) {
  await clickSelector(chrome, session, selector);
  let modifiers = 2;
  if (process.platform === 'darwin') {
    modifiers = 4;
  }
  for (const type of ['keyDown', 'keyUp']) {
    await chrome.request(
      'Input.dispatchKeyEvent',
      {
        type,
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers,
        commands: ['selectAll'],
      },
      session,
    );
  }
  await chrome.request('Input.insertText', { text: value }, session);
}

async function inspectScrollbars(chrome, session) {
  return evaluate(
    chrome,
    session,
    `['html','body','#plain-scroll','#notes'].map((selector) => {
      const node = document.querySelector(selector);
      const style = getComputedStyle(node);
      return { selector, width:style.scrollbarWidth, color:style.scrollbarColor,
        gutter:style.scrollbarGutter, overflow:style.overflowY,
        scrollHeight:node.scrollHeight, clientHeight:node.clientHeight };
    })`,
  );
}

export async function writeAppComponentsFixture(directory) {
  const { APP_FOUNDATION_CSS } = await import('../../dist/packages/protocol/src/task-skills/app-design.js');
  const { APP_COMPONENTS_JS } =
    await import('../../dist/packages/protocol/src/task-skills/app-components.js');
  const fixtureDirectory = path.join(directory, 'extension', 'quality-fixture');
  const script = fixtureHTML.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(script?.[1]);
  await mkdir(fixtureDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(fixtureDirectory, 'index.html'),
      fixtureHTML.replace(script[0], '<script type="module" src="./fixture.mjs"></script>'),
    ),
    writeFile(path.join(fixtureDirectory, 'fixture.mjs'), script[1]),
    writeFile(path.join(fixtureDirectory, 'foundation.css'), APP_FOUNDATION_CSS),
    writeFile(path.join(fixtureDirectory, 'components.mjs'), APP_COMPONENTS_JS),
  ]);
  return fixtureDirectory;
}

async function checkDateFieldLayouts(chrome, session) {
  for (const width of [390, 1024]) {
    await chrome.request(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 720, deviceScaleFactor: 1, mobile: false },
      session,
    );
    for (const direction of ['ltr', 'rtl']) {
      await evaluate(chrome, session, `document.documentElement.dir = ${JSON.stringify(direction)}`);
      const layouts = await evaluate(
        chrome,
        session,
        `['date','date-from','date-through'].map((id) => {
          const input = document.getElementById(id);
          const trigger = input.nextElementSibling;
          const field = input.parentElement;
          const style = getComputedStyle(input);
          const text = document.createElement('span');
          text.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
          text.style.font = style.font;
          text.style.fontVariantNumeric = style.fontVariantNumeric;
          text.style.letterSpacing = style.letterSpacing;
          text.textContent = input.value;
          document.body.append(text);
          const textWidth = text.getBoundingClientRect().width;
          text.remove();
          const rectangle = (node) => {
            const box = node.getBoundingClientRect();
            return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width};
          };
          return {
            id, input:rectangle(input), trigger:rectangle(trigger), field:rectangle(field), textWidth,
            usableWidth:input.clientWidth - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd),
          };
        })`,
      );

      for (const layout of layouts) {
        const label = layout.id + ' at ' + width + 'px ' + direction;
        assert.ok(layout.usableWidth >= layout.textWidth, label + ': the entire date must fit.');
        for (const control of [layout.input, layout.trigger]) {
          assert.ok(control.left >= layout.field.left - 1, label + ': control stays inside inline start.');
          assert.ok(control.right <= layout.field.right + 1, label + ': control stays inside inline end.');
        }

        if (layout.id === 'date') {
          assert.ok(Math.abs(layout.input.top - layout.trigger.top) < 1, label + ': wide pair stays inline.');
          if (direction === 'rtl') {
            assert.ok(layout.trigger.right <= layout.input.left, label + ': trigger follows input in RTL.');
          } else {
            assert.ok(layout.trigger.left >= layout.input.right, label + ': trigger follows input in LTR.');
          }
        } else {
          assert.ok(layout.field.width >= 160 && layout.field.width <= 180, label + ': narrow nested field.');
          assert.ok(layout.trigger.top >= layout.input.bottom, label + ': narrow pair wraps below input.');
        }
      }

      assert.equal(
        await evaluate(chrome, session, 'document.documentElement.scrollWidth <= innerWidth'),
        true,
        'Date fields must not widen the page at ' + width + 'px ' + direction,
      );
      await clickSelector(chrome, session, '#date-from');
      await press(chrome, session, 'Tab', 9);
      assert.equal(
        await evaluate(chrome, session, "document.activeElement.matches('#date-from + button')"),
        true,
        'Wrapping preserves input-to-trigger keyboard order.',
      );
      await clickSelector(chrome, session, '#date-from + button');
      await waitFor(
        chrome,
        session,
        "document.getElementById(document.querySelector('#date-from + button').getAttribute('aria-controls')).open",
        'wrapped date trigger opens calendar',
      );
      await press(chrome, session, 'Escape', 27);
      await waitFor(
        chrome,
        session,
        "!document.querySelector('dialog[open]') && document.activeElement.matches('#date-from + button')",
        'wrapped date calendar returns focus',
      );
    }
  }
  await evaluate(chrome, session, "document.documentElement.dir = 'ltr'");
}

export async function checkAppComponents(chrome, directory, extensionId) {
  const fixtureDirectory = await writeAppComponentsFixture(directory);
  let target;
  try {
    target = await page(chrome, `chrome-extension://${extensionId}/quality-fixture/index.html`);
    const session = target.session;
    await chrome.request('Page.bringToFront', {}, session);
    await waitFor(chrome, session, 'window.componentFixture?.ready === true', 'working components mounted');
    const scrollbars = await inspectScrollbars(chrome, session);

    for (const scrollbar of scrollbars) {
      assert.equal(scrollbar.width, 'thin', scrollbar.selector + ': automatic thin scrollbar');
      assert.notEqual(scrollbar.color, 'auto', scrollbar.selector + ': automatic theme colors');
    }

    assert.equal(scrollbars[0].gutter, 'stable');
    assert.ok(scrollbars[0].scrollHeight > scrollbars[0].clientHeight, 'The document actually scrolls.');
    assert.equal(scrollbars[2].overflow, 'auto');
    assert.ok(scrollbars[2].scrollHeight > scrollbars[2].clientHeight, 'Unclassed region actually scrolls.');
    assert.ok(scrollbars[3].scrollHeight > scrollbars[3].clientHeight, 'Textarea actually scrolls.');
    await evaluate(
      chrome,
      session,
      `document.documentElement.classList.add('ui');
       document.body.classList.remove('ui');
       document.documentElement.style.setProperty('--ui-scroll-thumb','#334155');
       document.documentElement.style.setProperty('--ui-scroll-track','#f8fafc');`,
    );

    for (const scrollbar of await inspectScrollbars(chrome, session)) {
      assert.equal(scrollbar.color, 'rgb(51, 65, 85) rgb(248, 250, 252)', scrollbar.selector);
    }

    assert.deepEqual(
      await evaluate(
        chrome,
        session,
        "[document.querySelector('#date').type,document.querySelector('#time').type]",
      ),
      ['text', 'text'],
    );
    assert.deepEqual(
      await evaluate(
        chrome,
        session,
        "[document.querySelector('#date').inputMode,document.querySelector('#time').inputMode]",
      ),
      ['text', 'text'],
      'Manual date and time entry need keyboards with hyphens and colons.',
    );
    await clickSelector(chrome, session, '.ui-date-field button');
    await waitFor(chrome, session, "document.querySelector('.ui-date-dialog').open", 'calendar opened');
    assert.equal(await evaluate(chrome, session, 'document.activeElement.dataset.date'), '2026-11-10');
    await press(chrome, session, 'ArrowRight', 39);
    await press(chrome, session, 'Enter', 13);
    // Chrome queues the close event after it clears dialog.open. Finish this
    // selection before installing a one-time close handler for the next visit.
    await waitFor(
      chrome,
      session,
      `!document.querySelector('.ui-date-dialog').open &&
       document.querySelector('.ui-date-field button').getAttribute('aria-expanded') === 'false'`,
      'calendar selection closed and announced on the trigger',
    );
    assert.equal(await evaluate(chrome, session, "document.querySelector('#date').value"), '2026-11-11');
    assert.equal(
      await evaluate(chrome, session, "document.activeElement.matches('.ui-date-field button')"),
      true,
    );

    await clickSelector(chrome, session, '.ui-date-field button');
    await evaluate(
      chrome,
      session,
      `document.querySelector('.ui-date-dialog').addEventListener('close', () => {
        document.getElementById('time').focus();
        setTimeout(() => { window.componentFixture.focusAfterClose = document.activeElement.id; }, 0);
      }, {once:true})`,
    );
    await press(chrome, session, 'Escape', 27);
    await waitFor(chrome, session, "!document.querySelector('.ui-date-dialog').open", 'calendar Escape');
    await waitFor(
      chrome,
      session,
      'typeof window.componentFixture.focusAfterClose === "string"',
      'calendar close handlers',
    );
    assert.equal(
      await evaluate(chrome, session, 'window.componentFixture.focusAfterClose'),
      'time',
      'Closing the calendar preserves focus when the app moves to the time field.',
    );
    assert.equal(await evaluate(chrome, session, "document.querySelector('#date').value"), '2026-11-11');

    for (const [selector, invalid, valid] of [
      ['#date', '2026-02-30', '2026-11-12'],
      ['#time', '24:00', '09:30'],
    ]) {
      await fillInput(chrome, session, selector, invalid);
      assert.equal(
        await evaluate(chrome, session, `document.querySelector(${JSON.stringify(selector)}).validity.valid`),
        false,
      );
      await fillInput(chrome, session, selector, valid);
      assert.equal(
        await evaluate(chrome, session, `document.querySelector(${JSON.stringify(selector)}).validity.valid`),
        true,
      );
    }

    await checkDateFieldLayouts(chrome, session);

    for (const width of [1024, 320]) {
      await chrome.request(
        'Emulation.setDeviceMetricsOverride',
        { width, height: 480, deviceScaleFactor: 1, mobile: false },
        session,
      );
      await clickSelector(chrome, session, '#edit');
      await waitFor(chrome, session, "document.querySelector('#editor').open", 'scrolling dialog');
      const layout = () =>
        evaluate(
          chrome,
          session,
          `(() => {
        const shell=document.querySelector('#editor'),body=shell.querySelector('.ui-dialog-body');
        const header=shell.querySelector('header').getBoundingClientRect(),footer=shell.querySelector('footer').getBoundingClientRect();
        return {top:header.top,bottom:footer.bottom,shellOverflow:getComputedStyle(shell).overflowY,
          bodyOverflow:getComputedStyle(body).overflowY,scrollbar:getComputedStyle(body).scrollbarWidth,
          scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,width:shell.getBoundingClientRect().width,
          scrollTop:body.scrollTop,focused:document.activeElement?.outerHTML.slice(0,200),pageFocused:document.hasFocus()};
      })()`,
        );
      const before = await layout();
      assert.equal(before.shellOverflow, 'hidden');
      assert.equal(before.bodyOverflow, 'auto');
      assert.equal(before.scrollbar, 'thin');
      assert.ok(before.scrollHeight > before.clientHeight);
      assert.ok(before.top >= 0 && before.bottom <= 480 && before.width <= width);
      await clickSelector(chrome, session, '#editor .ui-dialog-body');
      await press(chrome, session, 'PageDown', 34);
      try {
        await waitFor(
          chrome,
          session,
          "document.querySelector('#editor .ui-dialog-body').scrollTop > 0",
          'modal keyboard scroll',
        );
      } catch (error) {
        throw new Error('Modal keyboard scroll state: ' + JSON.stringify(await layout()), { cause: error });
      }
      const after = await layout();
      assert.equal(after.top, before.top);
      assert.equal(after.bottom, before.bottom);
      await clickSelector(chrome, session, '#save');
      await waitFor(
        chrome,
        session,
        "document.activeElement.id === 'edit' && !document.querySelector('#editor').open",
        'rerendered opener focus',
      );
    }
    await clickSelector(chrome, session, '#remove');
    await waitFor(
      chrome,
      session,
      "document.querySelector('dialog[open]')?.textContent.includes('Remove reservation?')",
      'custom confirmation',
    );
    assert.equal(await evaluate(chrome, session, 'document.activeElement.textContent'), 'Cancel');
    await press(chrome, session, 'Escape', 27);
    await waitFor(
      chrome,
      session,
      "document.querySelector('#result').textContent === 'false'",
      'confirmation cancelled',
    );
    assert.equal(await evaluate(chrome, session, 'document.activeElement.id'), 'remove');
    await evaluate(chrome, session, 'window.componentFixture.dispose();window.componentFixture.dispose()');
    assert.equal(await evaluate(chrome, session, "document.querySelector('.ui-date-dialog') === null"), true);
    await chrome.request(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'forced-colors', value: 'active' }] },
      session,
    );

    for (const scrollbar of await inspectScrollbars(chrome, session)) {
      assert.equal(scrollbar.width, 'auto', scrollbar.selector + ': forced colors preserve usable width');
      assert.equal(scrollbar.color, 'auto', scrollbar.selector + ': forced colors use system colors');
    }

    await chrome.request('Emulation.setEmulatedMedia', { features: [] }, session);
    await chrome.request('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }, session);
    assert.equal(await evaluate(chrome, session, "matchMedia('(pointer:coarse)').matches"), true);

    for (const scrollbar of await inspectScrollbars(chrome, session)) {
      assert.equal(scrollbar.width, 'auto', scrollbar.selector + ': coarse pointers preserve usable width');
    }

    return {
      calendar: true,
      keyboard: true,
      documentScroll: true,
      automaticScrollbars: true,
      modalScroll: true,
      focusReturn: true,
      dateFieldLayouts: { widths: [390, 1024], directions: ['ltr', 'rtl'] },
      widths: [1024, 320],
    };
  } finally {
    try {
      if (target) {
        await chrome.request('Target.closeTarget', { targetId: target.targetId });
      }
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  }
}
