import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { domFixture } from './dom-fixture.mjs';
import { enhanceSelect } from '../src/select.js';
import { mountMenu } from '../src/menu.js';
import { createPopover } from '../src/popover.js';
import { mountTabRow } from '../src/tab-row.js';
import { mountLibrary } from '../src/library.js';
import { emptyWorkspace, reconcileWorkspace } from '../src/workspace.js';
import { mountDraftRewrite } from '../src/draft-rewrite.js';
import { mountFollowupComposer } from '../src/followup-composer.js';

function addOption(document, parent, value, text) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  parent.append(option);
  return option;
}

function highlightedValue(document, control) {
  const id = control.trigger.getAttribute('aria-activedescendant');
  const row = document.body.querySelectorAll('[role=option]').find((option) => option.id === id);
  assert.ok(row, 'The open combobox must identify its highlighted option');
  return row.dataset.value;
}

test('select navigation opens at selection, skips unavailable options, and commits once', async () => {
  const { root, document } = domFixture();
  const select = document.createElement('select');
  addOption(document, select, 'a', 'Alpha');
  addOption(document, select, 'disabled', 'Disabled').disabled = true;
  addOption(document, select, 'hidden', 'Hidden').hidden = true;
  const group = document.createElement('optgroup');
  group.disabled = true;
  addOption(document, group, 'grouped', 'Grouped');
  select.append(group);
  addOption(document, select, 'z', 'Zulu');
  root.append(select);
  const control = enhanceSelect(select);
  const events = [];
  select.addEventListener('input', () => events.push('input'));
  select.addEventListener('change', () => events.push('change'));

  await control.trigger.emit('keydown', { key: 'ArrowUp' });
  assert.equal(highlightedValue(document, control), 'a');
  await control.trigger.emit('keydown', { key: 'ArrowUp' });
  assert.equal(highlightedValue(document, control), 'z');
  await control.trigger.emit('keydown', { key: 'ArrowDown' });
  assert.equal(highlightedValue(document, control), 'a');
  await control.trigger.emit('keydown', { key: 'End' });
  assert.equal(highlightedValue(document, control), 'z');
  await control.trigger.emit('keydown', { key: 'Home' });
  assert.equal(highlightedValue(document, control), 'a');
  await control.trigger.emit('keydown', { key: 'End' });
  const tab = await control.trigger.emit('keydown', { key: 'Tab' });
  assert.equal(tab.prevented, undefined);
  assert.equal(select.value, 'z');
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(control.popup.isOpen(), false);
  assert.equal(control.trigger.getAttribute('aria-activedescendant'), null);

  await control.trigger.emit('keydown', { key: 'ArrowDown' });
  assert.equal(highlightedValue(document, control), 'z');
  await control.trigger.emit('keydown', { key: 'Enter' });
  assert.deepEqual(events, ['input', 'change']);
  control.dispose();
});

test('select typeahead cycles, extends prefixes, resets, and searches spaces', async (context) => {
  let now = 1000;
  context.mock.method(Date, 'now', () => now);
  const { root, document } = domFixture();
  const select = document.createElement('select');
  for (const [value, text] of [
    ['z', 'Zulu'],
    ['a', 'Alpha'],
    ['al', 'Alpine'],
    ['ny', 'New York'],
    ['new', 'Newark'],
  ]) {
    addOption(document, select, value, text);
  }
  addOption(document, select, 'hidden', 'Alphabet').hidden = true;
  root.append(select);
  const control = enhanceSelect(select);
  control.popup.open();

  await control.trigger.emit('keydown', { key: 'a' });
  assert.equal(highlightedValue(document, control), 'a');
  await control.trigger.emit('keydown', { key: 'a' });
  assert.equal(highlightedValue(document, control), 'al');
  now += 700;
  for (const key of ['a', 'l', 'p']) {
    await control.trigger.emit('keydown', { key });
    assert.equal(highlightedValue(document, control), 'a');
  }
  now += 700;
  for (const key of ['n', 'e', 'w', ' ', 'y']) {
    await control.trigger.emit('keydown', { key });
    assert.equal(highlightedValue(document, control), 'ny');
    assert.equal(control.popup.isOpen(), true);
  }
  await control.trigger.emit('keydown', { key: 'Enter' });
  assert.equal(select.value, 'ny');
  now += 700;
  await control.trigger.emit('keydown', { key: 'a' });
  assert.equal(select.value, 'a');
  await control.trigger.emit('keydown', { key: 'a' });
  assert.equal(select.value, 'al');
  control.popup.open();
  await control.trigger.emit('keydown', { key: ' ' });
  assert.equal(control.popup.isOpen(), false, 'Opening must reset typeahead before Space commits');
  assert.equal(select.value, 'al');
  control.dispose();
});

