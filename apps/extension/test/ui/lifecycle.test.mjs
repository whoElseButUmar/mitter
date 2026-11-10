import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { createEffect, createRoot, createSignal } from 'solid-js';
import { bindSandboxPreview } from '../../src/ui/sandbox-preview.ts';
import {
  PREVIEW_HTML_LIMIT,
  PreviewMessageSchema,
} from '../../../../packages/ui/src/preview/sandbox-messages.ts';
import { createAnimationFrames } from '../../src/ui/animation-frames.ts';
import { disposeTerminalScreen } from '../../src/ui/terminal-screen.ts';
import { bindTerminalInput, readTerminalScreen } from '../../src/ui/terminal-session.ts';
import { createFilePreview } from '../../src/ui/file-preview.ts';
import { createTaskSound } from '../../src/ui/task-sound.ts';
import { tabRowOptions } from '../../src/ui/tab-row-options.ts';
import { assetChunk, flush, waitFor } from './fixtures.mjs';

test('tab option snapshots track reactive getters, remove absent options, and stop after owner cleanup', () => {
  const updates = [];
  const onClose = () => {};
  const onList = () => {};
  const menuItems = () => [];
  const owner = createRoot((dispose) => {
    const [selected, setSelected] = createSignal('project_1');
    const [optional, setOptional] = createSignal({});
    const props = {
      kind: 'project',
      items: [],
      canAdd: true,
      addLabel: 'New project',
      onSelect: () => {},
      onAdd: () => {},
      get selected() {
        return selected();
      },
      get addDisabled() {
        return optional().addDisabled;
      },
      get onClose() {
        return optional().onClose;
      },
      get onList() {
        return optional().onList;
      },
      get listLabel() {
        return optional().listLabel;
      },
      get menuItems() {
        return optional().menuItems;
      },
    };

    createEffect(() => {
      updates.push(tabRowOptions(props));
    });

    return { dispose, setSelected, setOptional };
  });

  try {
    assert.equal(updates.length, 1);
    assert.equal(updates[0].selected, 'project_1');
    assert.equal(Object.hasOwn(updates[0], 'onClose'), false);

    owner.setSelected('project_2');
    assert.equal(updates.length, 2);
    assert.equal(updates[1].selected, 'project_2');

    owner.setOptional({ addDisabled: false, listLabel: '', onClose, onList, menuItems });
    assert.equal(updates.length, 3);
    assert.equal(updates[2].addDisabled, false);
    assert.equal(updates[2].listLabel, '');
    assert.equal(updates[2].onClose, onClose);
    assert.equal(updates[2].onList, onList);
    assert.equal(updates[2].menuItems, menuItems);

    owner.setOptional({});
    assert.equal(updates.length, 4);

    for (const key of ['addDisabled', 'listLabel', 'onClose', 'onList', 'menuItems']) {
      assert.equal(Object.hasOwn(updates[3], key), false);
    }
  } finally {
    owner.dispose();
  }

  const updateCount = updates.length;
  owner.setSelected('project_3');
  owner.setOptional({ addDisabled: true, onClose });
  assert.equal(updates.length, updateCount);
});

function message(source, data) {
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: source });
  return event;
}

function terminalScreen() {
  const writes = [];
  const lines = [];
  const handlers = {};
  const disposed = [];
  const element = new EventTarget();
  element.remove = () => disposed.push('element');
  const term = {
    options: {},
    parser: {
      registerOscHandler: (code, handler) => {
        handlers.osc = { code, handler };
        return { dispose: () => disposed.push('osc') };
      },
    },
    onData: (handler) => {
      handlers.data = handler;
      return { dispose: () => disposed.push('data') };
    },
    onResize: (handler) => {
      handlers.resize = handler;
      return { dispose: () => disposed.push('resize') };
    },
    attachCustomKeyEventHandler: (handler) => {
      handlers.key = handler;
    },
    write: (text, done) => {
      writes.push(text);
      done();
    },
    writeln: (text) => lines.push(text),
    reset: () => lines.push('reset'),
    paste: (text) => writes.push(text),
    clear: () => writes.push('clear'),
    hasSelection: () => false,
    dispose: () => disposed.push('terminal'),
  };
  const screen = {
    info: { id: 'session_1', projectId: 'project_1', exited: false },
    term,
    el: element,
    after: 0,
    polling: false,
    tail: Promise.resolve(),
    pending: 0,
    failed: false,
    exitShown: false,
    disposed: false,
    disposables: [],
  };
  return { screen, writes, lines, handlers, disposed };
}

