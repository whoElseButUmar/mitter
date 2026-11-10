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
  first.focus();
  root.querySelector('.library-panel').scrollTop = 42;
  library.update({
    ...options,
    tasks: [{ ...options.tasks[0], status: 'working' }],
  });
  assert.equal(document.activeElement.dataset.libraryKey, 'task:a');
  assert.equal(root.querySelector('.library-panel').scrollTop, 42);
  assert.equal(root.querySelector('.state-dot').className, 'state-dot dot-working');
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

test('tab status updates preserve keyed DOM and roving focus, with separate close buttons', async () => {
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
    items: [{ id: 'a', label: 'A changed', status: 'working' }, options.items[1]],
  });
  assert.equal(root.querySelector('[role=tab]'), first);
  assert.equal(first.textContent, 'A changed');
  assert.equal(first.querySelector('button'), null);
  assert.equal(first.querySelector('i').className, 'state-dot dot-working');
  await root.querySelector('.tabbar').emit('keydown', { key: 'ArrowRight', target: first });
  assert.equal(document.activeElement.dataset.tabId, 'b');
  await root.querySelector('.tabbar').emit('keydown', { key: 'Delete', target: document.activeElement });
  assert.deepEqual(closed, ['b']);
  tabs.dispose();
  assert.equal(root.children.length, 0);
});

test('draft rewriting protects edited source and aborts disposed previews', async () => {
  const { root, document } = domFixture();
  const input = document.createElement('textarea');
  input.value = 'original draft';
  const pending = Promise.withResolvers();
  let signal;
  const busy = [];
  const rewrite = mountDraftRewrite(root, input, {
    rewrite: (_request, nextSignal) => {
      signal = nextSignal;
      return pending.promise;
    },
    busyChanged: (value) => busy.push(value),
  });
  const generating = button(root, 'Preview rewrite').emit('click');
  assert.equal(rewrite.busy, true);
  input.value = 'edited while waiting';
  pending.resolve('rewritten draft');
  await generating;
  assert.equal(input.value, 'edited while waiting');
  await button(root, 'Apply to draft').emit('click');
  assert.match(root.querySelector('.followup-status').textContent, /draft changed/);
  assert.deepEqual(busy, [true, false]);
  rewrite.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(root.children.length, 0);

  const nextPending = Promise.withResolvers();
  const next = mountDraftRewrite(root, input, {
    rewrite: () => nextPending.promise,
  });
  const late = button(root, 'Preview rewrite').emit('click');
  next.dispose();
  nextPending.resolve('late result');
  await late;
  assert.equal(root.children.length, 0);
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
  const generating = button(root, 'Preview rewrite').emit('click');
  composer.update({ ...options, workerId: 'b' });
  assert.equal(signal.aborted, true);
  pending.resolve('stale rewrite');
  await generating;
  assert.equal(root.querySelector('.rewrite-preview').hidden, true);
  await root.querySelector('form').emit('submit');
  fail = false;
  await root.querySelector('form').emit('submit');
  assert.equal(requests[0].id, requests[1].id);
  assert.equal(requests[0].instruction, 'follow up');
  assert.equal(root.querySelector('textarea').value, '');
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
    save: (value) => {
      saved = value;
      return pending.promise;
    },
    close: () => {
      closed += 1;
    },
    reset() {},
  });
  root.querySelector('[name="maxTokens"]').value = '8192';
  await root.querySelector('form').emit('submit');
  assert.match(root.querySelector('.error').textContent, /smaller than context/);
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