test('menu typeahead retains next-item origin, buffered spaces, and Tab focus', async (context) => {
  let now = 1000;
  context.mock.method(Date, 'now', () => now);
  const { root, document } = domFixture();
  const menu = mountMenu(root, 'Actions', [
    { id: 'a', label: 'Alpha', run() {} },
    { id: 'disabled', label: 'Albatross', disabled: true, run() {} },
    { id: 'al', label: 'Alpine', run() {} },
    { id: 'ny', label: 'New York', run() {} },
    { id: 'new', label: 'Newark', run() {} },
  ]);
  menu.popup.open();
  const panel = document.body.querySelector('.menu-popup');
  await panel.emit('keydown', { key: 'a' });
  assert.equal(document.activeElement.textContent, 'Alpine');
  await panel.emit('keydown', { key: 'a' });
  assert.equal(document.activeElement.textContent, 'Alpha');
  now += 700;
  await panel.emit('keydown', { key: 'a' });
  assert.equal(document.activeElement.textContent, 'Alpine');
  await panel.emit('keydown', { key: 'l' });
  assert.equal(document.activeElement.textContent, 'Alpha');
  now += 700;
  await panel.emit('keydown', { key: 'n' });
  assert.equal(document.activeElement.textContent, 'New York');
  await panel.emit('keydown', { key: 'e' });
  assert.equal(document.activeElement.textContent, 'Newark');
  await panel.emit('keydown', { key: 'w' });
  assert.equal(document.activeElement.textContent, 'New York');
  await panel.emit('keydown', { key: ' ' });
  await panel.emit('keydown', { key: 'y' });
  assert.equal(document.activeElement.textContent, 'New York');
  now += 700;
  const space = await panel.emit('keydown', { key: ' ' });
  assert.equal(space.prevented, undefined, 'Unbuffered Space remains a native button action');
  await panel.emit('keydown', { key: 'Home' });
  assert.equal(document.activeElement.textContent, 'Alpha');
  await panel.emit('keydown', { key: 'ArrowUp' });
  assert.equal(document.activeElement.textContent, 'Newark');
  await panel.emit('keydown', { key: 'ArrowDown' });
  assert.equal(document.activeElement.textContent, 'Alpha');
  await panel.emit('keydown', { key: 'End' });
  assert.equal(document.activeElement.textContent, 'Newark');
  const tab = await panel.emit('keydown', { key: 'Tab' });
  assert.equal(tab.prevented, undefined);
  assert.equal(menu.popup.isOpen(), false);
  assert.equal(document.activeElement, menu.trigger);
  menu.dispose();
});