test('sandbox handshake requires a MessageEvent, the current iframe source, and the ready schema', () => {
  const target = new EventTarget();
  const sent = [];
  const source = { postMessage: (...arguments_) => sent.push(arguments_) };
  const frame = { contentWindow: source };
  let html = '<h1>First document</h1>';
  const dispose = bindSandboxPreview(frame, () => html, target);
  target.dispatchEvent(new Event('message'));
  target.dispatchEvent(message({}, { kind: 'miter.preview.ready' }));
  target.dispatchEvent(message(source, { kind: 'untrusted' }));
  target.dispatchEvent(message(source, null));
  assert.deepEqual(sent, []);
  target.dispatchEvent(message(source, { kind: 'miter.preview.ready' }));
  assert.deepEqual(sent, [[{ kind: 'miter.preview', html }, '*']]);
  html = '<h1>Updated document</h1>';
  target.dispatchEvent(message(source, { kind: 'miter.preview.ready' }));
  assert.equal(sent[1][0].html, html);
  frame.contentWindow = null;
  target.dispatchEvent(message(source, { kind: 'miter.preview.ready' }));
  assert.equal(sent.length, 2);
  assert.equal(getEventListeners(target, 'message').length, 1);
  dispose();
  dispose();
  assert.equal(getEventListeners(target, 'message').length, 0);
  frame.contentWindow = source;
  target.dispatchEvent(message(source, { kind: 'miter.preview.ready' }));
  assert.equal(sent.length, 2);
});

test('sandbox parent sender rejects malformed and oversized HTML without consuming readiness or changing literal bytes', () => {
  const target = new EventTarget();
  const sent = [];
  const source = { postMessage: (...args) => sent.push(args) };
  const frame = { contentWindow: source };
  let html = null;
  const dispose = bindSandboxPreview(frame, () => html, target);

  for (const value of [
    null,
    false,
    {},
    'x'.repeat(PREVIEW_HTML_LIMIT + 1),
    '😀'.repeat(PREVIEW_HTML_LIMIT / 2 + 1),
    '😀'.repeat(PREVIEW_HTML_LIMIT / 2) + 'x',
  ]) {
    html = value;
    target.dispatchEvent(message(source, { kind: 'miter.preview.ready' }));
    assert.deepEqual(sent, []);
  }

  html = '\ufeff<p>Literal 😀</p>\r\n<script>unchanged();</script>\r\n';
  target.dispatchEvent(message(source, { kind: 'miter.preview.ready' }));
  assert.deepEqual(sent, [[PreviewMessageSchema.parse({ kind: 'miter.preview', html }), '*']]);
  assert.equal(sent[0][0].html, html);
  assert.equal(getEventListeners(target, 'message').length, 1);
  dispose();
  assert.equal(getEventListeners(target, 'message').length, 0);
});

test('animation cleanup cancels only pending frames and rejects scheduling and late callbacks', () => {
  const callbacks = new Map();
  const cancelled = [];
  const fired = [];
  let nextId = 0;
  const frames = createAnimationFrames({
    request: (callback) => {
      nextId++;
      callbacks.set(nextId, callback);
      return nextId;
    },
    cancel: (id) => cancelled.push(id),
  });
  frames.schedule(() => fired.push('first'));
  frames.schedule(() => fired.push('second'));
  callbacks.get(1)(0);
  assert.deepEqual(fired, ['first']);
  frames.dispose();
  frames.dispose();
  assert.deepEqual(cancelled, [2]);
  callbacks.get(2)(0);
  frames.schedule(() => fired.push('third'));
  assert.equal(nextId, 2);
  assert.deepEqual(fired, ['first']);
});

