import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { mock, test } from 'node:test';
import { rolldown } from 'rolldown';
import { NativeRequestTimeout } from '../native-request.ts';

const requirePackage = createRequire(import.meta.url);
class TestHTMLElement {}
const elementConstructors = {
  HTMLElement: TestHTMLElement,
  HTMLButtonElement: class extends TestHTMLElement {},
  HTMLSelectElement: class extends TestHTMLElement {},
  HTMLOptionElement: class extends TestHTMLElement {},
  HTMLParagraphElement: class extends TestHTMLElement {},
  HTMLFormElement: class extends TestHTMLElement {},
  HTMLTextAreaElement: class extends TestHTMLElement {},
  HTMLInputElement: class extends TestHTMLElement {},
  HTMLDivElement: class extends TestHTMLElement {},
  HTMLDetailsElement: class extends TestHTMLElement {},
  HTMLUListElement: class extends TestHTMLElement {},
};

const selectorConstructors = new Map([
  ...['start', 'find', 'cancel', 'create'].map((name) => [
    '[data-' + name + ']',
    elementConstructors.HTMLButtonElement,
  ]),
  ...['chat', 'turns', 'minutes', 'project', 'mode', 'workspace', 'rule', 'profile'].map((name) => [
    '[data-' + name + ']',
    elementConstructors.HTMLSelectElement,
  ]),
  ...['name', 'start-now', 'path', 'text'].map((name) => [
    '[data-' + name + ']',
    elementConstructors.HTMLInputElement,
  ]),
  ...['apply', 'clipboard', 'cancel', 'validate'].map((name) => [
    '[data-reply="' + name + '"]',
    elementConstructors.HTMLButtonElement,
  ]),
  ['[data-task-form]', elementConstructors.HTMLFormElement],
  ['[data-advanced]', elementConstructors.HTMLDetailsElement],
  ['[data-command-check]', elementConstructors.HTMLOptionElement],
  ['[data-goal]', elementConstructors.HTMLTextAreaElement],
  ['textarea', elementConstructors.HTMLTextAreaElement],
  ['[data-error]', elementConstructors.HTMLParagraphElement],
  ['.reply-status', elementConstructors.HTMLDivElement],
  ['.reply-summary', elementConstructors.HTMLParagraphElement],
  ['.reply-task', elementConstructors.HTMLParagraphElement],
  ['.reply-actions', elementConstructors.HTMLUListElement],
]);

function deferred() {
  return Promise.withResolvers();
}

// These are controller tests, not browser/widget tests. Only the DOM operations
// used by the sheets are modeled; select and draft-rewrite lifetimes are spies.
function element(properties = {}, elementConstructor = elementConstructors.HTMLElement) {
  const listeners = new Map();
  const children = [];
  return Object.assign(new elementConstructor(), {
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    required: false,
    checked: false,
    open: false,
    children,
    options: children,
    classList: { toggle: mock.fn() },
    focus: mock.fn(),
    reportValidity: () => true,
    setCustomValidity: mock.fn(),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) {
        listeners.delete(type);
      }
    },
    emit(type, event = {}) {
      const listener = listeners.get(type) || this[`on${type}`];
      return listener?.({ preventDefault() {}, ...event });
    },
    contains: (child) => children.includes(child),
    replaceChildren(...items) {
      children.splice(0, children.length, ...items);
    },
    append(...items) {
      children.push(...items);
    },
    add(option) {
      children.push(option);
      if (children.length === 1) {
        this.value = option.value;
      }
      option.remove = () => children.splice(children.indexOf(option), 1);
    },
    ...properties,
  });
}

async function sheetHarness(name) {
  const defaults = {
    '[data-chat]': { value: 'new' },
    '[data-turns]': { value: '15' },
    '[data-minutes]': { value: '30' },
    '[data-mode]': { value: 'handoff' },
    '[data-workspace]': { value: 'shared' },
    '[data-rule]': { value: 'human' },
    '[data-goal]': { value: 'Build a small app' },
    '[data-start-now]': { checked: true },
    '[data-error]': { hidden: true },
    '[data-project-context]': { hidden: true },
  };
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) {
      nodes.set(selector, element(defaults[selector], selectorConstructors.get(selector)));
    }
    return nodes.get(selector);
  }
  node('[data-chat]').add(element({ value: 'new' }));
  const root = {
    innerHTML: '',
    querySelector: node,
    replaceChildren: mock.fn(),
  };
  const selects = { refresh: mock.fn(), dispose: mock.fn() };
  const rewrite = { open: false, close: mock.fn(), setDisabled: mock.fn(), dispose: mock.fn() };
  const mountDraftRewrite = mock.fn(() => rewrite);
  const attachments = {
    busy: false,
    hasImages: false,
    setScope: mock.fn(),
    setAvailability: mock.fn(),
    submission: mock.fn(),
    dispose: mock.fn(),
  };
  const clock = { now: () => 1000 };
  const dependencies = {
    '../../ui/src/select.js': { enhanceSelects: () => selects },
    '../../ui/src/icons.js': { addDisclosureMarkers: mock.fn() },
    '../../ui/src/draft-rewrite.js': { mountDraftRewrite },
    '../../ui/src/image-attachments.js': { mountImageAttachments: () => attachments },
    './native-request.js': { NativeRequestTimeout },
  };

  const bundle = await rolldown({
    input: fileURLToPath(new URL(`../${name}-sheet.ts`, import.meta.url)),
    external: (specifier) => Object.hasOwn(dependencies, specifier) || specifier === 'zod',
    platform: 'node',
  });

  let output;

  try {
    ({ output } = await bundle.generate({ format: 'cjs' }));
  } finally {
    await bundle.close();
  }

  const chunk = output.find((entry) => entry.type === 'chunk' && entry.isEntry);

  assert.ok(chunk, 'The sheet controller must compile to an entry chunk.');

  const module = { exports: {} };
  const evaluate = new Function(
    'require',
    'module',
    'exports',
    'document',
    'Date',
    ...Object.keys(elementConstructors),
    chunk.code,
  );

  evaluate(
    (specifier) => dependencies[specifier] ?? requirePackage(specifier),
    module,
    module.exports,
    { createElement: () => element() },
    clock,
    ...Object.values(elementConstructors),
  );

  const controller = module.exports;
  const mount = controller[`mount${name[0].toUpperCase()}${name.slice(1)}Sheet`];
  return { root, node, selects, rewrite, attachments, mountDraftRewrite, mount: (deps) => mount(root, deps) };
}