test('menu updates preserve focused items and recover from disabling', async () => {
  const { root, document } = domFixture();
  const items = [
    { id: 'a', label: 'Alpha', run() {} },
    { id: 'b', label: 'Beta', run() {} },
    { id: 'c', label: 'Gamma', run() {} },
  ];
  const menu = mountMenu(root, 'Actions', items);
  menu.popup.open();
  const panel = document.body.querySelector('.menu-popup');
  const second = panel.querySelectorAll('button')[1];
  second.focus();
  // The fixture does not emit focus events automatically; a browser does.
  await second.emit('focus');
  menu.update(items);
  assert.equal(document.activeElement, second);
  menu.update([items[0], { ...items[1], label: 'Beta changed' }, items[2]]);
  assert.equal(document.activeElement.textContent, 'Beta changed');
  await panel.emit('keydown', { key: 'ArrowDown' });
  assert.equal(document.activeElement.textContent, 'Gamma');
  menu.update([items[0], items[1], { ...items[2], disabled: true }]);
  assert.equal(document.activeElement.textContent, 'Alpha');
  await panel.emit('keydown', { key: 'End' });
  assert.equal(document.activeElement.textContent, 'Beta');
  menu.dispose();
});

test('select movement retains the positional origin of unavailable highlights', async () => {
  const { root, document } = domFixture();
  const select = document.createElement('select');
  const first = addOption(document, select, 'a', 'Alpha');
  const second = addOption(document, select, 'b', 'Beta');
  const third = addOption(document, select, 'c', 'Gamma');
  select.selectedIndex = 1;
  root.append(select);
  const control = enhanceSelect(select);
  control.popup.open();
  second.disabled = true;
  control.refresh();
  await control.trigger.emit('keydown', { key: 'ArrowDown' });
  assert.equal(highlightedValue(document, control), 'c');
  third.hidden = true;
  control.refresh();
  await control.trigger.emit('keydown', { key: 'ArrowUp' });
  assert.equal(highlightedValue(document, control), 'a');
  first.disabled = true;
  control.refresh();
  await control.trigger.emit('keydown', { key: 'End' });
  assert.equal(control.trigger.getAttribute('aria-activedescendant'), null);
  await control.trigger.emit('keydown', { key: 'ArrowDown' });
  await control.trigger.emit('keydown', { key: 'Enter' });
  assert.equal(select.value, 'b', 'Unavailable options must not be committed');
  control.dispose();
});

test('tab roving focus survives reorders and resets at selection or focus boundaries', async () => {
  const { root, document } = domFixture();
  const options = {
    kind: 'task',
    items: [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ],
    selected: 'a',
    canAdd: true,
    addLabel: 'New task',
    onSelect() {},
    onAdd() {},
    onClose() {},
  };
  const tabs = mountTabRow(root, options);
  const list = root.querySelector('.tabbar');
  const close = root.querySelector('.close-active-tab');
  const [first, second] = root.querySelectorAll('[role=tab]');
  first.focus();
  await list.emit('keydown', { key: 'ArrowRight', target: first });
  assert.equal(document.activeElement, second);
  tabs.update({ ...options, items: [options.items[1], { ...options.items[0], status: 'working' }] });
  assert.deepEqual(root.querySelectorAll('[role=tab]'), [second, first]);
  assert.equal(first.tabIndex, -1);
  assert.equal(second.tabIndex, 0);
  assert.equal(close.getAttribute('aria-label'), 'Close Alpha tab');

  tabs.update({ ...options, selected: 'b' });
  assert.equal(document.activeElement, second);
  assert.equal(first.tabIndex, -1);
  assert.equal(second.tabIndex, 0);
  assert.equal(close.getAttribute('aria-label'), 'Close Beta tab');
  const outside = document.createElement('input');
  root.append(outside);
  outside.focus();
  tabs.update(options);
  assert.equal(document.activeElement, outside);
  assert.equal(first.tabIndex, 0);
  assert.equal(second.tabIndex, -1);
  first.focus();
  await list.emit('keydown', { key: 'End', target: first });
  assert.equal(document.activeElement, second);
  tabs.update({ ...options, items: [options.items[0]] });
  assert.equal(document.activeElement, first, 'Removing the focused tab recovers selected-tab focus');
  tabs.dispose();
});