test('terminal disposal releases widget subscriptions, paste listener, terminal, and element exactly once', () => {
  const resource = terminalScreen();
  bindTerminalInput(resource.screen, {
    client: { request: async () => ({}) },
    isCurrent: () => true,
    fail: (error) => assert.fail(String(error)),
  });
  assert.equal(getEventListeners(resource.screen.el, 'paste').length, 1);
  assert.equal(resource.handlers.osc.code, 52);
  assert.equal(resource.handlers.osc.handler(), true);
  disposeTerminalScreen(resource.screen);
  disposeTerminalScreen(resource.screen);
  assert.deepEqual(resource.disposed, ['osc', 'data', 'resize', 'terminal', 'element']);
  assert.equal(getEventListeners(resource.screen.el, 'paste').length, 0);
  assert.equal(resource.screen.failed, true);
  assert.equal(resource.screen.disposed, true);
});

test('terminal input remains serialized, bounded, and does not split UTF-16 surrogate pairs', async () => {
  const resource = terminalScreen();
  const calls = [];
  bindTerminalInput(resource.screen, {
    client: {
      request: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    },
    isCurrent: () => true,
    fail: (error) => assert.fail(String(error)),
  });
  const first = 'x'.repeat(8191) + '😀tail';
  resource.handlers.data(first);
  resource.handlers.data('next');
  await resource.screen.tail;
  assert.deepEqual(
    calls.map((call) => call.params.data),
    ['x'.repeat(8191), '😀tail', 'next'],
  );
  assert.equal(calls.map((call) => call.params.data).join(''), first + 'next');
  assert.equal(resource.screen.pending, 0);
  resource.handlers.resize({ cols: 1000, rows: 1 });
  await flush();
  assert.deepEqual(calls[3], {
    method: 'terminal.resize',
    params: { sessionId: 'session_1', cols: 500, rows: 2 },
  });
});

test('terminal queued writes stop at disposal and a late rejection does not touch the disposed widget', async () => {
  const resource = terminalScreen();
  const pending = Promise.withResolvers();
  const calls = [];
  bindTerminalInput(resource.screen, {
    client: {
      request: (method) => {
        calls.push(method);
        return pending.promise;
      },
    },
    isCurrent: () => true,
    fail: (error) => assert.fail(String(error)),
  });
  resource.handlers.data('x'.repeat(20000));
  await flush();
  disposeTerminalScreen(resource.screen);
  Object.defineProperty(resource.screen.term, 'options', {
    get: () => assert.fail('A late write rejection touched a disposed terminal.'),
  });
  pending.reject(new Error('Connection closed'));
  await resource.screen.tail;
  assert.deepEqual(calls, ['terminal.write']);
  assert.equal(resource.screen.pending, 0);
});

test('terminal reads skip duplicate frames, record exit once, and prevent overlapping polls', async () => {
  const resource = terminalScreen();
  const pending = Promise.withResolvers();
  let requests = 0;
  let refreshes = 0;
  resource.screen.after = 1;
  const dependencies = {
    client: {
      request: () => {
        requests++;
        return pending.promise;
      },
    },
    isCurrent: () => true,
    fail: (error) => assert.fail(String(error)),
    refresh: async () => {
      refreshes++;
    },
  };
  const reading = readTerminalScreen(resource.screen, dependencies);
  await readTerminalScreen(resource.screen, dependencies);
  assert.equal(requests, 1);
  pending.resolve({
    reset: true,
    frames: [
      { seq: 1, data: 'duplicate' },
      { seq: 2, data: 'new' },
    ],
    exited: true,
    exitCode: 0,
  });
  await reading;
  await readTerminalScreen(resource.screen, dependencies);
  assert.deepEqual(resource.writes, ['new']);
  assert.equal(resource.screen.after, 2);
  assert.equal(resource.screen.polling, false);
  assert.equal(resource.screen.info.exited, true);
  assert.equal(resource.screen.term.options.disableStdin, true);
  assert.equal(refreshes, 1);
  assert.equal(resource.lines.filter((line) => line.includes('Shell exited')).length, 1);
});