function startDependencies(overrides = {}) {
  return {
    authorize: mock.fn(async () => true),
    lastChat: mock.fn(async () => null),
    loadChats: mock.fn(async () => []),
    start: mock.fn(async () => {}),
    stop: mock.fn(async () => {}),
    started: mock.fn(),
    close: mock.fn(),
    ...overrides,
  };
}

function createdTask(overrides = {}) {
  return {
    id: 'task',
    projectId: 'project-a',
    name: 'Created task',
    goal: 'Build a small app',
    checks: [],
    mode: 'handoff',
    state: 'idle',
    queue: [],
    cursor: 0,
    runId: 'created-run',
    iteration: 0,
    maxIterations: 15,
    maxMinutes: 30,
    startedAt: 0,
    autoCommands: false,
    observations: [],
    repeatCount: 0,
    createdAt: 1000,
    ...overrides,
  };
}

function taskDependencies(overrides = {}) {
  return {
    projects: [
      {
        id: 'project-a',
        name: 'Project A',
        profiles: [{ id: 'test', label: 'Test' }],
      },
      { id: 'project-b', name: 'Project B', profiles: [] },
    ],
    authorize: mock.fn(async () => true),
    create: mock.fn(async (params) => createdTask({ projectId: params.projectId, mode: params.mode })),
    created: mock.fn(),
    start: mock.fn(async () => ({ started: true })),
    stop: mock.fn(async () => ({ stopping: false })),
    close: mock.fn(),
    ...overrides,
  };
}

function preview(overrides = {}) {
  return {
    workerId: 'task',
    ticket: 'ticket',
    taskName: '<b>Task</b>',
    summary: '<script>summary</script>',
    actions: ['<img src=x>'],
    source: 'chat',
    expiresAt: 2000,
    ...overrides,
  };
}

function replyDependencies(overrides = {}) {
  return {
    workerId: 'task',
    preview: mock.fn(async () => preview()),
    apply: mock.fn(async () => {}),
    readClipboard: mock.fn(async () => 'copied JSON'),
    close: mock.fn(),
    applied: mock.fn(),
    ...overrides,
  };
}

test('sheet element lookups reject absent and incorrectly typed template controls', async () => {
  const sheet = await sheetHarness('start');
  const deps = startDependencies();
  sheet.root.querySelector = (selector) => {
    if (selector === '[data-start]') {
      return null;
    }
    return sheet.node(selector);
  };
  assert.throws(() => sheet.mount(deps), /missing its \[data-start\] element/);
  sheet.root.querySelector = (selector) => {
    if (selector === '[data-start]') {
      return element();
    }
    return sheet.node(selector);
  };
  assert.throws(() => sheet.mount(deps), /wrong type/);
  assert.equal(deps.authorize.mock.callCount(), 0);
  assert.equal(deps.lastChat.mock.callCount(), 0);
});

test('invalid coding-source values cannot escape the task form as unchecked modes', async () => {
  const sheet = await sheetHarness('task');
  const deps = taskDependencies();
  const dispose = sheet.mount(deps);
  sheet.node('[data-mode]').value = 'invalid-mode';
  await sheet.node('[data-task-form]').emit('submit');
  assert.equal(deps.authorize.mock.callCount(), 0);
  assert.equal(deps.create.mock.callCount(), 0);
  assert.equal(sheet.node('[data-mode]').reportValidity(), true);
  assert.deepEqual(
    sheet.node('[data-mode]').setCustomValidity.mock.calls.map((call) => call.arguments[0]),
    ['Choose a coding source.', ''],
  );
  dispose();
});

test('start permission is requested synchronously from the click, never on mount', async () => {
  const permission = deferred();
  const deps = startDependencies({
    authorize: mock.fn(() => permission.promise),
  });
  const sheet = await sheetHarness('start');
  const dispose = sheet.mount(deps);
  assert.equal(deps.authorize.mock.callCount(), 0);
  const starting = sheet.node('[data-start]').emit('click');
  assert.equal(deps.authorize.mock.callCount(), 1);
  await sheet.node('[data-start]').emit('click');
  assert.equal(deps.authorize.mock.callCount(), 1);
  permission.resolve(true);
  await starting;
  assert.deepEqual(deps.start.mock.calls[0].arguments, [
    {
      consent: true,
      newChat: true,
      maxTurns: 15,
      maxMinutes: 30,
    },
  ]);
  assert.equal(deps.started.mock.callCount(), 1);
  dispose();
});

test('start captures the chat and limits before permission and locks choices while pending', async () => {
  const permission = deferred();
  const chat = {
    providerId: 'chatgpt',
    id: 42,
    title: 'Task discussion',
    url: 'https://chatgpt.com/c/task-discussion',
  };
  const deps = startDependencies({
    authorize: mock.fn(() => permission.promise),
    lastChat: async () => chat,
  });
  const sheet = await sheetHarness('start');
  const dispose = sheet.mount(deps);
  await setImmediate();
  sheet.node('[data-turns]').value = '8';
  sheet.node('[data-minutes]').value = '15';
  const starting = sheet.node('[data-start]').emit('click');
  for (const field of ['chat', 'turns', 'minutes', 'find', 'start']) {
    assert.equal(sheet.node(`[data-${field}]`).disabled, true);
  }
  sheet.node('[data-chat]').value = 'new';
  sheet.node('[data-turns]').value = '20';
  sheet.node('[data-minutes]').value = '60';
  permission.resolve(true);
  await starting;
  assert.deepEqual(deps.start.mock.calls[0].arguments, [
    { consent: true, newChat: false, tabId: 42, maxTurns: 8, maxMinutes: 15 },
  ]);
  await sheet.node('[data-start]').emit('click');
  assert.equal(deps.start.mock.callCount(), 1);
  dispose();
});

