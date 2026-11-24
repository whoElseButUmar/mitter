import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { domFixture } from './dom-fixture.mjs';
import { requireElement, requireWindow, isNode } from '../src/dom/elements.js';
import { createPopover } from '../src/popover.js';
import { enhanceSelect } from '../src/select.js';
import { mountMenu } from '../src/menu.js';
import { mountTabRow } from '../src/tab-row.js';
import { mountDraftRewrite } from '../src/draft-rewrite.js';
import { mountFollowupComposer } from '../src/followup-composer.js';
import { mountResetForm } from '../src/reset-form.js';
import { mountModelSettingsForm } from '../src/model-settings-form.js';
import { captureCodeSelection } from '../src/selection-editor.js';
import { mountChangeReview } from '../src/change-review.js';
import { mountHealthPanel } from '../src/health-panel.js';
import { mountLibrary } from '../src/library.js';
import { emptyWorkspace, reconcileWorkspace } from '../src/workspace.js';
import { mountToasts, ToastCenter } from '../src/toast.js';

test('library keeps focused rows and scroll across updates, with text-only labels and disposal', async () => {
  const { root, document } = domFixture();
  const catalog = {
    projects: [{ id: 'p' }],
    tasks: [{ id: 'a', projectId: 'p' }],
  };
  const options = {
    view: 'tasks',
    scopeProjectId: 'p',
    state: reconcileWorkspace(emptyWorkspace(), catalog),
    projects: [{ id: 'p', label: 'Project', subtitle: '/root', status: 'idle' }],
    tasks: [
      {
        id: 'a',
        projectId: 'p',
        label: '<script>Literal</script>',
        subtitle: 'Goal',
        status: 'idle',
      },
    ],
    open() {},
    restore() {},
    clearHistory: async () => {},
    menu: () => [],
  };
  const library = mountLibrary(root, options);
  await setImmediate();
  const first = root.querySelector('.library-open');
  assert.equal(first.querySelector('strong').textContent, '<script>Literal</script>');
  assert.equal(first.querySelector('script'), null);
  assert.equal(first.querySelector('small'), null, 'Scoped tasks omit the repeated project and goal text.');
  assert.equal(first.title, '<script>Literal</script>\nProject · Goal');
  assert.equal(first.querySelector('.library-item-notice'), null);
  first.focus();
  root.querySelector('.library-panel').scrollTop = 42;
  library.update({
    ...options,
    tasks: [{ ...options.tasks[0], status: 'working' }],
  });
  assert.equal(document.activeElement.dataset.libraryKey, 'task:a');
  assert.equal(root.querySelector('.library-panel').scrollTop, 42);
  assert.equal(root.querySelector('.library-item-notice').textContent, 'Working');
  assert.equal(document.activeElement.getAttribute('aria-description'), 'Working');
  library.dispose();
  assert.equal(root.listenerCount, 0);
  assert.equal(document.listenerCount, 0);
  assert.equal(root.children.length, 0);
});