test('closing the selected tab stays outside the tablist and restores focus after updates', async () => {
  const { root, document } = domFixture();
  const closed = [];
  const options = {
    kind: 'task',
    items: [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ],
    selected: 'a',
    canAdd: true,
    addLabel: 'New task',
    onSelect() {},
    onAdd() {},
    onClose: (id) => closed.push(id),
    menuItems: () => [{ id: 'inspect', label: 'Inspect task', run() {} }],
  };
  const tabs = mountTabRow(root, options);
  const list = root.querySelector('[role=tablist]');
  const close = root.querySelector('.close-active-tab');
  const add = root.querySelector('.add-tab');
  const [first, second] = list.children;
  assert.deepEqual(
    list.children.map((child) => child.getAttribute('role')),
    ['tab', 'tab'],
  );
  assert.equal(list.contains(close), false);
  assert.equal(list.querySelector('.menu-popup'), null);
  assert.equal(document.body.querySelectorAll('.menu-popup').length, 2);
  assert.equal(close.getAttribute('aria-label'), 'Close Alpha tab');

  tabs.update({ ...options, selected: 'b' });
  assert.equal(close.getAttribute('aria-label'), 'Close Beta tab');
  close.focus();
  await close.emit('click');
  assert.deepEqual(closed, ['b']);
  assert.equal(document.activeElement, close, 'Wait for the host update before moving focus');
  tabs.update({ ...options, items: [options.items[0]] });
  assert.equal(document.activeElement, first);
  assert.equal(second.isConnected, false);
  assert.equal(close.getAttribute('aria-label'), 'Close Alpha tab');

  close.focus();
  await close.emit('click');
  tabs.update({ ...options, items: [], selected: '' });
  assert.deepEqual(closed, ['b', 'a']);
  assert.equal(document.activeElement, add);
  assert.equal(close.hidden, true);
  assert.equal(list.hidden, true);
  assert.equal(list.children.length, 0);
  assert.equal(root.querySelector('.empty-tabs').hidden, false);

  tabs.update({ ...options, onClose: undefined });
  assert.equal(close.hidden, true);
  assert.equal(list.hidden, false);
  tabs.dispose();
  assert.equal(close.listenerCount, 0);
});

test('library preserves local filters and observes mutated external options', async () => {
  const { root, document, observers } = domFixture();
  const options = {
    view: 'tasks',
    scopeProjectId: 'p',
    state: reconcileWorkspace(emptyWorkspace(), {
      projects: [{ id: 'p' }, { id: 'q' }],
      tasks: [
        { id: 'a', projectId: 'p' },
        { id: 'b', projectId: 'p' },
        { id: 'c', projectId: 'q' },
      ],
    }),
    projects: [
      { id: 'p', label: 'Project', subtitle: '/p', status: 'idle' },
      { id: 'q', label: 'Other', subtitle: '/q', status: 'idle' },
    ],
    tasks: [
      { id: 'a', projectId: 'p', label: 'Alpha', subtitle: 'Goal', status: 'working' },
      { id: 'b', projectId: 'p', label: 'Beta', subtitle: 'Goal', status: 'complete' },
      { id: 'c', projectId: 'q', label: 'Gamma', subtitle: 'Goal', status: 'working' },
    ],
    open() {},
    restore() {},
    clearHistory: async () => {},
    menu: () => [{ id: 'action', label: 'Action', run() {} }],
  };
  const library = mountLibrary(root, options);
  await setImmediate();
  const search = root.querySelector('input');
  await root.emit('keydown', { key: 'ArrowDown', target: search });
  assert.equal(document.activeElement.dataset.libraryKey, 'task:a');
  await root.emit('keydown', { key: 'End', target: document.activeElement });
  assert.equal(document.activeElement.dataset.libraryKey, 'task:b');
  await root.emit('keydown', { key: 'ArrowDown', target: document.activeElement });
  assert.equal(document.activeElement.dataset.libraryKey, 'task:a');
  const filter = root.querySelector('select');
  filter.value = 'active';
  await filter.emit('change');
  library.update(options);
  assert.equal(filter.value, 'active');
  assert.equal(root.querySelectorAll('.library-open').length, 1);

  const tabs = root.querySelector('.library-tabs');
  await tabs.emit('keydown', { key: 'Home' });
  assert.equal(document.activeElement.textContent, 'Projects');
  library.update(options);
  assert.equal(root.querySelector('.library-panel').getAttribute('aria-labelledby'), 'library-tab-projects');
  await tabs.emit('keydown', { key: 'End' });
  assert.equal(document.activeElement.textContent, 'Recently closed');
  await tabs.emit('keydown', { key: 'ArrowRight' });
  assert.equal(document.activeElement.textContent, 'Projects');

  options.initialFilter = 'complete';
  library.update(options);
  assert.equal(root.querySelector('.library-panel').getAttribute('aria-labelledby'), 'library-tab-tasks');
  assert.equal(filter.value, 'complete');
  assert.equal(root.querySelector('.library-open').dataset.libraryKey, 'task:b');
  assert.ok(
    observers.some((observer) => observer.disconnected),
    'Rerender disposes obsolete row menus',
  );
  options.scopeProjectId = 'q';
  options.initialFilter = 'all';
  library.update(options);
  assert.equal(root.querySelector('.library-open').dataset.libraryKey, 'task:c');
  library.dispose();
  assert.equal(document.listenerCount, 0);
  assert.ok(observers.every((observer) => observer.disconnected));
});