test('denied start permission leaves the unsent request editable and retryable', async () => {
  let allowed = false;
  const deps = startDependencies({ authorize: mock.fn(async () => allowed) });
  const sheet = await sheetHarness('start');
  const dispose = sheet.mount(deps);
  await sheet.node('[data-start]').emit('click');
  assert.equal(deps.start.mock.callCount(), 0);
  assert.match(sheet.node('[data-error]').textContent, /Nothing was sent/);
  assert.doesNotMatch(sheet.node('[data-error]').textContent, /could not be confirmed/);
  for (const field of ['chat', 'turns', 'minutes', 'find', 'start']) {
    assert.equal(sheet.node(`[data-${field}]`).disabled, false);
  }
  assert.equal(sheet.node('[data-start]').hidden, false);
  allowed = true;
  await sheet.node('[data-start]').emit('click');
  assert.equal(deps.start.mock.callCount(), 1);
  assert.equal(deps.started.mock.callCount(), 1);
  dispose();
});

test('a rejected start offers task-state recovery without another send or assumed cleanup', async (context) => {
  for (const failure of [
    new NativeRequestTimeout('bridge.start'),
    new Error('Miter could not read the response to bridge.start.'),
    new Error('The chat connection was interrupted.'),
  ]) {
    await context.test(failure.message, async () => {
      const deps = startDependencies({
        start: mock.fn(async () => {
          throw failure;
        }),
      });
      const sheet = await sheetHarness('start');
      const dispose = sheet.mount(deps);
      await sheet.node('[data-start]').emit('click');
      assert.match(sheet.node('[data-error]').textContent, /Go back to the task to check its status/);
      assert.ok(sheet.node('[data-error]').textContent.startsWith(failure.message));
      assert.equal(sheet.node('[data-start]').hidden, true);
      assert.equal(sheet.node('[data-cancel]').textContent, 'Back to task');
      assert.equal(sheet.node('[data-cancel]').focus.mock.callCount(), 1);
      await sheet.node('[data-start]').emit('click');
      await sheet.node('[data-find]').emit('click');
      assert.equal(deps.authorize.mock.callCount(), 1);
      assert.equal(deps.start.mock.callCount(), 1);
      assert.equal(deps.loadChats.mock.callCount(), 0);
      assert.equal(deps.stop.mock.callCount(), 0);
      assert.equal(deps.started.mock.callCount(), 0);
      await sheet.node('[data-cancel]').emit('click');
      assert.equal(deps.close.mock.callCount(), 1);
      dispose();
    });
  }
});

test('disposed start sheets cannot request permission or submit again', async () => {
  const deps = startDependencies();
  const sheet = await sheetHarness('start');
  const dispose = sheet.mount(deps);
  dispose();
  await sheet.node('[data-start]').emit('click');
  await sheet.node('[data-find]').emit('click');
  assert.equal(deps.authorize.mock.callCount(), 0);
  assert.equal(deps.start.mock.callCount(), 0);
  assert.equal(deps.loadChats.mock.callCount(), 0);
});

test('a late start rejection cannot announce errors or move focus after disposal', async () => {
  const started = deferred();
  const deps = startDependencies({ start: mock.fn(() => started.promise) });
  const sheet = await sheetHarness('start');
  const dispose = sheet.mount(deps);
  const pending = sheet.node('[data-start]').emit('click');
  await setImmediate();
  dispose();
  started.reject(new Error('Start response lost.'));
  await pending;
  assert.equal(sheet.node('[data-error]').hidden, true);
  assert.equal(sheet.node('[data-cancel]').focus.mock.callCount(), 0);
  assert.equal(deps.started.mock.callCount(), 0);
  assert.equal(deps.close.mock.callCount(), 0);
  assert.equal(deps.stop.mock.callCount(), 0);
});

test('start permission continuations do nothing after disposal', async (t) => {
  for (const button of ['[data-start]', '[data-find]']) {
    await t.test(button, async () => {
      const permission = deferred();
      const deps = startDependencies({
        authorize: mock.fn(() => permission.promise),
      });
      const sheet = await sheetHarness('start');
      const dispose = sheet.mount(deps);
      const pending = sheet.node(button).emit('click');
      dispose();
      permission.resolve(true);
      await pending;
      assert.equal(deps.start.mock.callCount(), 0);
      assert.equal(deps.loadChats.mock.callCount(), 0);
      assert.equal(sheet.selects.dispose.mock.callCount(), 1);
    });
  }
});

test('a start that finishes after disposal is stopped, without notifying or closing', async () => {
  const started = deferred();
  const deps = startDependencies({ start: mock.fn(() => started.promise) });
  const sheet = await sheetHarness('start');
  const dispose = sheet.mount(deps);
  const pending = sheet.node('[data-start]').emit('click');
  await setImmediate();
  dispose();
  assert.equal(deps.stop.mock.callCount(), 0);
  started.resolve();
  await pending;
  assert.equal(deps.stop.mock.callCount(), 1);
  assert.equal(deps.started.mock.callCount(), 0);
  assert.equal(deps.close.mock.callCount(), 0);
});