test('toast controls stay in dialog focus bounds and clean up on dismissal', async () => {
  const { root, document, window, observers } = domFixture();
  const returnTo = document.createElement('button');
  root.append(returnTo);
  returnTo.focus();
  const timers = new Map();
  const center = new ToastCenter({
    now: () => 1000,
    set(callback) {
      timers.set(callback, callback);
      return callback;
    },
    clear(id) {
      timers.delete(id);
    },
  });
  const dispose = mountToasts(document, center);
  center.push({ message: '<b>Literal toast</b>' });
  const notifications = document.body.querySelector('.miter-toasts');
  const card = notifications.querySelector('.miter-toast');
  assert.equal(card.querySelector('p').textContent, '<b>Literal toast</b>');
  assert.equal(card.querySelector('b'), null);
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  document.body.append(dialog);
  observers[0].callback([{ type: 'childList', addedNodes: [dialog], removedNodes: [] }]);
  assert.equal(notifications.parentElement, dialog);
  const dismiss = card.querySelector('.miter-toast-close');
  dismiss.focus();
  await dismiss.emit('click');
  assert.equal(document.activeElement, returnTo);
  dispose();
  assert.equal(document.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  assert.equal(timers.size, 0);
  assert.ok(observers.every((observer) => observer.disconnected));
});

function button(root, text) {
  const found = root.querySelectorAll('button').find((node) => node.textContent === text);
  assert.ok(found, 'Missing button: ' + text);
  return found;
}

function nativeSelect(document, values) {
  const select = document.createElement('select');
  for (const [value, text, disabled] of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    option.disabled = !!disabled;
    select.append(option);
  }
  return select;
}

test('required DOM guards reject missing nodes and wrong real constructor types', () => {
  const { root, document, window } = domFixture();
  const input = document.createElement('input');
  root.append(input);
  assert.equal(requireElement(root, 'input', window.HTMLInputElement), input);
  assert.throws(() => requireElement(root, 'input', window.HTMLButtonElement), /invalid UI element/);
  assert.throws(() => requireElement(root, 'form', window.HTMLFormElement), /Missing/);
  assert.throws(() => requireWindow({ defaultView: null }), /attached to a window/);
  assert.equal(isNode(document, input), true);
  assert.equal(isNode(document, {}), false);
});

test('popover dismissal preserves focus and restores attributes/listeners', async () => {
  const { root, document, window, frames, observers } = domFixture();
  const trigger = document.createElement('button');
  trigger.setAttribute('aria-haspopup', 'dialog');
  const panel = document.createElement('div');
  root.append(trigger, panel);
  const reasons = [];
  const popup = createPopover(trigger, panel, {
    onClose: (reason) => reasons.push(reason),
  });
  popup.open();
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.hidden, false);
  assert.equal(panel.style.width, '218px');
  const outside = document.createElement('input');
  root.append(outside);
  outside.focus();
  await document.emit('pointerdown', { target: outside });
  assert.equal(document.activeElement, outside);
  assert.equal(popup.isOpen(), false);
  popup.open();
  const otherTrigger = document.createElement('button');
  root.append(otherTrigger);
  const other = createPopover(otherTrigger, document.createElement('div'));
  other.open();
  assert.equal(reasons.at(-1), 'superseded');
  await document.emit('keydown', { key: 'Escape' });
  assert.equal(document.activeElement, otherTrigger);
  other.dispose();
  popup.open();
  await window.emit('resize');
  assert.equal(frames.size, 1);
  popup.dispose();
  assert.equal(frames.size, 0);
  assert.equal(document.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(trigger.getAttribute('aria-expanded'), null);
  assert.ok(observers.every((observer) => observer.disconnected));
});

test('select skips disabled values and restores labels and invalid state', async () => {
  const { root, document } = domFixture();
  const label = document.createElement('label');
  label.setAttribute('for', 'original');
  const name = document.createElement('span');
  name.textContent = 'Choose';
  const select = nativeSelect(document, [
    ['a', '<script>literal</script>'],
    ['b', 'Disabled', true],
    ['c', 'C'],
  ]);
  select.setAttribute('tabindex', '2');
  label.append(name, select);
  root.append(label);
  const control = enhanceSelect(select);
  let changes = 0;
  select.addEventListener('change', () => {
    changes += 1;
  });
  assert.equal(control.trigger.querySelector('.select-value').textContent, '<script>literal</script>');
  assert.equal(label.htmlFor, control.trigger.id);
  await control.trigger.emit('keydown', { key: 'ArrowDown' });
  await control.trigger.emit('keydown', { key: 'ArrowDown' });
  await control.trigger.emit('keydown', { key: 'Enter' });
  assert.equal(select.value, 'c');
  assert.equal(changes, 1);
  await select.emit('invalid');
  assert.equal(control.trigger.getAttribute('aria-invalid'), 'true');
  assert.equal(document.activeElement, control.trigger);
  select.disabled = true;
  control.refresh();
  assert.equal(control.trigger.disabled, true);
  control.dispose();
  assert.equal(select.hidden, false);
  assert.equal(select.getAttribute('tabindex'), '2');
  assert.equal(label.getAttribute('for'), 'original');
  assert.equal(select.getAttribute('aria-hidden'), null);
});

test('menu skips disabled items and refreshes callbacks without replacing nodes', async () => {
  const { root, document } = domFixture();
  const calls = [];
  const items = [
    { id: 'a', label: '<b>Literal</b>', run: () => calls.push('old') },
    { id: 'b', label: 'Unavailable', disabled: true, run() {} },
    { id: 'c', label: 'Continue', run: () => calls.push('continue') },
  ];
  const menu = mountMenu(root, 'Actions', items);
  menu.popup.open();
  const first = document.activeElement;
  assert.equal(first.textContent, '<b>Literal</b>');
  menu.update([{ ...items[0], run: () => calls.push('new') }, items[1], items[2]]);
  assert.equal(document.activeElement, first);
  await first.emit('click');
  assert.deepEqual(calls, ['new']);
  menu.popup.open();
  await document.body.querySelector('.menu-popup').emit('keydown', { key: 'ArrowDown' });
  assert.equal(document.activeElement.textContent, 'Continue');
  menu.dispose();
  assert.equal(root.children.length, 0);
  assert.equal(document.listenerCount, 0);
});

test('tab status updates preserve keyed DOM and roving focus with closing outside the tablist', async () => {
  const { root, document } = domFixture();
  const closed = [];
  const options = {
    kind: 'task',
    items: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    selected: 'a',
    canAdd: true,
    addLabel: 'New task',
    onSelect() {},
    onAdd() {},
    onClose: (id) => closed.push(id),
  };
  const tabs = mountTabRow(root, options);
  const first = root.querySelector('[role=tab]');
  first.focus();
  tabs.update({
    ...options,
    items: [{ id: 'a', label: 'A changed' }, options.items[1]],
  });
  assert.equal(root.querySelector('[role=tab]'), first);
  assert.equal(first.textContent, 'A changed');
  assert.equal(first.querySelector('button'), null);
  const list = root.querySelector('[role=tablist]');
  const close = root.querySelector('.tab-close');
  assert.equal(list.contains(close), false);
  assert.equal(close.getAttribute('aria-label'), 'Close A changed tab');
  assert.equal(first.querySelector('.state-dot'), null);
  await list.emit('keydown', { key: 'ArrowRight', target: first });
  assert.equal(document.activeElement.dataset.tabId, 'b');
  await list.emit('keydown', { key: 'Delete', target: document.activeElement });
  assert.deepEqual(closed, ['b']);
  tabs.dispose();
  assert.equal(root.children.length, 0);
});

test('draft rewriting protects an edited source and restores focus when keeping the original', async () => {
  const { root, document } = domFixture();
  const input = document.createElement('textarea');
  input.value = 'original draft';
  const pending = Promise.withResolvers();
  const rewrite = mountDraftRewrite(root, input, { rewrite: () => pending.promise });
  const toggle = button(root, 'Rewrite…');
  await toggle.emit('click');
  const generate = button(root, 'Rewrite with ChatGPT');
  assert.equal(document.activeElement, generate);
  const generating = generate.emit('click');
  assert.equal(rewrite.open, true);
  assert.match(root.querySelector('.rewrite-status').textContent, /Waiting for ChatGPT/);
  input.value = 'edited while waiting';
  await input.emit('input');
  pending.resolve('rewritten draft');
  await generating;
  assert.equal(input.value, 'edited while waiting');
  assert.equal(button(root, 'Use rewrite').disabled, true);
  assert.match(root.querySelector('.rewrite-status').textContent, /Draft changed/);
  await button(root, 'Keep original').emit('click');
  assert.equal(rewrite.open, false);
  assert.equal(document.activeElement, toggle);
  rewrite.dispose();
  assert.equal(root.children.length, 0);
});

test('cancelling a rewrite unlocks the form immediately and ignores late results after retry or disposal', async () => {
  const { root, document } = domFixture();
  const input = document.createElement('textarea');
  input.value = 'original draft';
  const previous = Promise.withResolvers();
  const next = Promise.withResolvers();
  const opened = [];
  const signals = [];
  const rewrite = mountDraftRewrite(root, input, {
    rewrite: (_request, signal) => {
      signals.push(signal);
      if (signals.length === 1) {
        return previous.promise;
      }
      return next.promise;
    },
    openChanged: (open) => opened.push(open),
  });
  await button(root, 'Rewrite…').emit('click');
  const generating = button(root, 'Rewrite with ChatGPT').emit('click');
  await button(root, 'Cancel').emit('click');
  assert.equal(signals[0].aborted, true);
  assert.equal(rewrite.open, false);
  await button(root, 'Rewrite…').emit('click');
  const retry = button(root, 'Rewrite with ChatGPT').emit('click');
  previous.resolve('late result');
  await generating;
  assert.match(root.querySelector('.rewrite-status').textContent, /Waiting for ChatGPT/);
  assert.equal(button(root, 'Use rewrite').hidden, true);
  assert.deepEqual(opened, [true, false, true]);
  rewrite.dispose();
  assert.equal(signals[1].aborted, true);
  next.resolve('another late result');
  await retry;
  assert.equal(root.children.length, 0);
});

test('a follow-up rewrite rejects invalid text and applies a valid preview without sending it', async () => {
  const { root, document } = domFixture();
  let text = 'invalid\0draft';
  const composer = mountFollowupComposer(root, {
    workerId: 'a',
    running: false,
    rewrite: async () => text,
    send: async () => assert.fail('A rewrite cannot send a follow-up'),
  });

  composer.focus('keep this draft');
  const input = root.querySelector('textarea');
  await root.querySelector('.rewrite-toggle').emit('click');
  assert.equal(root.querySelector('.followup-footer').hidden, true);
  await root.querySelector('form').emit('submit');
  await button(root, 'Rewrite with ChatGPT').emit('click');
  assert.match(root.querySelector('.rewrite-status').textContent, /valid rewrite/);
  assert.equal(button(root, 'Use rewrite').hidden, true);
  assert.equal(input.value, 'keep this draft');

  text = 'revised draft';
  await button(root, 'Rewrite with ChatGPT').emit('click');
  assert.equal(root.querySelector('.rewrite-preview').value, text);
  assert.equal(input.value, 'keep this draft');
  await button(root, 'Use rewrite').emit('click');
  assert.equal(input.value, text);
  assert.equal(document.activeElement, input);
  assert.equal(root.querySelector('.followup-footer').hidden, false);
  assert.equal(root.querySelector('.followup-send').disabled, false);
  composer.dispose();
});

test('local formatting previews the original wording without contacting ChatGPT', async () => {
  const { root, document } = domFixture();
  const input = document.createElement('textarea');
  input.value = 'Keep app.mjs exactly where it is.';
  const rewrite = mountDraftRewrite(root, input, {
    rewrite: async () => assert.fail('Local formatting cannot contact ChatGPT'),
  });
  await button(root, 'Rewrite…').emit('click');
  root.querySelector('details').open = true;
  await button(root, 'Format on this device').emit('click');
  assert.match(root.querySelector('.rewrite-preview').value, /Keep app\.mjs exactly where it is\./);
  await button(root, 'Use rewrite').emit('click');
  assert.match(input.value, /^Requested change:/);
  rewrite.dispose();
});

test('follow-up rewriting aborts on task changes and retrying send keeps its idempotency key', async () => {
  const { root } = domFixture();
  const pending = Promise.withResolvers();
  const requests = [];
  let fail = true;
  let signal;
  const options = {
    workerId: 'a',
    running: false,
    rewrite: (_request, nextSignal) => {
      signal = nextSignal;
      return pending.promise;
    },
    send: async (request) => {
      requests.push(request);
      if (fail) {
        throw new Error('retry');
      }
    },
  };
  const composer = mountFollowupComposer(root, options);
  composer.focus('follow up');
  await root.querySelector('.rewrite-toggle').emit('click');
  const generating = button(root, 'Rewrite with ChatGPT').emit('click');
  composer.update({ ...options, workerId: 'b' });
  assert.equal(signal.aborted, true);
  pending.resolve('stale rewrite');
  await generating;
  assert.equal(root.querySelector('.rewrite-output').hidden, true);
  await root.querySelector('form').emit('submit');
  fail = false;
  await root.querySelector('form').emit('submit');
  assert.equal(requests[0].id, requests[1].id);
  assert.equal(requests[0].instruction, 'follow up');
  assert.equal(root.querySelector('textarea').value, '');
  assert.equal(root.querySelector('.followup-send').disabled, true);
  composer.dispose();
  assert.equal(root.children.length, 0);
});

test('reset locks pending requests and never replays on reconnect', async () => {
  const { root } = domFixture();
  const pending = Promise.withResolvers();
  let calls = 0;
  const form = mountResetForm(root, {
    clear: () => {
      calls += 1;
      return pending.promise;
    },
    close() {},
  });
  const input = root.querySelector('[data-confirm]');
  input.value = 'CLEAR';
  await input.emit('input');
  form.setConnected(false);
  assert.equal(root.querySelector('[data-clear]').disabled, true);
  form.setConnected(true);
  const clearing = root.querySelector('form').emit('submit');
  form.update({ phase: 'idle' });
  assert.equal(input.disabled, true);
  form.setConnected(false);
  form.setConnected(true);
  assert.equal(calls, 1);
  pending.reject(new Error('<b>failure</b>'));
  await clearing;
  assert.equal(root.querySelector('.reset-failure').textContent, '<b>failure</b>');
  assert.equal(root.querySelector('[data-clear]').textContent, 'Retry clearing all data');
  form.dispose();
});

test('model settings validate tokens and ignore post-disposal saves', async () => {
  const { root } = domFixture();
  const pending = Promise.withResolvers();
  let closed = 0;
  let saved;
  const form = mountModelSettingsForm(root, {
    settings: {
      coderModelPath: '',
      gpu: 'auto',
      contextSize: 8192,
      maxTokens: 2048,
    },
    pick: async () => ({ cancelled: true }),
    save: (value) => {
      saved = value;
      return pending.promise;
    },
    close: () => {
      closed += 1;
    },
    reset() {},
  });
  const advanced = root.querySelector('[data-model-advanced]');
  assert.equal(advanced.hasAttribute('open'), false);
  root.querySelector('[name="maxTokens"]').value = '8192';
  await root.querySelector('form').emit('submit');
  assert.match(root.querySelector('.error').textContent, /smaller than context/);
  assert.equal(
    advanced.hasAttribute('open'),
    true,
    'Custom validation reveals the fields needing correction.',
  );
  assert.equal(saved, undefined);
  root.querySelector('[name="maxTokens"]').value = '2048';
  const saving = root.querySelector('form').emit('submit');
  assert.equal(saved.settings.maxTokens, 2048);
  assert.equal(root.querySelector('[data-reset]').disabled, true);
  form.dispose();
  pending.resolve();
  await saving;
  assert.equal(closed, 0);
});

test('native model validation reveals its collapsed ancestors before focusing the invalid draft', async () => {
  const { root, document } = domFixture();
  let saves = 0;
  const mounted = mountModelSettingsForm(root, {
    settings: { coderModelPath: '/draft/model.gguf', gpu: 'auto', contextSize: 8192, maxTokens: 2048 },
    pick: async () => ({ cancelled: true }),
    save: async () => {
      saves += 1;
    },
    close() {},
    reset() {},
  });
  const advanced = root.querySelector('[data-model-advanced]');
  const data = root.querySelector('.settings-data');
  const form = root.querySelector('form');
  const input = root.querySelector('[name="contextSize"]');
  input.value = '';
  form.reportValidity = () => {
    // The fixture dispatches directly; a browser sends this non-bubbling event through form capture.
    void form.emit('invalid', { target: input });
    assert.equal(advanced.hasAttribute('open'), true);
    input.focus();
    return false;
  };
  await form.emit('submit');
  assert.equal(document.activeElement, input);
  assert.equal(saves, 0);
  assert.equal(input.value, '');
  assert.equal(root.querySelector('[data-model-selection]').textContent, '/draft/model.gguf');
  assert.equal(
    data.hasAttribute('open'),
    false,
    'Validation does not reveal unrelated destructive controls.',
  );
  mounted.dispose();
  assert.equal(form.listenerCount, 0);
});

test('a failed model save reopens collapsed fields and preserves the draft and reset boundary', async () => {
  const { root } = domFixture();
  const pending = Promise.withResolvers();
  const busy = [];
  let resets = 0;
  let saves = 0;
  const mounted = mountModelSettingsForm(root, {
    settings: { coderModelPath: '/edited/model.gguf', gpu: 'cpu', contextSize: 8192, maxTokens: 2048 },
    pick: async () => ({ cancelled: true }),
    save: () => {
      saves += 1;
      return pending.promise;
    },
    close() {},
    reset: () => {
      resets += 1;
    },
    busyChanged: (value) => busy.push(value),
  });
  const advanced = root.querySelector('[data-model-advanced]');
  const form = root.querySelector('form');
  const reset = root.querySelector('[data-reset]');
  advanced.setAttribute('open', '');
  const saving = form.emit('submit');
  advanced.removeAttribute('open');
  await form.emit('submit');
  await reset.emit('click');
  assert.equal(saves, 1);
  assert.equal(resets, 0);
  pending.reject(new Error('The model file cannot be read. Choose another file.'));
  await saving;
  assert.equal(advanced.hasAttribute('open'), true);
  assert.equal(root.querySelector('[data-model-selection]').textContent, '/edited/model.gguf');
  assert.equal(root.querySelector('.error').hidden, false);
  assert.match(root.querySelector('.error').textContent, /Choose another file/);
  assert.deepEqual(busy, [true, false]);
  assert.equal(reset.disabled, false);
  await reset.emit('click');
  assert.equal(resets, 1);
  mounted.dispose();
});

test('model chooser keeps the selected file on cancel and saves changes only on submit', async () => {
  const { root } = domFixture();
  const pending = Promise.withResolvers();
  const saved = [];
  let picks = 0;
  const mounted = mountModelSettingsForm(root, {
    settings: { coderModelPath: '/original.gguf', gpu: 'auto', contextSize: 8192, maxTokens: 2048 },
    pick: async () => {
      picks++;
      if (picks === 1) {
        return pending.promise;
      }
      return { cancelled: true };
    },
    save: async ({ settings }) => saved.push(settings.coderModelPath),
    close() {},
    reset() {},
  });
  const choose = root.querySelector('[data-pick-model]');
  const clear = root.querySelector('[data-clear-model]');
  const selection = root.querySelector('[data-model-selection]');
  const form = root.querySelector('form');

  assert.equal(root.querySelector('[name="coderModelPath"]'), null);
  assert.equal(selection.textContent, '/original.gguf');
  const choosing = choose.emit('click');
  await choose.emit('click');
  await form.emit('submit');
  assert.deepEqual(saved, []);
  assert.equal(picks, 1);
  pending.resolve({ path: '/models/My model.gguf', cancelled: false });
  await choosing;
  await choose.emit('click');
  assert.equal(selection.textContent, '/models/My model.gguf');
  assert.deepEqual(saved, []);
  await form.emit('submit');
  assert.deepEqual(saved, ['/models/My model.gguf']);
  await clear.emit('click');
  assert.equal(selection.textContent, 'No model selected.');
  assert.equal(clear.hidden, true);
  await form.emit('submit');
  assert.deepEqual(saved, ['/models/My model.gguf', '']);
  mounted.dispose();
});

for (const dispose of [false, true]) {
  test('late failed model saves cannot reveal a closed owner; disposed=' + dispose, async () => {
    const { root } = domFixture();
    const pending = Promise.withResolvers();
    const busy = [];
    const mounted = mountModelSettingsForm(root, {
      settings: { coderModelPath: '', gpu: 'auto', contextSize: 8192, maxTokens: 2048 },
      pick: async () => ({ cancelled: true }),
      save: () => pending.promise,
      close() {},
      reset() {},
      busyChanged: (value) => busy.push(value),
    });
    const form = root.querySelector('form');
    const advanced = root.querySelector('[data-model-advanced]');
    const error = root.querySelector('.error');
    const saving = form.emit('submit');
    if (dispose) {
      mounted.dispose();
    } else {
      root.remove();
    }
    pending.reject(new Error('Late failure'));
    await saving;
    assert.equal(advanced.hasAttribute('open'), false);
    assert.equal(error.hidden, true);
    assert.equal(error.textContent, '');
    assert.deepEqual(busy, [true]);
    mounted.dispose();
    assert.equal(form.listenerCount, 0);
  });
}

test('selection capture keeps exact UTF-16 offsets and rejects changed source or external ranges', () => {
  const { root, document } = domFixture();
  const source = '\ufeffstart\r\n😀selected\nend';
  const start = source.indexOf('😀');
  const text = '😀selected';
  const code = document.createElement('pre');
  root.append(code);
  const range = {
    startContainer: code,
    endContainer: code,
    startOffset: start,
    toString: () => text,
    cloneRange: () => ({
      selectNodeContents() {},
      setEnd() {},
      toString: () => source.slice(0, start),
    }),
  };
  document.getSelection = () => ({
    rangeCount: 1,
    isCollapsed: false,
    getRangeAt: () => range,
  });
  const options = { path: 'file.ts', content: source, hash: 'a'.repeat(64) };
  assert.deepEqual(captureCodeSelection(root, options), {
    path: 'file.ts',
    hash: options.hash,
    start,
    end: start + text.length,
    text,
  });
  assert.equal(captureCodeSelection(root, { ...options, content: 'different' }), undefined);
  range.endContainer = document.createElement('pre');
  assert.equal(captureCodeSelection(root, options), undefined);
});

const reviewedFile = {
  path: 'file.ts',
  beforeHash: 'b'.repeat(64),
  afterHash: 'a'.repeat(64),
  currentHash: 'a'.repeat(64),
  conflict: false,
  status: 'applied',
  kind: 'modified',
  diff: {
    lines: [{ kind: 'add', text: 'Exact source', newLine: 1 }],
    additions: 1,
    deletions: 0,
    truncated: false,
    simplified: false,
  },
  canRestore: true,
};
const backupManifest = {
  format: 'miter-state-backup/1',
  id: 'state-20261011T123456789Z-11111111-1111-4111-8111-111111111111',
  createdAt: 0,
  appVersion: '1',
  schemaVersion: 42,
  reason: 'manual',
  bytes: 8192,
  sha256: 'a'.repeat(64),
};
const healthReport = {
  version: '1',
  protocol: 'mitter/1',
  node: '26',
  platform: 'darwin',
  architecture: 'arm64',
  workflow: 'workflow',
  database: { ok: true, schema: 42, bytes: 8192 },
  tasks: { total: 1, active: 0, finished: 0, stopped: 1 },
  attention: [],
  backups: [backupManifest],
  dataDirectory: '/private-state',
  limits: { savedProjects: 24, savedTasks: 100, previewBytes: 1024 },
  notice: 'Private task state only.',
};

for (const acknowledgement of [null, undefined, {}, { restored: 1 }]) {
  test('malformed restore acknowledgement preserves the review without success or replay', async () => {
    const { root } = domFixture();
    const calls = [];
    const notices = [];
    const panel = mountChangeReview(root, {
      workerId: 'worker',
      path: 'file.ts',
      notice: (message) => notices.push(message),
      rpc: async (method, params) => {
        calls.push({ method, params });
        if (method === 'worker.files') {
          return [{ path: 'file.ts', status: 'applied', bytes: 12 }];
        }
        if (method === 'worker.change') {
          return reviewedFile;
        }
        assert.equal(method, 'worker.restoreFile');
        return acknowledgement;
      },
    });
    try {
      await setImmediate();
      await button(root, 'Restore this file…').emit('click');
      await button(root, 'Restore file').emit('click');
      await setImmediate();
      assert.deepEqual(
        calls.map((call) => call.method),
        ['worker.files', 'worker.change', 'worker.restoreFile'],
      );
      assert.deepEqual(notices, []);
      assert.match(root.querySelector('p.error').textContent, /invalid result.*operation may already/);
      assert.match(root.querySelector('.change-diff').textContent, /Exact source/);
      assert.equal(button(root, 'Restore this file…').disabled, false);
    } finally {
      panel.dispose();
    }
  });
}

for (const operation of [
  { method: 'system.backup', label: 'Back up task state' },
  { method: 'system.verifyBackup', label: 'Verify' },
]) {
  for (const acknowledgement of [null, undefined, {}, { id: backupManifest.id }]) {
    test(
      operation.method + ' malformed acknowledgement cannot announce success, refresh, or replay',
      async () => {
        const { root } = domFixture();
        const calls = [];
        const notices = [];
        const panel = mountHealthPanel(root, {
          rpc: async (method, params) => {
            calls.push({ method, params });
            if (method === 'system.health') {
              return healthReport;
            }
            assert.equal(method, operation.method);
            return acknowledgement;
          },
          copy: async () => assert.fail('An unconfirmed mutation must not copy task state.'),
          notice: (message) => notices.push(message),
        });
        try {
          await setImmediate();
          await button(root, operation.label).emit('click');
          await setImmediate();
          assert.deepEqual(
            calls.map((call) => call.method),
            ['system.health', operation.method],
          );
          assert.deepEqual(notices, []);
          assert.match(root.querySelector('[role=alert]').textContent, /invalid result/);
          assert.equal(button(root, operation.label).disabled, false);
        } finally {
          panel.dispose();
        }
      },
    );
  }
}

test('review and health panels ignore delayed RPC data after disposal', async () => {
  const { root } = domFixture();
  const pending = Promise.withResolvers();
  const review = mountChangeReview(root, {
    workerId: 'a',
    rpc: () => pending.promise,
    notice() {},
  });
  review.dispose();
  pending.resolve([{ path: 'x', status: 'applied' }]);
  await setImmediate();
  assert.equal(root.children.length, 0);
  const healthPending = Promise.withResolvers();
  const health = mountHealthPanel(root, {
    rpc: () => healthPending.promise,
    copy: async () => {},
    notice() {},
  });
  health.dispose();
  healthPending.resolve({ malformed: true });
  await setImmediate();
  assert.equal(root.children.length, 0);
});