test('follow-up actions track running and disabled state without resetting the draft', () => {
  const { root } = domFixture();
  const options = {
    workerId: 'a',
    running: false,
    send: async () => {},
    steer: async () => {},
  };
  const composer = mountFollowupComposer(root, options);
  const input = root.querySelector('textarea');
  const footer = root.querySelector('.followup-footer');
  const send = footer.querySelector('.primary');
  const steer = footer.querySelector('.steer-button');
  const hint = footer.querySelector('small');
  composer.focus('Keep the current draft.');
  assert.equal(steer.hidden, true);
  assert.equal(hint.hidden, true);
  assert.equal(send.textContent, 'Send');

  composer.update({ ...options, running: true });
  assert.equal(steer.hidden, false);
  assert.equal(steer.textContent, 'Steer now');
  assert.equal(steer.disabled, false);
  assert.equal(hint.hidden, false);
  assert.equal(send.textContent, 'Queue follow-up');

  composer.update({ ...options, running: true, disabled: true });
  assert.equal(input.disabled, true);
  assert.equal(send.disabled, true);
  assert.equal(steer.disabled, true);

  composer.update({ ...options, disabled: true });
  assert.equal(steer.hidden, true);
  assert.equal(hint.hidden, true);
  assert.equal(send.textContent, 'Send');
  assert.equal(send.disabled, true);
  assert.equal(input.disabled, true);
  assert.equal(input.value, 'Keep the current draft.');

  composer.update({ ...options, running: true });
  assert.equal(steer.hidden, false);
  assert.equal(steer.disabled, false);
  assert.equal(send.disabled, false);
  assert.equal(input.disabled, false);
  composer.dispose();
});

test('queue, steer and send require nonblank follow-up text and reset after submission', async () => {
  const { root } = domFixture();
  const instructions = [];
  const submit = async ({ instruction }) => instructions.push(instruction);
  const options = { workerId: 'a', running: true, send: submit, steer: submit };
  const composer = mountFollowupComposer(root, options);
  const input = root.querySelector('textarea');
  const form = root.querySelector('form');
  const queue = root.querySelector('.followup-footer').querySelector('.primary');
  const steer = root.querySelector('.steer-button');
  const rewrite = root.querySelector('.rewrite-toggle');
  assert.ok(queue.disabled && steer.disabled && rewrite.disabled);

  input.value = '  \n';
  await input.emit('input');
  assert.ok(queue.disabled && steer.disabled && rewrite.disabled);
  await form.emit('submit');
  await steer.emit('click');
  assert.deepEqual(instructions, []);

  input.value = ' Ship this ';
  await input.emit('input');
  assert.ok(!queue.disabled && !steer.disabled && !rewrite.disabled);
  await form.emit('submit');
  assert.deepEqual(instructions, ['Ship this']);
  assert.equal(input.value, '');
  assert.ok(queue.disabled && steer.disabled && rewrite.disabled);
  composer.update({ ...options, running: false });
  assert.equal(queue.textContent, 'Send');
  assert.equal(queue.disabled, true);
  composer.dispose();
});