test('a remembered chat never overrides a user selection', async () => {
  const remembered = deferred();
  const sheet = await sheetHarness('start');
  const dispose = sheet.mount(startDependencies({ lastChat: () => remembered.promise }));
  sheet.node('[data-chat]').emit('change');
  remembered.resolve({
    providerId: 'chatgpt',
    id: 42,
    title: 'Last chat',
    url: 'https://chatgpt.com/c/123456789',
  });
  await setImmediate();
  assert.equal(sheet.node('[data-chat]').value, 'new');
  assert.equal(sheet.node('[data-chat]').options.length, 1);
  dispose();
});

test('refreshing chats preserves an available tab and falls back when it disappears', async () => {
  const chat = {
    providerId: 'chatgpt',
    id: 42,
    title: '<b>Last chat</b>',
    url: 'https://chatgpt.com/c/123456789',
  };
  let chats = [chat];
  const deps = startDependencies({
    lastChat: async () => chat,
    loadChats: async () => chats,
  });
  const sheet = await sheetHarness('start');
  const dispose = sheet.mount(deps);
  await setImmediate();
  assert.equal(sheet.node('[data-destination-hint]').textContent, chat.title);
  await sheet.node('[data-find]').emit('click');
  assert.equal(sheet.node('[data-chat]').value, '42');
  chats = [];
  await sheet.node('[data-find]').emit('click');
  assert.equal(sheet.node('[data-chat]').value, 'new');
  assert.equal(sheet.node('[data-error]').hidden, false);
  dispose();
});

test('chat choices use readable titles and distinguish duplicates without exposing internal IDs', async () => {
  const deps = startDependencies({
    loadChats: async () =>
      [
        { id: 41, title: 'Planning' },
        { id: 42, title: '<b>Same title</b>' },
        { id: 43, title: '<b>Same title</b>' },
        { id: 44, title: '' },
      ].map((chat) => ({
        ...chat,
        providerId: 'chatgpt',
        url: 'https://chatgpt.com/c/conversation-' + chat.id,
      })),
  });
  const sheet = await sheetHarness('start');
  const dispose = sheet.mount(deps);
  await sheet.node('[data-find]').emit('click');
  assert.deepEqual(
    sheet
      .node('[data-chat]')
      .options.slice(1)
      .map((option) => [option.value, option.textContent]),
    [
      ['41', 'Planning'],
      ['42', '<b>Same title</b> (chat 1)'],
      ['43', '<b>Same title</b> (chat 2)'],
      ['44', 'Untitled chat'],
    ],
  );
  assert.doesNotMatch(sheet.root.innerHTML, /destination-dot/);
  sheet.node('[data-chat]').value = '43';
  await sheet.node('[data-start]').emit('click');
  assert.equal(deps.start.mock.calls[0].arguments[0].tabId, 43);
  dispose();
});

test('task rewrite options omit absent callbacks and preserve provided callbacks', async (context) => {
  const rewrite = mock.fn(async (request) => request.instruction);
  for (const [name, overrides] of [
    ['absent', {}],
    ['explicit undefined', { rewrite: undefined }],
    ['provided', { rewrite }],
  ]) {
    await context.test(name, async () => {
      const sheet = await sheetHarness('task');
      const dispose = sheet.mount(taskDependencies(overrides));
      const options = sheet.mountDraftRewrite.mock.calls[0].arguments[2];
      assert.equal(Object.hasOwn(options, 'rewrite'), name === 'provided');
      if (name === 'provided') {
        assert.equal(options.rewrite, rewrite);
      } else {
        assert.equal(options.rewrite, undefined);
      }
      sheet.rewrite.open = true;
      options.openChanged(true);
      assert.equal(sheet.node('[data-create]').disabled, true);
      sheet.rewrite.open = false;
      options.openChanged(false);
      assert.equal(sheet.node('[data-create]').disabled, false);
      dispose();
    });
  }
});

test('a scoped task starts with the current folder and default checks without opening advanced options', async () => {
  const sheet = await sheetHarness('task');
  const deps = taskDependencies({ scopedProjectId: 'project-a' });
  const dispose = sheet.mount(deps);
  assert.match(
    sheet.root.innerHTML,
    /<details class="form-advanced" data-advanced><summary>Advanced options/,
  );
  assert.equal(sheet.node('[data-project-field]').hidden, true);
  assert.equal(sheet.node('[data-project-context]').hidden, false);
  assert.equal(sheet.node('[data-project-context]').textContent, 'Project: Project A');
  assert.equal(sheet.node('[data-advanced]').open, false);
  assert.equal(sheet.node('[data-start-now]').checked, true);
  assert.equal(sheet.node('[data-create]').textContent, 'Start task');
  assert.match(sheet.node('[data-disclosure]').textContent, /ChatGPT.*approval/);
  await sheet.node('[data-task-form]').emit('submit');
  assert.equal(deps.authorize.mock.callCount(), 1);
  assert.equal(deps.create.mock.callCount(), 1);
  assert.equal(deps.start.mock.callCount(), 1);
  const params = deps.create.mock.calls[0].arguments[0];
  assert.equal(params.projectId, 'project-a');
  assert.equal(params.workspaceMode, 'shared');
  assert.equal(params.mode, 'handoff');
  assert.deepEqual(params.checks, []);
  dispose();
});

test('typing preserves advanced options state and saving without starting keeps permission untouched', async () => {
  const sheet = await sheetHarness('task');
  const deps = taskDependencies();
  const dispose = sheet.mount(deps);
  const advanced = sheet.node('[data-advanced]');
  assert.equal(sheet.node('[data-project-context]').hidden, true);
  assert.equal(sheet.node('[data-project-field]').hidden, false);
  for (const open of [true, false]) {
    advanced.open = open;
    sheet.node('[data-goal]').value = 'Build a reading journal';
    await sheet.node('[data-goal]').emit('input');
    assert.equal(advanced.open, open);
  }
  sheet.node('[data-start-now]').checked = false;
  await sheet.node('[data-start-now]').emit('change');
  assert.equal(sheet.node('[data-create]').textContent, 'Create task');
  assert.equal(sheet.node('[data-disclosure]').textContent, 'Creates a task without starting it.');
  assert.equal(advanced.open, false);
  await sheet.node('[data-task-form]').emit('submit');
  assert.equal(deps.create.mock.callCount(), 1);
  assert.equal(deps.authorize.mock.callCount(), 0);
  assert.equal(deps.start.mock.callCount(), 0);
  dispose();
});