test('late terminal read results are discarded after removal or disposal', async () => {
  for (const disposition of ['removed', 'disposed']) {
    const resource = terminalScreen();
    const pending = Promise.withResolvers();
    let current = true;
    const reading = readTerminalScreen(resource.screen, {
      client: { request: () => pending.promise },
      isCurrent: () => current,
      fail: (error) => assert.fail(String(error)),
      refresh: async () => assert.fail('Late results must not refresh sessions.'),
    });
    if (disposition === 'removed') {
      current = false;
    } else {
      disposeTerminalScreen(resource.screen);
    }
    pending.resolve({
      reset: true,
      frames: [{ seq: 1, data: 'late' }],
      exited: true,
      exitCode: 0,
    });
    await reading;
    assert.deepEqual(resource.writes, []);
    assert.deepEqual(resource.lines, []);
    assert.equal(resource.screen.polling, false);
  }
});

test('disposal during an xterm write callback prevents later frames and exit rendering', async () => {
  const resource = terminalScreen();
  let finishWrite;
  resource.screen.term.write = (text, done) => {
    resource.writes.push(text);
    finishWrite = done;
  };
  const reading = readTerminalScreen(resource.screen, {
    client: {
      request: async () => ({
        frames: [
          { seq: 1, data: 'first' },
          { seq: 2, data: 'late' },
        ],
        exited: true,
        exitCode: 0,
      }),
    },
    isCurrent: () => true,
    fail: (error) => assert.fail(String(error)),
    refresh: async () => assert.fail('Disposed reads must not refresh.'),
  });
  await flush();
  assert.equal(typeof finishWrite, 'function');
  disposeTerminalScreen(resource.screen);
  finishWrite();
  await reading;
  assert.deepEqual(resource.writes, ['first']);
  assert.deepEqual(resource.lines, []);
  assert.equal(resource.screen.after, 0);
  assert.equal(resource.screen.info.exited, false);
  assert.equal(resource.screen.exitShown, false);
  assert.equal(resource.screen.polling, false);
});

test('terminal cleanup continues after subscription, widget, and DOM disposal failures', (context) => {
  const resource = terminalScreen();
  const warnings = [];
  context.mock.method(console, 'warn', (...args) => warnings.push(args));
  bindTerminalInput(resource.screen, {
    client: { request: async () => ({}) },
    isCurrent: () => true,
    fail: (error) => assert.fail(String(error)),
  });
  resource.screen.disposables.unshift({
    dispose() {
      resource.disposed.push('throwing subscription');
      throw new Error('Subscription disposal failed.');
    },
  });
  resource.screen.term.dispose = () => {
    resource.disposed.push('terminal');
    throw new Error('Terminal disposal failed.');
  };
  resource.screen.el.remove = () => {
    resource.disposed.push('element');
    throw new Error('Element removal failed.');
  };

  assert.doesNotThrow(() => disposeTerminalScreen(resource.screen));
  assert.doesNotThrow(() => disposeTerminalScreen(resource.screen));
  assert.deepEqual(resource.disposed, [
    'throwing subscription',
    'osc',
    'data',
    'resize',
    'terminal',
    'element',
  ]);
  assert.equal(getEventListeners(resource.screen.el, 'paste').length, 0);
  assert.deepEqual(resource.screen.disposables, []);
  assert.equal(resource.screen.disposed, true);
  assert.equal(resource.screen.failed, true);
  assert.deepEqual(
    warnings.map((warning) => warning[1].message),
    ['Subscription disposal failed.', 'Terminal disposal failed.', 'Element removal failed.'],
  );
});