for (const composer of ['draft', 'followup']) {
  test(
    composer + ' rewrite selects stay inside their enclosing dialog and dispose native resources',
    async () => {
      const { root, document, observers } = domFixture();
      const dialog = document.createElement('dialog');
      document.body.append(dialog);
      dialog.append(root);
      const input = document.createElement('textarea');
      dialog.append(input);
      input.value = 'Keep the draft.';
      let handle;
      if (composer === 'draft') {
        handle = mountDraftRewrite(root, input, {});
      } else {
        handle = mountFollowupComposer(root, { workerId: 'a', running: false, send: async () => {} });
        handle.focus(input.value);
      }
      const toggle = root.querySelector('.rewrite-toggle');
      await toggle.emit('click');
      root.querySelector('details').open = true;
      const selects = root.querySelectorAll('select');
      const triggers = root.querySelectorAll('.select-trigger');
      const popups = dialog.querySelectorAll('.select-popup');
      assert.equal(selects.length, 1);
      assert.equal(popups.length, 1);
      assert.ok(popups.every((panel) => panel.parentElement === dialog));
      await triggers[0].emit('click');
      assert.equal(popups[0].hidden, false);
      handle.dispose();
      assert.equal(dialog.querySelectorAll('.select-popup').length, 0);
      assert.ok(selects.every((select) => !select.hidden && select.listenerCount === 0));
      assert.ok(triggers.every((trigger) => trigger.listenerCount === 0));
      assert.equal(document.listenerCount, 0);
      assert.ok(observers.every((observer) => observer.disconnected));
    },
  );
}

test('popover native and fallback paths retain guards, close reasons, and cleanup', async () => {
  for (const fallback of [false, true]) {
    const { root, document, observers, frames } = domFixture();
    const trigger = document.createElement('button');
    const panel = document.createElement('div');
    const calls = [];
    panel.showPopover = () => {
      calls.push('show');
      if (fallback) {
        throw new Error('Native top layer unavailable');
      }
    };
    panel.hidePopover = () => calls.push('hide');
    root.append(trigger);
    const reasons = [];
    const popup = createPopover(trigger, panel, { onClose: (reason) => reasons.push(reason) });
    trigger.setAttribute('aria-disabled', 'true');
    popup.open();
    assert.equal(popup.isOpen(), false);
    trigger.removeAttribute('aria-disabled');
    popup.open();
    assert.equal(popup.isOpen(), true);
    assert.deepEqual(calls, ['show']);
    if (fallback) {
      assert.equal(panel.getAttribute('popover'), null);
    }
    trigger.disabled = true;
    observers[0].callback([]);
    assert.equal(frames.size, 1);
    const reposition = [...frames.values()][0];
    frames.clear();
    reposition();
    assert.equal(popup.isOpen(), false);
    assert.deepEqual(reasons, ['disabled']);
    assert.deepEqual(calls, ['show', 'hide']);
    observers[0].callback([]);
    assert.equal(frames.size, 0, 'A closed popup does not schedule mutation work');
    trigger.disabled = false;
    popup.open();
    const outside = document.createElement('input');
    root.append(outside);
    outside.focus();
    await document.emit('focusin', { target: outside });
    assert.equal(document.activeElement, outside);
    assert.equal(reasons.at(-1), 'blur');
    popup.dispose();
    assert.equal(document.listenerCount, 0);
    assert.ok(observers.every((observer) => observer.disconnected));
  }
});