test('invalid advanced fields reveal their disclosure before validation blocks submission', async () => {
  const sheet = await sheetHarness('task');
  const deps = taskDependencies();
  const dispose = sheet.mount(deps);
  const form = sheet.node('[data-task-form]');
  const advanced = sheet.node('[data-advanced]');
  await form.emit('invalid', { target: sheet.node('[data-goal]') });
  assert.equal(advanced.open, false, 'An invalid main goal does not expose unrelated options');
  for (const [rule, selector] of [
    ['exists', '[data-path]'],
    ['contains', '[data-text]'],
    ['command', '[data-profile]'],
  ]) {
    sheet.node('[data-rule]').value = rule;
    await sheet.node('[data-rule]').emit('change');
    const input = sheet.node(selector);
    advanced.append(input);
    advanced.open = false;
    assert.equal(input.required, true);
    assert.equal(input.disabled, false);
    form.reportValidity = () => {
      form.emit('invalid', { target: input });
      return false;
    };
    await form.emit('submit');
    assert.equal(advanced.open, true);
    assert.equal(deps.authorize.mock.callCount(), 0);
    assert.equal(deps.create.mock.callCount(), 0);
  }
  dispose();
  advanced.open = false;
  await form.emit('invalid', { target: sheet.node('[data-path]') });
  assert.equal(advanced.open, false, 'Disposal releases the invalid-field listener');
});

test('task submission captures its scoped project and form data before permission resolves', async () => {
  const permission = deferred();
  const deps = taskDependencies({
    scopedProjectId: 'project-a',
    authorize: mock.fn(() => permission.promise),
  });
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(deps);
  sheet.node('[data-project]').value = 'project-b';
  sheet.node('[data-goal]').value = 'The goal: Build a game';
  sheet.node('[data-rule]').value = 'contains';
  sheet.node('[data-path]').value = 'index.html';
  sheet.node('[data-text]').value = '<main>';
  const pending = sheet.node('[data-task-form]').emit('submit');
  assert.equal(deps.authorize.mock.callCount(), 1);
  assert.equal(deps.create.mock.callCount(), 0);
  sheet.node('[data-goal]').value = 'Changed later';
  await sheet.node('[data-task-form]').emit('submit');
  permission.resolve(true);
  await pending;
  assert.equal(deps.create.mock.callCount(), 1);
  assert.deepEqual(deps.create.mock.calls[0].arguments[0], {
    workspaceMode: 'shared',
    name: 'Game',
    goal: 'Build a game',
    projectId: 'project-a',
    checks: [{ type: 'contains', path: 'index.html', text: '<main>' }],
    mode: 'handoff',
    maxIterations: 15,
    maxMinutes: 30,
  });
  dispose();
  assert.equal(deps.stop.mock.callCount(), 0);
});

test('disposal during task creation still reports the task but never starts it', async () => {
  const creation = deferred();
  const deps = taskDependencies({ create: mock.fn(() => creation.promise) });
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(deps);
  const pending = sheet.node('[data-task-form]').emit('submit');
  await setImmediate();
  dispose();
  creation.resolve(createdTask({ id: 'created-task' }));
  await pending;
  assert.deepEqual(deps.created.mock.calls[0].arguments, ['created-task']);
  assert.equal(deps.start.mock.callCount(), 0);
  assert.equal(deps.close.mock.callCount(), 0);
  assert.equal(sheet.rewrite.dispose.mock.callCount(), 1);
});

test('disposal stops a starting task immediately and again if its start later succeeds', async () => {
  const starting = deferred();
  const deps = taskDependencies({ start: mock.fn(() => starting.promise) });
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(deps);
  const pending = sheet.node('[data-task-form]').emit('submit');
  await setImmediate();
  dispose();
  assert.deepEqual(deps.stop.mock.calls[0].arguments, ['task', 'handoff']);
  starting.resolve();
  await pending;
  assert.equal(deps.stop.mock.callCount(), 2);
  assert.equal(deps.close.mock.callCount(), 0);
});

test('a failed start closes the created task sheet rather than permitting duplicate creation', async () => {
  const starting = deferred();
  const deps = taskDependencies({ start: mock.fn(() => starting.promise) });
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(deps);
  deps.close = mock.fn(dispose);
  const pending = sheet.node('[data-task-form]').emit('submit');
  await setImmediate();
  await sheet.node('[data-task-form]').emit('submit');
  starting.reject(new Error('Start failed'));
  await pending;
  await sheet.node('[data-task-form]').emit('submit');
  assert.equal(deps.create.mock.callCount(), 1);
  assert.equal(deps.close.mock.callCount(), 1);
  assert.equal(deps.stop.mock.callCount(), 0);
});

test('a launch-only prompt starts locally while a request to change the app keeps its coding source', async () => {
  for (const [goal, mode] of [
    ['Install dependencies with pnpm, start the dev server, and open the app preview.', 'local'],
    ['Start the app and add search to the catalog.', 'handoff'],
  ]) {
    const deps = taskDependencies();
    const sheet = await sheetHarness('task');
    const dispose = sheet.mount(deps);
    sheet.node('[data-goal]').value = goal;
    sheet.node('[data-mode]').value = 'handoff';
    sheet.node('[data-start-now]').checked = true;
    await sheet.node('[data-task-form]').emit('submit');
    assert.equal(deps.create.mock.calls[0].arguments[0].mode, mode);
    assert.equal(deps.start.mock.calls[0].arguments[1], mode);
    assert.equal(deps.authorize.mock.callCount(), Number(mode === 'handoff'));
    dispose();
  }
});