for (const disposition of ['live', 'removed', 'disposed']) {
  test('terminal resize rejection belongs only to the current live screen: ' + disposition, async () => {
    const resource = terminalScreen();
    const pending = Promise.withResolvers();
    const calls = [];
    const failures = [];
    let current = true;
    bindTerminalInput(resource.screen, {
      client: {
        request: (method, params) => {
          calls.push({ method, params });
          return pending.promise;
        },
      },
      isCurrent: () => current,
      fail: (error) => failures.push(error),
    });
    resource.handlers.resize({ cols: 90, rows: 30 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'terminal.resize');
    if (disposition === 'removed') {
      current = false;
    } else if (disposition === 'disposed') {
      disposeTerminalScreen(resource.screen);
    }
    const error = new Error('Resize failed.');
    pending.reject(error);
    await flush();

    if (disposition === 'live') {
      assert.deepEqual(failures, [error]);
    } else {
      assert.deepEqual(failures, []);
      resource.handlers.resize({ cols: 80, rows: 24 });
      assert.equal(calls.length, 1);
    }
    disposeTerminalScreen(resource.screen);
  });

  test(
    'clipboard copy stays synchronous and its rejection is owner-bound: ' + disposition,
    async (context) => {
      const resource = terminalScreen();
      const pending = Promise.withResolvers();
      const copies = [];
      const failures = [];
      let current = true;
      const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          clipboard: {
            writeText(text) {
              copies.push(text);
              return pending.promise;
            },
          },
        },
      });
      context.after(() => {
        disposeTerminalScreen(resource.screen);
        if (originalNavigator) {
          Object.defineProperty(globalThis, 'navigator', originalNavigator);
        } else {
          Reflect.deleteProperty(globalThis, 'navigator');
        }
      });
      resource.screen.term.hasSelection = () => true;
      resource.screen.term.getSelection = () => 'selected terminal text';
      if (disposition === 'live') {
        resource.screen.info.exited = true;
      }
      bindTerminalInput(resource.screen, {
        client: { request: async () => ({}) },
        isCurrent: () => current,
        fail: (error) => failures.push(error),
      });
      let prevented = 0;
      const event = {
        type: 'keydown',
        key: 'c',
        metaKey: true,
        preventDefault() {
          prevented++;
        },
      };
      assert.equal(resource.handlers.key(event), false);
      assert.deepEqual(
        copies,
        ['selected terminal text'],
        'clipboard access starts in the gesture call stack',
      );
      assert.equal(prevented, 1);
      if (disposition === 'removed') {
        current = false;
      } else if (disposition === 'disposed') {
        disposeTerminalScreen(resource.screen);
      }
      const error = new Error('Clipboard copy failed.');
      pending.reject(error);
      await flush();

      if (disposition === 'live') {
        assert.deepEqual(failures, [error]);
      } else {
        assert.deepEqual(failures, []);
        resource.handlers.key(event);
        assert.deepEqual(copies, ['selected terminal text']);
      }
    },
  );
}