test('local starts and create-only submissions do not request ChatGPT permission', async (t) => {
  for (const [mode, startNow] of [
    ['local', true],
    ['handoff', false],
  ]) {
    await t.test(`${mode}, start=${startNow}`, async () => {
      const deps = taskDependencies();
      const sheet = await sheetHarness('task');
      const dispose = sheet.mount(deps);
      sheet.node('[data-mode]').value = mode;
      sheet.node('[data-start-now]').checked = startNow;
      await sheet.node('[data-task-form]').emit('submit');
      assert.equal(deps.authorize.mock.callCount(), 0);
      let expectedStarts = 0;
      if (startNow) {
        expectedStarts = 1;
      }
      assert.equal(deps.start.mock.callCount(), expectedStarts);
      dispose();
      assert.equal(deps.stop.mock.callCount(), 0);
    });
  }
});

test('completion fields retain native visibility, disabled and required states', async () => {
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(taskDependencies());
  for (const rule of ['human', 'exists', 'contains', 'command']) {
    sheet.node('[data-rule]').value = rule;
    sheet.node('[data-rule]').emit('change');
    for (const [field, input, visible] of [
      ['path', 'path', rule === 'exists' || rule === 'contains'],
      ['text', 'text', rule === 'contains'],
      ['profile', 'profile', rule === 'command'],
    ]) {
      assert.equal(sheet.node(`[data-${field}-field]`).hidden, !visible);
      assert.equal(sheet.node(`[data-${input}]`).disabled, !visible);
      assert.equal(sheet.node(`[data-${input}]`).required, visible);
    }
  }
  dispose();
});

test('projects without commands cannot strand creation on an empty required command picker', async () => {
  const sheet = await sheetHarness('task');
  const deps = taskDependencies({ scopedProjectId: 'project-b' });
  const dispose = sheet.mount(deps);
  assert.equal(sheet.node('[data-command-check]').disabled, true);
  assert.equal(sheet.node('[data-command-check-hint]').hidden, false);
  assert.equal(sheet.node('[data-rule]').value, 'human');
  assert.equal(sheet.node('[data-profile]').required, false);
  await sheet.node('[data-task-form]').emit('submit');
  assert.deepEqual(deps.create.mock.calls[0].arguments[0].checks, []);
  assert.equal(deps.create.mock.calls[0].arguments[0].projectId, 'project-b');
  dispose();
});

test('changing projects removes unavailable command checks and restores their availability', async () => {
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(taskDependencies());
  assert.equal(sheet.node('[data-command-check]').disabled, false);
  assert.equal(sheet.node('[data-command-check-hint]').hidden, true);
  sheet.node('[data-rule]').value = 'command';
  sheet.node('[data-rule]').emit('change');
  assert.equal(sheet.node('[data-profile]').required, true);
  sheet.node('[data-project]').value = 'project-b';
  sheet.node('[data-project]').emit('change');
  assert.equal(sheet.node('[data-command-check]').disabled, true);
  assert.equal(sheet.node('[data-rule]').value, 'human');
  assert.equal(sheet.node('[data-profile-field]').hidden, true);
  assert.equal(sheet.node('[data-profile]').required, false);
  assert.equal(sheet.node('[data-profile]').disabled, true);
  sheet.node('[data-project]').value = 'project-a';
  sheet.node('[data-project]').emit('change');
  assert.equal(sheet.node('[data-command-check]').disabled, false);
  assert.equal(sheet.node('[data-command-check-hint]').hidden, true);
  assert.deepEqual(
    sheet.node('[data-profile]').options.map((option) => option.value),
    ['', 'test'],
  );
  dispose();
});

test('a draft rewrite blocks task submission before any permission or creation', async () => {
  const deps = taskDependencies();
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(deps);
  sheet.rewrite.open = true;
  await sheet.node('[data-task-form]').emit('submit');
  assert.equal(deps.authorize.mock.callCount(), 0);
  assert.equal(deps.create.mock.callCount(), 0);
  dispose();
});

test('new task image references are reserved before creating and cleared only after confirmation', async () => {
  const sheet = await sheetHarness('task');
  const images = [
    {
      id: 'd077a2c1-0eb1-4231-9eb4-68deb3c9ec72',
      name: 'Reference.png',
      type: 'image/png',
      size: 84,
    },
  ];
  const calls = [];
  const deps = taskDependencies({
    authorize: mock.fn(async () => {
      calls.push('authorize');
      return true;
    }),
    create: mock.fn(async (params) => {
      calls.push('create');
      assert.deepEqual(params.imageAttachments, images);
      return createdTask({ imageAttachments: images });
    }),
  });
  sheet.attachments.hasImages = true;
  sheet.attachments.submission.mock.mockImplementation(() => ({
    images,
    reserve: async () => calls.push('reserve'),
    confirm: async () => calls.push('confirm'),
  }));
  const dispose = sheet.mount(deps);
  await sheet.node('[data-task-form]').emit('submit');
  assert.deepEqual(calls, ['authorize', 'reserve', 'create', 'confirm']);
  assert.deepEqual(sheet.attachments.setScope.mock.calls[0].arguments, ['new-task:project-a']);
  dispose();
});

test('denied task permission creates nothing and restores the form for a retry', async () => {
  const deps = taskDependencies({ authorize: mock.fn(async () => false) });
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(deps);
  await sheet.node('[data-task-form]').emit('submit');
  assert.equal(deps.create.mock.callCount(), 0);
  assert.equal(sheet.node('[data-error]').hidden, false);
  assert.equal(sheet.node('[data-create]').disabled, false);
  assert.equal(sheet.rewrite.setDisabled.mock.calls.at(-1).arguments[0], false);
  dispose();
});

test('task disposal while permission is pending prevents creation', async () => {
  const permission = deferred();
  const deps = taskDependencies({
    authorize: mock.fn(() => permission.promise),
  });
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(deps);
  const pending = sheet.node('[data-task-form]').emit('submit');
  dispose();
  permission.resolve(true);
  await pending;
  assert.equal(deps.create.mock.callCount(), 0);
  assert.equal(deps.start.mock.callCount(), 0);
  assert.equal(sheet.node('[data-goal]').focus.mock.callCount(), 0);
});

test('a reply expiring exactly now is still applied and notifies once', async () => {
  const deps = replyDependencies({
    preview: async () => preview({ expiresAt: 1000 }),
  });
  const sheet = await sheetHarness('reply');
  const dispose = sheet.mount(deps);
  await setImmediate();
  sheet.node('[data-reply="apply"]').emit('click');
  await setImmediate();
  assert.equal(deps.apply.mock.callCount(), 1);
  assert.equal(deps.applied.mock.callCount(), 1);
  dispose();
});

test('malformed or foreign reply previews never enable Apply or grant a ticket', async (context) => {
  for (const result of [
    undefined,
    null,
    {},
    preview({ ticket: '' }),
    preview({ actions: [1] }),
    preview({ workerId: 'other_task' }),
    preview({ source: 'clipboard' }),
  ]) {
    await context.test(JSON.stringify(result), async () => {
      const deps = replyDependencies({ preview: mock.fn(async () => result) });
      const sheet = await sheetHarness('reply');
      const dispose = sheet.mount(deps);
      await setImmediate();
      assert.equal(sheet.node('[data-reply="apply"]').disabled, true);
      assert.equal(sheet.node('.reply-preview').hidden, true);
      assert.match(sheet.node('.reply-status').textContent, /invalid|different task|different source/i);
      sheet.node('[data-reply="apply"]').onclick();
      assert.equal(deps.apply.mock.callCount(), 0);
      dispose();
    });
  }
});

test('malformed chat inventories do not populate or replace the selected destination', async () => {
  const deps = startDependencies({
    loadChats: mock.fn(async () => [
      { providerId: 'chatgpt', id: '7', title: 'Chat', url: 'https://chatgpt.com/c/chat' },
    ]),
  });
  const sheet = await sheetHarness('start');
  const dispose = sheet.mount(deps);
  await sheet.node('[data-find]').emit('click');
  assert.equal(sheet.node('[data-chat]').options.length, 1);
  assert.match(sheet.node('[data-error]').textContent, /invalid.*chat/i);
  assert.equal(deps.start.mock.callCount(), 0);
  dispose();
});

test('task creation validates the canonical full native worker before consuming its identity', async () => {
  const deps = taskDependencies({ create: mock.fn(async () => createdTask()) });
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(deps);
  await sheet.node('[data-task-form]').emit('submit');
  assert.deepEqual(deps.created.mock.calls[0].arguments, ['task']);
  assert.deepEqual(deps.start.mock.calls[0].arguments, ['task', 'handoff']);
  assert.equal(deps.create.mock.callCount(), 1);
  dispose();
});

test('a lost native task-creation acknowledgement cannot replay creation from the same form', async () => {
  const failure = new NativeRequestTimeout('worker.create');
  const deps = taskDependencies({
    create: mock.fn(async () => {
      throw failure;
    }),
  });
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(deps);
  await sheet.node('[data-task-form]').emit('submit');
  assert.match(sheet.node('[data-error]').textContent, /Check saved tasks before creating another/);
  await sheet.node('[data-task-form]').emit('submit');
  assert.equal(deps.create.mock.callCount(), 1);
  assert.equal(deps.created.mock.callCount(), 0);
  assert.equal(deps.start.mock.callCount(), 0);
  dispose();
  assert.equal(deps.stop.mock.callCount(), 0);
  assert.equal(failure.code, 'NATIVE_REQUEST_TIMEOUT');
});

test('malformed task-creation acknowledgements cannot start an unknown task or authorize duplicate creation', async (context) => {
  for (const result of [
    undefined,
    null,
    {},
    { id: 'task' },
    createdTask({ id: 1 }),
    createdTask({ cursor: -1 }),
    createdTask({ control: { epoch: 1 } }),
  ]) {
    await context.test(JSON.stringify(result), async () => {
      const deps = taskDependencies({ create: mock.fn(async () => result) });
      const sheet = await sheetHarness('task');
      const dispose = sheet.mount(deps);
      await sheet.node('[data-task-form]').emit('submit');
      assert.equal(deps.created.mock.callCount(), 0);
      assert.equal(deps.start.mock.callCount(), 0);
      assert.match(sheet.node('[data-error]').textContent, /invalid result for worker.create/i);
      await sheet.node('[data-task-form]').emit('submit');
      assert.equal(deps.create.mock.callCount(), 1);
      dispose();
      assert.equal(deps.stop.mock.callCount(), 0);
    });
  }
});

test('malformed task creation parameters fail before permission or native creation', async () => {
  const deps = taskDependencies();
  const sheet = await sheetHarness('task');
  const dispose = sheet.mount(deps);
  sheet.node('[data-workspace]').value = 'not-a-workspace';
  await sheet.node('[data-task-form]').emit('submit');
  assert.equal(deps.authorize.mock.callCount(), 0);
  assert.equal(deps.create.mock.callCount(), 0);
  assert.equal(deps.start.mock.callCount(), 0);
  assert.equal(sheet.node('[data-error]').hidden, false);
  dispose();
});

test('foreign task receipts and invalid task identities cannot start or authorize duplicate creation', async () => {
  for (const result of [
    createdTask({ projectId: 'project-b' }),
    createdTask({ mode: 'local' }),
    createdTask({ id: '' }),
    createdTask({ id: 'invalid task' }),
  ]) {
    const deps = taskDependencies({ create: mock.fn(async () => result) });
    const sheet = await sheetHarness('task');
    const dispose = sheet.mount(deps);
    await sheet.node('[data-task-form]').emit('submit');
    assert.equal(deps.created.mock.callCount(), 0);
    assert.equal(deps.start.mock.callCount(), 0);
    assert.match(sheet.node('[data-error]').textContent, /Check saved tasks before creating another/);
    await sheet.node('[data-task-form]').emit('submit');
    assert.equal(deps.create.mock.callCount(), 1);
    dispose();
  }
});