test('disposal settles a poll even when xterm never delivers its pending write callback', async (context) => {
  const resource = terminalScreen();
  const disposalError = new Error('A subscription could not be disposed.');
  const warnings = [];
  context.mock.method(console, 'warn', (...args) => warnings.push(args));
  resource.screen.disposables.push({
    dispose() {
      throw disposalError;
    },
  });
  let finishWrite;
  resource.screen.term.write = (text, done) => {
    resource.writes.push(text);
    finishWrite = done;
  };
  let settled = false;
  const reading = readTerminalScreen(resource.screen, {
    client: {
      request: async () => ({
        frames: [
          { seq: 1, data: 'pending render' },
          { seq: 2, data: 'must not render' },
        ],
        exited: true,
        exitCode: 0,
      }),
    },
    isCurrent: () => true,
    fail: (error) => assert.fail(String(error)),
    refresh: async () => assert.fail('Disposed rendering must not refresh sessions.'),
  });
  void reading.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(typeof finishWrite, 'function');
  disposeTerminalScreen(resource.screen);
  await flush();
  assert.equal(settled, true, 'disposal must release the renderer wait without a callback');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1], disposalError);
  await reading;
  assert.equal(resource.screen.polling, false);
  assert.equal(resource.screen.after, 0);
  assert.equal(resource.screen.info.exited, false);
  assert.equal(resource.screen.exitShown, false);
  assert.deepEqual(resource.screen.disposables, []);
  assert.deepEqual(resource.writes, ['pending render']);
  assert.deepEqual(resource.lines, []);

  finishWrite();
  await flush();
  assert.equal(resource.screen.after, 0, 'a late callback cannot acknowledge disposed output');
  assert.equal(resource.screen.info.exited, false);
});

test('removal during rendering cannot acknowledge a frame or display a stale shell exit', async () => {
  const resource = terminalScreen();
  let finishWrite;
  let current = true;
  resource.screen.term.write = (text, done) => {
    resource.writes.push(text);
    finishWrite = done;
  };
  const reading = readTerminalScreen(resource.screen, {
    client: {
      request: async () => ({ frames: [{ seq: 4, data: 'old screen' }], exited: true, exitCode: 0 }),
    },
    isCurrent: () => current,
    fail: (error) => assert.fail(String(error)),
    refresh: async () => assert.fail('Removed screens must not refresh sessions.'),
  });
  await flush();
  current = false;
  finishWrite();
  await reading;

  assert.equal(resource.screen.after, 0);
  assert.equal(resource.screen.info.exited, false);
  assert.equal(resource.screen.exitShown, false);
  assert.equal(resource.screen.polling, false);
  assert.deepEqual(resource.screen.disposables, []);
  assert.deepEqual(resource.lines, []);
  disposeTerminalScreen(resource.screen);
});

test('terminal render waits release their temporary disposable after success or a synchronous write error', async () => {
  const resource = terminalScreen();
  const failures = [];
  bindTerminalInput(resource.screen, {
    client: { request: async () => ({}) },
    isCurrent: () => true,
    fail: (error) => assert.fail(String(error)),
  });
  const subscriptions = [...resource.screen.disposables];
  const renderError = new Error('Terminal rendering failed.');
  const dependencies = {
    client: { request: async () => ({ frames: [{ seq: 1, data: 'rendered' }], exited: false }) },
    isCurrent: () => true,
    fail: (error) => failures.push(error),
    refresh: async () => {},
  };
  await readTerminalScreen(resource.screen, dependencies);
  assert.equal(resource.screen.after, 1);
  assert.deepEqual(resource.screen.disposables, subscriptions);
  resource.screen.term.write = () => {
    throw renderError;
  };
  dependencies.client.request = async () => ({
    frames: [{ seq: 2, data: 'failed render' }],
    exited: true,
    exitCode: 0,
  });
  await readTerminalScreen(resource.screen, dependencies);

  assert.equal(resource.screen.after, 1);
  assert.equal(resource.screen.polling, false);
  assert.equal(resource.screen.failed, true);
  assert.equal(resource.screen.term.options.disableStdin, true);
  assert.equal(resource.screen.info.exited, false);
  assert.deepEqual(resource.screen.disposables, subscriptions);
  assert.deepEqual(failures, [renderError]);
  disposeTerminalScreen(resource.screen);
});