test('invalid local-start receipts retain the created task without another creation or start', async () => {
  const deps = taskDependencies({ start: mock.fn(async () => ({ queued: true })) });
  const sheet = await sheetHarness('task');
  sheet.node('[data-mode]').value = 'local';
  const dispose = sheet.mount(deps);
  await sheet.node('[data-task-form]').emit('submit');
  assert.equal(deps.created.mock.callCount(), 1);
  assert.equal(deps.start.mock.callCount(), 1);
  assert.match(sheet.node('[data-error]').textContent, /invalid result for worker.run/);
  await sheet.node('[data-task-form]').emit('submit');
  assert.equal(deps.create.mock.callCount(), 1);
  assert.equal(deps.start.mock.callCount(), 1);
  dispose();
});

test('a stale invalid local-start acknowledgement cannot close a replacement dialog after disposal', async () => {
  const starting = deferred();
  const deps = taskDependencies({ start: mock.fn(() => starting.promise) });
  const sheet = await sheetHarness('task');
  sheet.node('[data-mode]').value = 'local';
  const dispose = sheet.mount(deps);
  const pending = sheet.node('[data-task-form]').emit('submit');
  await setImmediate();
  dispose();
  starting.resolve({ queued: true });
  await pending;
  assert.equal(deps.create.mock.callCount(), 1);
  assert.equal(deps.start.mock.callCount(), 1);
  assert.equal(deps.stop.mock.callCount(), 1);
  assert.equal(deps.close.mock.callCount(), 0);
});

test('reply disposal suppresses delayed previews and keeps cancellation available while reading', async () => {
  const reading = deferred();
  const deps = replyDependencies({ preview: mock.fn(() => reading.promise) });
  const sheet = await sheetHarness('reply');
  const dispose = sheet.mount(deps);
  assert.equal(sheet.node('[data-reply="cancel"]').disabled, false);
  dispose();
  reading.resolve(preview());
  await setImmediate();
  assert.equal(sheet.node('.reply-preview').hidden, true);
  assert.equal(sheet.node('[data-reply="apply"]').disabled, true);
  assert.equal(deps.applied.mock.callCount(), 0);
});

test('reply apply is guarded, uses the selected ticket and suppresses callbacks after disposal', async () => {
  const applying = deferred();
  const deps = replyDependencies({ apply: mock.fn(() => applying.promise) });
  const sheet = await sheetHarness('reply');
  const dispose = sheet.mount(deps);
  await setImmediate();
  assert.equal(sheet.node('.reply-task').textContent, '<b>Task</b>');
  assert.equal(sheet.node('.reply-summary').textContent, '<script>summary</script>');
  assert.equal(sheet.node('.reply-actions').children[0].textContent, '<img src=x>');
  sheet.node('[data-reply="apply"]').emit('click');
  sheet.node('[data-reply="apply"]').emit('click');
  sheet.node('[data-reply="cancel"]').emit('click');
  assert.deepEqual(deps.apply.mock.calls[0].arguments, [
    { workerId: 'task', ticket: 'ticket', confirm: true },
  ]);
  assert.equal(deps.apply.mock.callCount(), 1);
  assert.equal(deps.close.mock.callCount(), 0);
  dispose();
  applying.resolve();
  await setImmediate();
  assert.equal(deps.applied.mock.callCount(), 0);
});

test('expired reply tickets cannot be applied and clipboard access remains gesture-bound', async () => {
  const clipboard = deferred();
  const deps = replyDependencies({
    preview: mock.fn(async () => preview({ expiresAt: 999 })),
    readClipboard: mock.fn(() => clipboard.promise),
  });
  const sheet = await sheetHarness('reply');
  const dispose = sheet.mount(deps);
  await setImmediate();
  sheet.node('[data-reply="apply"]').emit('click');
  assert.equal(deps.apply.mock.callCount(), 0);
  assert.equal(sheet.node('[data-reply="apply"]').disabled, true);
  assert.equal(sheet.node('.reply-preview').hidden, false);
  sheet.node('[data-reply="clipboard"]').emit('click');
  assert.equal(deps.readClipboard.mock.callCount(), 1);
  clipboard.resolve('copied JSON');
  await setImmediate();
  assert.deepEqual(deps.preview.mock.calls[1].arguments, [
    { workerId: 'task', source: 'clipboard', text: 'copied JSON' },
  ]);
  dispose();
});

test('an apply failure clears the preview and pasted retries bypass the clipboard', async () => {
  const deps = replyDependencies({
    apply: mock.fn(async () => {
      throw new Error('Apply failed');
    }),
  });
  const sheet = await sheetHarness('reply');
  const dispose = sheet.mount(deps);
  await setImmediate();
  sheet.node('[data-reply="apply"]').emit('click');
  await setImmediate();
  assert.equal(sheet.node('.reply-status').textContent, 'Apply failed');
  assert.equal(sheet.node('.reply-preview').hidden, true);
  assert.equal(sheet.node('[data-reply="apply"]').disabled, true);
  assert.equal(sheet.node('[data-reply="cancel"]').disabled, false);
  sheet.node('textarea').value = 'pasted JSON';
  sheet.node('[data-reply="validate"]').emit('click');
  await setImmediate();
  assert.equal(deps.readClipboard.mock.callCount(), 0);
  assert.deepEqual(deps.preview.mock.calls[1].arguments, [
    { workerId: 'task', source: 'clipboard', text: 'pasted JSON' },
  ]);
  dispose();
});