test('failed terminal input is not retried and later queued input drains without replay', async () => {
  const resource = terminalScreen();
  const pending = Promise.withResolvers();
  const calls = [];
  const failures = [];
  bindTerminalInput(resource.screen, {
    client: {
      request: (method, params) => {
        calls.push({ method, params });
        return pending.promise;
      },
    },
    isCurrent: () => true,
    fail: (error) => failures.push(error),
  });
  resource.handlers.data('x'.repeat(20000));
  resource.handlers.data('later queued input');
  await flush();
  assert.equal(calls.length, 1);
  const error = new Error('Input acknowledgement lost.');
  pending.reject(error);
  await resource.screen.tail;
  resource.handlers.data('input after failure');
  await resource.screen.tail;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'terminal.write');
  assert.equal(calls[0].params.data.length, 8192);
  assert.equal(resource.screen.pending, 0);
  assert.equal(resource.screen.failed, true);
  assert.equal(resource.screen.term.options.disableStdin, true);
  assert.deepEqual(failures, [error]);
  disposeTerminalScreen(resource.screen);
});

test('file preview uses reactive props and discards older RPC results', async (context) => {
  const created = [];
  const revoked = [];
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  context.mock.method(URL, 'createObjectURL', (blob) => {
    const url = createObjectURL(blob);
    created.push(url);
    return url;
  });
  context.mock.method(URL, 'revokeObjectURL', (url) => {
    revoked.push(url);
    revokeObjectURL(url);
  });
  const earlier = Promise.withResolvers();
  const later = Promise.withResolvers();
  const calls = [];
  const owner = createRoot((dispose) => {
    const [path, setPath] = createSignal('first.txt');
    const preview = createFilePreview({
      workerId: 'worker_1',
      get path() {
        return path();
      },
      rpc: (method, params) => {
        calls.push({ method, params });
        if (params.path === 'first.txt') {
          return earlier.promise;
        }
        return later.promise;
      },
    });
    return { dispose, setPath, preview };
  });
  try {
    await flush();
    assert.equal(calls.length, 1);
    owner.setPath('second.txt');
    await flush();
    later.resolve(assetChunk('second.txt', 'Current source'));
    await waitFor(() => !owner.preview.loading(), 'the current file preview');
    assert.equal(owner.preview.asset()?.path, 'second.txt');
    assert.equal(owner.preview.source(), 'Current source');
    assert.equal(owner.preview.hash().length, 64);
    assert.equal(owner.preview.loading(), false);
    earlier.resolve(assetChunk('first.txt', 'Outdated source'));
    await flush();
    assert.equal(owner.preview.source(), 'Current source');
    assert.equal(owner.preview.error(), '');
    assert.equal(created.length, 1);
  } finally {
    owner.dispose();
  }
  assert.deepEqual(revoked, created);
});

test('file preview owner cleanup aborts unfinished chunk streaming without creating an object URL', async (context) => {
  const pending = Promise.withResolvers();
  let requests = 0;
  context.mock.method(URL, 'createObjectURL', () => assert.fail('Disposed previews must not create URLs.'));
  const owner = createRoot((dispose) => {
    const preview = createFilePreview({
      workerId: 'worker_1',
      path: 'pending.txt',
      rpc: () => {
        requests++;
        return pending.promise;
      },
    });
    return { preview, dispose };
  });
  await flush();
  owner.dispose();
  pending.resolve({ ...assetChunk('pending.txt', 'a'), size: 2, eof: false });
  await flush();
  assert.equal(requests, 1);
  assert.equal(owner.preview.asset(), undefined);
  assert.equal(owner.preview.error(), '');
});

function audioFixture(context) {
  const instances = [];
  class AudioResource {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    closes = 0;
    oscillator;
    resumed = Promise.resolve();

    constructor() {
      instances.push(this);
    }
    async resume() {
      await this.resumed;
      this.state = 'running';
    }
    async close() {
      this.closes++;
      this.state = 'closed';
    }
    createGain() {
      return {
        connect() {},
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
      };
    }
    createOscillator() {
      this.oscillator = {
        frequency: { value: 0 },
        connect() {},
        start() {},
        stop() {},
        onended: undefined,
      };
      return this.oscillator;
    }
  }
  const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: AudioResource,
  });
  context.after(() => {
    if (originalAudioContext) {
      Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
    } else {
      delete globalThis.AudioContext;
    }
  });
  return instances;
}

test('task sound closes its audio resource when the oscillator ends and does not close twice on owner cleanup', async (context) => {
  const instances = audioFixture(context);
  const owner = createRoot((dispose) => ({ dispose, play: createTaskSound() }));
  await owner.play();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].oscillator.frequency.value, 880);
  instances[0].oscillator.onended();
  await flush();
  owner.dispose();
  assert.equal(instances[0].closes, 1);
  await owner.play();
  assert.equal(instances.length, 1);
});

test('task sound cleanup closes an active chime even when the ended event never arrives', async (context) => {
  const instances = audioFixture(context);
  const owner = createRoot((dispose) => ({ dispose, play: createTaskSound() }));
  await owner.play();
  owner.dispose();
  await flush();
  assert.equal(instances[0].state, 'closed');
  assert.equal(instances[0].closes, 1);
});

test('task sound closes a resource if audio resume fails', async (context) => {
  const instances = audioFixture(context);
  const warnings = [];
  context.mock.method(console, 'warn', (...arguments_) => warnings.push(arguments_));
  context.mock.method(globalThis.AudioContext.prototype, 'resume', async () => {
    throw new Error('Audio access denied');
  });
  const owner = createRoot((dispose) => ({ dispose, play: createTaskSound() }));
  await owner.play();
  owner.dispose();
  assert.equal(instances[0].closes, 1);
  assert.equal(instances[0].oscillator, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /could not play/);
});

test('task sound disposed during resume never creates an oscillator afterward', async (context) => {
  const instances = audioFixture(context);
  const resumed = Promise.withResolvers();
  context.mock.method(globalThis.AudioContext.prototype, 'resume', () => resumed.promise);
  const owner = createRoot((dispose) => ({ dispose, play: createTaskSound() }));
  const playing = owner.play();
  assert.equal(instances.length, 1);
  owner.dispose();
  resumed.resolve();
  await playing;
  assert.equal(instances[0].oscillator, undefined);
  assert.equal(instances[0].closes, 1);
});

test('reloading a completed file preview revokes its previous Blob URL before installing the next', async (context) => {
  const created = [];
  const revoked = [];
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  context.mock.method(URL, 'createObjectURL', (blob) => {
    const url = createObjectURL(blob);
    created.push(url);
    return url;
  });
  context.mock.method(URL, 'revokeObjectURL', (url) => {
    revoked.push(url);
    revokeObjectURL(url);
  });
  const owner = createRoot((dispose) => ({
    dispose,
    preview: createFilePreview({
      workerId: 'worker_1',
      path: 'source.txt',
      rpc: async () => assetChunk('source.txt', 'Source'),
    }),
  }));
  try {
    await waitFor(() => !owner.preview.loading(), 'the first completed preview');
    assert.equal(created.length, 1);
    owner.preview.setReload((revision) => revision + 1);
    await waitFor(() => created.length === 2 && !owner.preview.loading(), 'the reloaded preview');
    assert.deepEqual(revoked, [created[0]]);
    assert.equal(owner.preview.url(), created[1]);
  } finally {
    owner.dispose();
  }
  assert.deepEqual(revoked, created);
});

test('terminal input backpressure fails closed rather than dropping excess keystrokes', async () => {
  const resource = terminalScreen();
  const errors = [];
  const calls = [];
  bindTerminalInput(resource.screen, {
    client: { request: async (method) => calls.push(method) },
    isCurrent: () => true,
    fail: (error) => errors.push(error),
  });
  resource.handlers.data('x'.repeat(65537));
  await resource.screen.tail;
  assert.equal(resource.screen.failed, true);
  assert.equal(resource.screen.term.options.disableStdin, true);
  assert.equal(resource.screen.pending, 0);
  assert.deepEqual(calls, []);
  assert.match(errors[0].message, /Input stopped rather than silently dropping keystrokes/);
  disposeTerminalScreen(resource.screen);
});
