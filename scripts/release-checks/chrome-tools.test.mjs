import assert from 'node:assert/strict';

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { rolldown } from 'rolldown';
import { buildBrowserFixture, FIXTURE_STYLESHEET_SLOT } from '../../apps/extension/test/browser/build.mjs';
import { buildChromeFixture } from './chrome-prepare.mjs';
import { withPreviewFrame } from './chrome-preview.mjs';
import { ChromePipe, browserEnvironment } from './chrome-pipe.mjs';
import {
  chromeDiagnosticsSchema,
  chromeLogNameSchema,
  attentionLayoutSchema,
  evaluationSchema,
  extensionIdSchema,
  fixtureStateSchema,
  nativeCheckSchema,
  pageNavigationSchema,
  previewFixtureSchema,
  previewFrameTreeSchema,
  previewProbeSchema,
  browserTargetsSchema,
  previewWorldSchema,
  protocolMessageSchema,
  protocolRequestSchema,
  targetCloseSchema,
} from './chrome-schemas.mjs';
import {
  click,
  evaluate,
  page,
  press,
  waitFor,
  assertAttentionLayout,
  checkAttentionLayout,
} from './chrome-ui.mjs';

function protocolFixture() {
  const sent = [];
  const pipe = Object.assign(Object.create(ChromePipe.prototype), {
    pending: new Map(),
    events: [],
    sequence: 0,
    buffer: '',
    failure: undefined,
    input: {
      write(text, callback) {
        sent.push(protocolRequestSchema.parse(JSON.parse(text.slice(0, -1))));
        callback();
      },
    },
  });

  return { pipe, sent };
}

function attentionGeometry() {
  return {
    viewport: { width: 320, height: 420 },
    project: {
      rect: { left: 0, top: 0, right: 320, bottom: 200 },
      clientWidth: 320,
      scrollWidth: 320,
    },
    status: { left: 0, top: 20, right: 320, bottom: 120 },
    statusLabel: { left: 16, top: 25, right: 130, bottom: 45 },
    summary: { left: 16, top: 48, right: 304, bottom: 110 },
    summaryLines: [
      { left: 16, top: 48, right: 280, bottom: 65 },
      { left: 16, top: 70, right: 290, bottom: 87 },
      { left: 16, top: 93, right: 260, bottom: 110 },
    ],
    reason: 'Check the linked chat before resending. Completed actions must not be replayed.',
    role: 'status',
    live: 'polite',
    runner: { left: 0, top: 120, right: 320, bottom: 210 },
    runnerItems: [
      { text: 'Resend prompt…', tag: 'BUTTON', rect: { left: 16, top: 130, right: 140, bottom: 158 } },
      { text: 'Watching for reply', tag: 'SPAN', rect: { left: 152, top: 130, right: 300, bottom: 148 } },
      { text: 'Stop', tag: 'BUTTON', rect: { left: 16, top: 170, right: 75, bottom: 198 } },
      { text: '3/15 turns', tag: 'SPAN', rect: { left: 86, top: 170, right: 160, bottom: 188 } },
      { text: 'Open chat', tag: 'BUTTON', rect: { left: 170, top: 170, right: 260, bottom: 198 } },
    ],
    recovery: { left: 0, top: 210, right: 320, bottom: 290 },
    recoveryItems: [
      { text: 'Use reply…', tag: 'BUTTON', rect: { left: 16, top: 216, right: 90, bottom: 244 } },
      { text: 'Show details', tag: 'BUTTON', rect: { left: 100, top: 216, right: 182, bottom: 244 } },
      { text: 'Copy diagnostics', tag: 'BUTTON', rect: { left: 16, top: 254, right: 137, bottom: 282 } },
    ],
    error: null,
    editor: { left: 0, top: 290, right: 320, bottom: 323 },
    console: { left: 0, top: 200, right: 320, bottom: 420 },
    domOrder: true,
  };
}

function reply(pipe, message) {
  pipe.receive(JSON.stringify(message) + '\0');
}

test('evaluation accepts Chrome’s absent value for undefined and preserves JSON values', () => {
  const empty = evaluationSchema.parse({ result: { type: 'undefined' } });
  assert.equal(empty.result.value, undefined);

  for (const value of [null, false, 0, '', ['value'], { value: 'checked by caller' }]) {
    const result = evaluationSchema.parse({ result: { type: 'object', value } });
    assert.deepEqual(result.result.value, value);
  }

  assert.equal(evaluationSchema.safeParse({}).success, false);
  assert.equal(evaluationSchema.safeParse({ result: {} }).success, false);
});

test('evaluation rejects non-JSON values and unknown driver value kinds', async () => {
  for (const value of [Infinity, NaN, { callback: () => {} }, { missing: undefined }, new Map()]) {
    assert.equal(evaluationSchema.safeParse({ result: { type: 'object', value } }).success, false);
  }
  assert.equal(evaluationSchema.safeParse({ result: { type: 'invented', value: 1 } }).success, false);

  const chrome = { request: async () => ({ result: { type: 'boolean', value: 'truthy' } }) };
  await assert.rejects(waitFor(chrome, 'session', 'condition()', 'fixture readiness'), (error) => {
    assert.match(error.message, /Expected a boolean condition/);
    assert.equal(error.cause.name, 'ZodError');

    return true;
  });
});

test('Chrome extension IDs, navigation and target closure results are validated', async () => {
  assert.equal(extensionIdSchema.safeParse({ id: 'a'.repeat(32) }).success, true);

  for (const id of ['', 'q'.repeat(32), 'a'.repeat(31), 'chrome-extension://' + 'a'.repeat(32) + '/']) {
    assert.equal(extensionIdSchema.safeParse({ id }).success, false);
  }
  assert.equal(targetCloseSchema.safeParse({ success: true }).success, true);
  assert.equal(targetCloseSchema.safeParse({ success: false }).success, false);
  assert.equal(pageNavigationSchema.safeParse({ frameId: 'frame', errorText: 123 }).success, false);

  for (const navigation of [{ frameId: 'frame' }, { frameId: 'frame', errorText: 'net::ERR_BLOCKED' }, {}]) {
    const chrome = {
      async request(method) {
        if (method === 'Target.createTarget') {
          return { targetId: 'target' };
        }
        if (method === 'Target.attachToTarget') {
          return { sessionId: 'session' };
        }
        if (method === 'Page.navigate') {
          return navigation;
        }
        if (method === 'Runtime.evaluate') {
          return { result: { type: 'boolean', value: true } };
        }

        return {};
      },
    };

    if ('errorText' in navigation) {
      await assert.rejects(page(chrome, 'chrome-extension://fixture/workspace.html'), /net::ERR_BLOCKED/);
    } else if (!('frameId' in navigation)) {
      await assert.rejects(
        page(chrome, 'chrome-extension://fixture/workspace.html'),
        /navigation acknowledgement/,
      );
    } else {
      assert.deepEqual(await page(chrome, 'chrome-extension://fixture/workspace.html'), {
        targetId: 'target',
        session: 'session',
      });
    }
  }
});

test('browser evaluation errors preserve exception details rather than failing on absent value', async () => {
  const details = { text: 'Controlled browser exception.', lineNumber: 1 };
  const chrome = {
    async request(method, parameters, session) {
      assert.equal(method, 'Runtime.evaluate');
      assert.equal(session, 'owned-session');
      assert.equal(parameters.awaitPromise, true);
      assert.equal(parameters.returnByValue, true);
      return { result: { type: 'object' }, exceptionDetails: details };
    },
  };

  await assert.rejects(evaluate(chrome, 'owned-session', 'throw new Error("Controlled")'), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Browser expression failed/);
    assert.deepEqual(error.cause, details);
    return true;
  });
});

test('void browser actions complete without inventing a returned JSON value', async () => {
  const chrome = { request: async () => ({ result: { type: 'undefined' } }) };
  assert.equal(await evaluate(chrome, 'session', 'document.body.focus()'), undefined);
});

test('control selectors retain their exact quotes and escaping in browser expressions', async () => {
  for (const selector of ['.health-button', '[data-value="quotes \\" and newline\\n"]']) {
    let clicked = false;
    class Control {
      click() {
        clicked = true;
      }
    }

    const chrome = {
      async request(method, parameters) {
        assert.equal(method, 'Runtime.evaluate');
        runInNewContext(parameters.expression, {
          HTMLElement: Control,
          document: {
            querySelector(actual) {
              assert.equal(actual, selector);
              return new Control();
            },
          },
        });
        return { result: { type: 'undefined' } };
      },
    };

    await click(chrome, 'session', selector);
    assert.equal(clicked, true);
  }
});

test('Enter dispatch includes character text for native button activation, but Escape does not', async () => {
  const commands = [];
  const chrome = {
    async request(method, parameters, session) {
      assert.equal(method, 'Input.dispatchKeyEvent');
      assert.equal(session, 'owned-session');
      commands.push(parameters);
      return {};
    },
  };

  await press(chrome, 'owned-session', 'Enter', 13);
  assert.equal(commands[0].type, 'keyDown');
  assert.equal(commands[0].text, '\r');
  assert.equal(commands[0].unmodifiedText, '\r');
  assert.equal(commands[1].type, 'keyUp');
  assert.equal(commands[1].text, undefined);

  commands.length = 0;
  await press(chrome, 'owned-session', 'Escape', 27);
  assert.equal(commands[0].text, undefined);
  assert.equal(commands[1].text, undefined);
});

test('pipe matches fragmented and coalesced replies to the original requests', async () => {
  const { pipe, sent } = protocolFixture();
  const first = pipe.request('First', { value: 'π' }, 'session');
  const second = pipe.request('Second');
  assert.deepEqual(sent, [
    { id: 1, method: 'First', params: { value: 'π' }, sessionId: 'session' },
    { id: 2, method: 'Second', params: {} },
  ]);
  const response = JSON.stringify({ id: 1, result: { text: 'π' }, sessionId: 'session' });
  pipe.receive(response.slice(0, 10));
  assert.equal(pipe.pending.size, 2);
  pipe.receive(response.slice(10) + '\0' + JSON.stringify({ id: 2, result: {} }) + '\0');
  assert.deepEqual(await first, { text: 'π' });
  assert.deepEqual(await second, {});
  assert.equal(pipe.pending.size, 0);
  assert.equal(pipe.buffer, '');
});

test('pipe validates serialized commands before reserving timers or sending bytes', async () => {
  const { pipe, sent } = protocolFixture();

  for (const [method, params, session] of [
    ['', {}, undefined],
    ['Valid', null, undefined],
    ['Valid', { callback: () => {} }, undefined],
    ['Valid', { value: undefined }, undefined],
    ['Valid', { value: Infinity }, undefined],
    ['Valid', {}, ''],
  ]) {
    await assert.rejects(pipe.request(method, params, session), (error) => {
      assert.match(error.message, /Invalid Chrome command/);
      assert.equal(error.cause.name, 'ZodError');

      return true;
    });
  }

  assert.equal(pipe.pending.size, 0);
  assert.equal(pipe.sequence, 0);
  assert.deepEqual(sent, []);
});

test('pipe refuses a same-number reply from a different debugging session', async () => {
  const { pipe } = protocolFixture();
  const current = pipe.request('Current', {}, 'owned-session');
  let failure;

  try {
    reply(pipe, { id: 1, result: { stale: true }, sessionId: 'replacement-session' });
  } catch (error) {
    failure = error;
    pipe.fail(error);
  }

  assert.match(failure.message, /different debugging session/);
  await assert.rejects(current, (error) => error === failure);
  assert.equal(pipe.pending.size, 0);
});

test('pipe rejection releases a failed command and keeps Chrome’s error message', async () => {
  const { pipe } = protocolFixture();
  const request = pipe.request('Extensions.loadUnpacked');
  reply(pipe, { id: 1, error: { code: -32000, message: 'Developer mode unavailable.' } });
  await assert.rejects(request, /Extensions.loadUnpacked: Developer mode unavailable/);
  assert.equal(pipe.pending.size, 0);
});

test('transport failure rejects every pending request and prevents later commands', async () => {
  const { pipe, sent } = protocolFixture();
  const first = pipe.request('First');
  const second = pipe.request('Second');
  const settled = Promise.allSettled([first, second]);
  const failure = new Error('Controlled transport failure.');
  pipe.buffer = 'unfinished reply';
  pipe.fail(failure);

  for (const result of await settled) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, failure);
  }

  assert.equal(pipe.pending.size, 0);
  assert.equal(pipe.buffer, '');
  await assert.rejects(pipe.request('Later'), (error) => error === failure);
  assert.equal(sent.length, 2);
});

test('unmatched late replies cannot settle new work', async () => {
  const { pipe } = protocolFixture();
  reply(pipe, { id: 999, result: { stale: true } });
  const request = pipe.request('Current');
  reply(pipe, { id: 999, result: { stale: true } });
  assert.equal(pipe.pending.size, 1);
  reply(pipe, { id: 1, result: { current: true } });
  assert.deepEqual(await request, { current: true });
});

test('debugging receive buffer is byte-bounded and malformed envelopes are rejected', () => {
  const { pipe } = protocolFixture();
  assert.throws(() => pipe.receive('π'.repeat(4 * 1024 * 1024 + 1)), /8 MB safety limit/);
  pipe.fail(new Error('Discard oversized fixture.'));
  assert.equal(pipe.buffer, '');

  const malformed = protocolFixture().pipe;
  assert.throws(() => malformed.receive('{broken}\0'));
  assert.equal(protocolMessageSchema.safeParse({ id: -1, result: {} }).success, false);
  assert.equal(protocolMessageSchema.safeParse({ id: 1, result: null }).success, false);
  assert.equal(
    protocolMessageSchema.safeParse({ id: 1, error: { message: 'Missing error code.' } }).success,
    false,
  );
});

test('protocol envelopes reject ambiguous replies, invalid event IDs and non-JSON payloads', () => {
  for (const message of [
    { id: 1, result: {}, error: { code: -1, message: 'Both reply kinds.' } },
    { id: 1, result: {}, method: 'Log.entryAdded' },
    { id: -1, method: 'Log.entryAdded', params: {} },
    { method: 'Log.entryAdded', result: {} },
    { method: 'Log.entryAdded', error: { code: -1, message: 'Not an event.' } },
    { id: 1, result: { value: Infinity } },
    { id: 1, result: { callback: () => {} } },
  ]) {
    assert.equal(protocolMessageSchema.safeParse(message).success, false);
  }

  const { pipe } = protocolFixture();
  assert.throws(
    () => {
      reply(pipe, { id: 1, result: {}, error: { code: -1, message: 'Ambiguous.' } });
    },
    (error) => {
      assert.match(error.message, /Invalid Chrome debugging message/);
      assert.equal(error.cause.name, 'ZodError');

      return true;
    },
  );
});

test('fixture observations accept the production JSON shape and reject malformed retained state', () => {
  const observation = {
    dialogs: 1,
    title: 'Project',
    sameTreeLabel: true,
    activeId: 'project-root',
    replacementDraft: '',
    fields: [{ value: '', userInvalid: true, ariaInvalid: 'true', focused: true }],
    alerts: [{ text: 'Controlled failure.', visible: true }],
    busy: true,
    pendingSaves: [{ id: 1, name: 'Fixture', root: '/controlled/project' }],
    closes: 0,
    navigation: '',
    preview: { bytes: 0, url: '', source: '', error: '', loading: false },
    fontCount: 0,
    fontReady: false,
    savedFonts: 0,
    systemFonts: 0,
    fontErrors: [],
  };

  assert.deepEqual(fixtureStateSchema.parse(observation), observation);
  assert.equal(fixtureStateSchema.safeParse({}).success, false);

  for (const changes of [
    { dialogs: -1 },
    { preview: { ...observation.preview, bytes: -1 } },
    { fields: [{ ...observation.fields[0], ariaInvalid: false }] },
    { pendingSaves: [{ ...observation.pendingSaves[0], id: 1.5 }] },
    { fontErrors: [123] },
    { extra: true },
  ]) {
    assert.equal(fixtureStateSchema.safeParse({ ...observation, ...changes }).success, false);
  }
});

test('attention geometry accepts finite wrapped rows and rejects malformed or unbounded observations', () => {
  const geometry = attentionGeometry();
  assert.deepEqual(attentionLayoutSchema.parse(geometry), geometry);
  assert.deepEqual(assertAttentionLayout(geometry), geometry);

  for (const changes of [
    { status: { ...geometry.status, bottom: NaN } },
    { summary: { ...geometry.summary, right: Infinity } },
    { runner: { ...geometry.runner, bottom: geometry.runner.top } },
    { summaryLines: [] },
    { summaryLines: Array(513).fill(geometry.summary) },
    { runnerItems: [{ ...geometry.runnerItems[0], tag: 'DIV' }] },
    { recoveryItems: [] },
    { viewport: { width: 320, height: -1 } },
    { project: { ...geometry.project, scrollWidth: 1.5 } },
    { reason: 'x'.repeat(4097) },
    { extra: true },
  ]) {
    assert.equal(attentionLayoutSchema.safeParse({ ...geometry, ...changes }).success, false);
  }
});

test('attention assertions catch collapsed status, clipped text, overlapping controls and changed reading order', () => {
  const geometry = attentionGeometry();
  for (const changes of [
    { status: { ...geometry.status, bottom: 55 } },
    { summaryLines: [{ ...geometry.summaryLines[0], bottom: 130 }] },
    { status: { ...geometry.status, bottom: 140 } },
    { runner: { ...geometry.runner, bottom: 170 } },
    { runnerItems: geometry.runnerItems.map((item) => ({ ...item, rect: geometry.runnerItems[0].rect })) },
    { recovery: { ...geometry.recovery, right: 120 } },
    {
      recoveryItems: geometry.recoveryItems.map((item) => ({
        ...item,
        rect: geometry.recoveryItems[0].rect,
      })),
    },
    { recovery: { ...geometry.recovery, top: 200 } },
    { editor: { ...geometry.editor, top: 280 } },
    { error: { left: 16, top: 110, right: 304, bottom: 150 } },
    { project: { ...geometry.project, scrollWidth: 340 } },
    { role: null },
    { live: 'off' },
    { domOrder: false },
  ]) {
    assert.throws(() => assertAttentionLayout({ ...geometry, ...changes }), assert.AssertionError);
  }
});

test('attention live-check failure disposes only its fixture and always clears owned device emulation', async () => {
  const commands = [];
  const chrome = {
    async request(method, parameters, session) {
      assert.equal(session, 'owned-attention-session');
      commands.push({ method, parameters });
      if (method === 'Runtime.evaluate' && parameters.expression.includes('summaryLines')) {
        const geometry = attentionGeometry();
        geometry.status.bottom = 55;
        return { result: { type: 'object', value: geometry } };
      }
      if (method === 'Runtime.evaluate' && parameters.expression.includes('aria-atomic')) {
        return { result: { type: 'boolean', value: true } };
      }
      return { result: { type: 'undefined' } };
    },
  };

  await assert.rejects(checkAttentionLayout(chrome, 'owned-attention-session'), /full attention reason/);
  assert.equal(
    commands.filter((command) => command.method === 'Emulation.setDeviceMetricsOverride').length,
    1,
  );
  assert.ok(
    commands.some((command) => command.parameters.expression === 'window.mitterReleaseFixture.dispose()'),
  );
  assert.equal(commands.at(-1).method, 'Emulation.clearDeviceMetricsOverride');
  assert.deepEqual(commands.at(-1).parameters, {});
});

test('attention checks stop scheduling browser work when their time budget expires', async (context) => {
  let readings = 0;
  context.mock.method(Date, 'now', () => {
    readings++;
    if (readings === 1) {
      return 0;
    }
    return 20000;
  });
  const commands = [];
  const chrome = {
    async request(method, parameters, session) {
      assert.equal(session, 'owned-attention-session');
      commands.push({ method, parameters });
      return { result: { type: 'undefined' } };
    },
  };

  await assert.rejects(checkAttentionLayout(chrome, 'owned-attention-session'), /20-second limit/);
  assert.equal(
    commands.filter((command) => command.method === 'Emulation.setDeviceMetricsOverride').length,
    0,
  );
  assert.equal(commands[0].parameters.expression, 'window.mitterReleaseFixture.dispose()');
  assert.equal(commands.at(-1).method, 'Emulation.clearDeviceMetricsOverride');
});

test('attention cleanup clears owned emulation even when fixture disposal itself fails', async () => {
  const commands = [];
  const chrome = {
    async request(method, parameters, session) {
      assert.equal(session, 'owned-attention-session');
      commands.push(method);
      if (
        method === 'Runtime.evaluate' &&
        parameters.expression === 'window.mitterReleaseFixture.dispose()'
      ) {
        return { result: { type: 'undefined' }, exceptionDetails: { text: 'Controlled disposal failure.' } };
      }
      if (method === 'Runtime.evaluate' && parameters.expression.includes('summaryLines')) {
        return { result: { type: 'object', value: {} } };
      }
      return { result: { type: 'undefined' } };
    },
  };

  await assert.rejects(checkAttentionLayout(chrome, 'owned-attention-session'), /dispose/);
  assert.equal(commands.at(-1), 'Emulation.clearDeviceMetricsOverride');
});

test('only diagnostic events are retained and retention has a hard limit', () => {
  const { pipe } = protocolFixture();
  reply(pipe, { method: 'Page.frameNavigated', params: {} });
  assert.equal(pipe.events.length, 0);

  for (let index = 0; index < 100; index++) {
    reply(pipe, { method: 'Log.entryAdded', params: { index } });
  }

  assert.equal(pipe.events.length, 100);
  assert.throws(
    () => reply(pipe, { method: 'Runtime.exceptionThrown', params: {} }),
    /too many runtime errors/,
  );
});

test('browser environment cannot inherit user state, preload code or proxy configuration', () => {
  const directory = '/owned/chrome';
  const env = browserEnvironment(directory, {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    HOME: '/real/home',
    USERPROFILE: '/real/home',
    MITTER_HOME: '/real/state',
    NODE_OPTIONS: '--import=/real/preload.mjs',
    NODE_PATH: '/real/modules',
    HTTP_PROXY: 'https://external-proxy',
    XDG_CONFIG_HOME: '/real/config',
    TMPDIR: '/real/tmp',
  });

  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.LC_ALL, 'C');
  assert.equal(env.HOME, path.join(directory, 'home'));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.MITTER_HOME, path.join(directory, 'state'));
  assert.equal(env.TMPDIR, path.join(directory, 'tmp'));
  assert.equal(env.XDG_CONFIG_HOME, path.join(env.HOME, '.config'));
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
});

test('Chrome evidence logs remain confined and diagnostic reports retain validated driver events', () => {
  for (const name of ['chrome.log', 'zod-chrome-agent.log']) {
    assert.equal(chromeLogNameSchema.parse(name), name);
  }
  for (const name of [
    '',
    '../chrome.log',
    '/tmp/chrome.log',
    'nested/chrome.log',
    'nested\\chrome.log',
    '.log',
    'chrome.json',
    'chrome.log\n',
    'x'.repeat(121) + '.log',
  ]) {
    assert.equal(chromeLogNameSchema.safeParse(name).success, false);
  }
  const events = [
    {
      method: 'Runtime.exceptionThrown',
      sessionId: 'fixture-session',
      params: { exceptionDetails: { text: 'ZodError: invalid fixture stamp.' } },
    },
    { method: 'Log.entryAdded', params: { entry: { level: 'error', text: 'Module failed to initialize.' } } },
  ];
  assert.deepEqual(chromeDiagnosticsSchema.parse(events), events);
  assert.equal(chromeDiagnosticsSchema.safeParse([{}]).success, false);
  assert.equal(
    chromeDiagnosticsSchema.safeParse([...events, { method: 'Log.entryAdded', params: { data: undefined } }])
      .success,
    false,
  );
  assert.equal(
    chromeDiagnosticsSchema.safeParse(Array.from({ length: 101 }, () => events[0])).success,
    false,
  );
});

test('source CSS checks and CSS-free release fixture modules retain canonical preview stamps and no eval', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mitter-chrome-fixture-test-'));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const original = await buildBrowserFixture(directory);
  const originalScript = await readFile(original.script, 'utf8');
  const originalHTML = await readFile(original.html, 'utf8');
  const originalStyle = await readFile(original.style, 'utf8');
  const taskLayout = originalStyle.match(/\.task-layout\s*\{([^}]+)\}/)?.[1];
  assert.ok(taskLayout);
  assert.match(taskLayout, /min-height:\s*0\s*;/);
  assert.match(originalStyle, /\.task-scroll\s*\{[^}]*overflow:\s*auto\s*;/);
  assert.match(originalStyle, /\.bridge-note\s*\{[^}]*flex-wrap:\s*wrap\s*;/);
  class Element {
    addEventListener() {}
  }
  class Button extends Element {}
  const root = new Element();
  const opener = new Button();
  const document = {
    addEventListener() {},
    getElementById(id) {
      if (id === 'fixture-root') {
        return root;
      }
      if (id === 'fixture-open-project') {
        return opener;
      }
      return null;
    },
  };
  const window = { document };
  const browser = createContext(
    { document, window, HTMLElement: Element, HTMLButtonElement: Button, btoa, URL },
    { codeGeneration: { strings: false, wasm: false } },
  );

  const fixture = await buildChromeFixture(directory);
  const script = await readFile(fixture.script, 'utf8');
  assert.equal(script, originalScript, 'Chrome preparation must not rewrite the shared fixture bundle.');
  assert.equal(fixture.style, undefined, 'Release preparation must not supply source CSS.');
  assert.equal(await readFile(original.style, 'utf8'), originalStyle);
  assert.equal(
    await readFile(fixture.html, 'utf8'),
    originalHTML
      .replace('<link rel="stylesheet" href="./fixture.css" />', FIXTURE_STYLESHEET_SLOT)
      .replace('</body>', '<script type="module" src="./chrome-preview-fixture.js"></script>\n  </body>'),
  );
  const previewScript = await readFile(path.join(directory, 'chrome-preview-fixture.js'), 'utf8');
  // Separate lexical scopes model module isolation without allowing code generation.
  runInContext('(() => { "use strict";\n' + script + '\n})()', browser);
  runInContext('(() => { "use strict";\n' + previewScript + '\n})()', browser);
  assert.equal(typeof window.mitterReleaseFixture, 'object');
  assert.equal(typeof window.mitterReleaseFixture.checkNative, 'function');
  assert.equal(typeof window.mitterReleaseFixture.mountProject, 'function');
  assert.equal(typeof window.mitterReleaseFixture.mountAttention, 'function');
  assert.deepEqual(Array.from(window.mitterReleaseFixture.attentionActions()), []);
  assert.equal(typeof window.mitterPreviewFixture, 'object');
  assert.equal(typeof window.mitterPreviewFixture.mount, 'function');
  assert.equal(previewFixtureSchema.parse(window.mitterPreviewFixture.inspect()).innerReady, 0);
});

test('preview driver schemas reject malformed identities, counters and literal HTML observations', () => {
  const fixture = {
    html: '\ufeff<p>Literal 😀</p>\r\n',
    ready: [
      { frame: 'preview', origin: 'null' },
      { frame: 'peer', origin: 'null' },
    ],
    innerReady: 1,
    innerOrigin: 'null',
    malformedSent: 8,
  };
  assert.deepEqual(previewFixtureSchema.parse(fixture), fixture);
  for (const changes of [
    { html: 'x'.repeat(4097) },
    { ready: [{ frame: 'foreign', origin: 'null' }] },
    { ready: [{ frame: 'preview', origin: null }] },
    { innerReady: -1 },
    { malformedSent: '8' },
    { extra: true },
  ]) {
    assert.equal(previewFixtureSchema.safeParse({ ...fixture, ...changes }).success, false);
  }

  const probe = {
    parentMessages: 9,
    foreignMessages: 1,
    foreignOrigin: 'null',
    installations: 1,
    frames: 1,
    html: fixture.html,
    sandbox: 'allow-scripts',
    referrerPolicy: 'no-referrer',
    title: 'Isolated local file preview',
    nativeAccess: false,
  };
  assert.deepEqual(previewProbeSchema.parse(probe), probe);
  for (const changes of [
    { frames: -1 },
    { installations: 1.5 },
    { foreignOrigin: null },
    { nativeAccess: 'false' },
    { html: 'x'.repeat(8193) },
    { extra: true },
  ]) {
    assert.equal(previewProbeSchema.safeParse({ ...probe, ...changes }).success, false);
  }

  assert.equal(
    previewFrameTreeSchema.safeParse({ frameTree: { frame: { id: '', url: '' } } }).success,
    false,
  );
  assert.equal(
    browserTargetsSchema.safeParse({ targetInfos: [{ targetId: '', type: 'iframe', url: '' }] }).success,
    false,
  );
  assert.equal(previewWorldSchema.safeParse({ executionContextId: 0 }).success, false);
  for (const schema of [previewFixtureSchema, previewProbeSchema]) {
    assert.equal(typeof schema.description, 'string');
    for (const field of Object.values(schema.shape)) {
      assert.equal(typeof field.description, 'string');
    }
  }
});

for (const outOfProcess of [false, true]) {
  test(`preview inspection selects an exact frame without extra privileges (out of process: ${outOfProcess})`, async () => {
    const url = 'chrome-extension://' + 'a'.repeat(32) + '/preview-sandbox.html?release-preview=preview';
    const commands = [];
    const chrome = {
      async request(method, parameters, session) {
        commands.push({ method, parameters, session });
        if (method === 'Target.getTargets') {
          const targetInfos = [
            { targetId: 'wrong-kind', type: 'page', url },
            { targetId: 'peer', type: 'iframe', url: url.replace('=preview', '=peer') },
            { targetId: 'prefix-spoof', type: 'iframe', url: url + '&foreign=1' },
          ];
          if (outOfProcess) {
            targetInfos.push({ targetId: 'preview-target', type: 'iframe', url });
          }
          return { targetInfos };
        }
        if (method === 'Target.attachToTarget') {
          assert.deepEqual(parameters, { targetId: 'preview-target', flatten: true });
          return { sessionId: 'sandbox-session' };
        }
        if (method === 'Page.getFrameTree') {
          const frame = { id: 'preview-frame', url };
          if (outOfProcess) {
            return { frameTree: { frame } };
          }
          return { frameTree: { frame: { id: 'parent-frame', url: 'fixture' }, childFrames: [{ frame }] } };
        }
        if (method === 'Page.createIsolatedWorld') {
          assert.deepEqual(parameters, { frameId: 'preview-frame', worldName: 'mitter-release-preview' });
          return { executionContextId: 41 };
        }
        if (method === 'Runtime.evaluate') {
          assert.equal(parameters.contextId, 41);
          return { result: { type: 'boolean', value: true } };
        }
        return {};
      },
    };
    await withPreviewFrame(chrome, 'parent-session', url, async (session, contextId) => {
      let expectedSession = 'parent-session';
      if (outOfProcess) {
        expectedSession = 'sandbox-session';
      }
      assert.equal(session, expectedSession);
      await waitFor(chrome, session, 'document.readyState === "complete"', 'preview context', contextId);
    });
    const detach = commands.filter((command) => command.method === 'Target.detachFromTarget');
    if (outOfProcess) {
      assert.deepEqual(detach, [
        {
          method: 'Target.detachFromTarget',
          parameters: { sessionId: 'sandbox-session' },
          session: undefined,
        },
      ]);
    } else {
      assert.deepEqual(detach, []);
    }
  });
}

test('preview target cleanup survives setup and assertion failures; ambiguous targets cannot be attached', async () => {
  const url = 'chrome-extension://' + 'a'.repeat(32) + '/preview-sandbox.html?release-preview=preview';
  for (const failure of ['ambiguous', 'frame', 'world', 'assertion']) {
    const commands = [];
    const chrome = {
      async request(method) {
        commands.push(method);
        if (method === 'Target.getTargets') {
          const targetInfos = [{ targetId: 'preview-target', type: 'iframe', url }];
          if (failure === 'ambiguous') {
            targetInfos.push({ targetId: 'duplicate', type: 'iframe', url });
          }
          return { targetInfos };
        }
        if (method === 'Target.attachToTarget') {
          return { sessionId: 'sandbox-session' };
        }
        if (method === 'Page.getFrameTree') {
          let frameURL = url;
          if (failure === 'frame') {
            frameURL += '&foreign=1';
          }
          return { frameTree: { frame: { id: 'frame', url: frameURL } } };
        }
        if (method === 'Page.createIsolatedWorld') {
          if (failure === 'world') {
            return { executionContextId: 'invented' };
          }
          return { executionContextId: 41 };
        }
        return {};
      },
    };
    await assert.rejects(
      withPreviewFrame(chrome, 'parent-session', url, async () => {
        assert.fail('Controlled preview assertion failure.');
      }),
    );
    if (failure === 'ambiguous') {
      assert.deepEqual(commands, ['Target.getTargets']);
    } else {
      assert.equal(commands.at(-1), 'Target.detachFromTarget');
    }
  }
});

test('local preview fixture uses canonical schemas, pins readiness sources and releases its frames', async () => {
  const bundle = await rolldown({
    input: path.join(import.meta.dirname, 'chrome-preview-fixture.mjs'),
    platform: 'browser',
  });
  let code;
  try {
    const generated = await bundle.generate({ format: 'iife', codeSplitting: false });
    code = generated.output[0]?.code;
  } finally {
    await bundle.close();
  }
  assert.equal(typeof code, 'string');
  const listeners = new Set();
  const created = [];
  const view = {
    location: { href: 'chrome-extension://' + 'a'.repeat(32) + '/workspace.html?release-fixture=1' },
    frames: [],
    addEventListener: (type, listener) => listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
    document: {
      createElement(tag) {
        assert.equal(tag, 'iframe');
        const sent = [];
        const attributes = {};
        const contentWindow = {
          frames: [],
          get length() {
            return this.frames.length;
          },
          postMessage: (data, origin) => sent.push({ data, origin }),
        };
        const frame = {
          contentWindow,
          sent,
          attributes,
          setAttribute: (name, value) => {
            attributes[name] = value;
          },
          remove() {
            view.frames.splice(view.frames.indexOf(contentWindow), 1);
          },
        };
        created.push(frame);
        return frame;
      },
      body: { append: (frame) => view.frames.push(frame.contentWindow) },
    },
  };
  runInNewContext(code, { window: view, URL });
  const fixture = view.mitterPreviewFixture;
  fixture.mount();
  assert.equal(view.frames.length, 2);
  const [preview, peer] = created;
  assert.ok(preview);
  assert.ok(peer);
  assert.match(preview.src, /preview-sandbox\.html\?release-preview=preview$/);
  assert.match(peer.src, /preview-sandbox\.html\?release-preview=peer$/);
  assert.equal(preview.attributes.sandbox, 'allow-scripts');
  assert.equal(peer.attributes.sandbox, 'allow-scripts');
  const receive = [...listeners][0];
  assert.ok(receive);
  receive({ source: {}, origin: 'null', data: { kind: 'miter.preview.ready' } });
  receive({ source: preview.contentWindow, origin: 'null', data: { kind: 'wrong' } });
  assert.deepEqual(previewFixtureSchema.parse(fixture.inspect()).ready, []);
  for (const frame of [preview, peer]) {
    receive({ source: frame.contentWindow, origin: 'null', data: { kind: 'miter.preview.ready' } });
  }
  fixture.spoof();
  const spoof = peer.sent[0]?.data;
  assert.equal(spoof?.kind, 'miter.preview');
  assert.match(spoof.html, /parent\.parent\.frames\[0\]\.postMessage/);
  fixture.malformed();
  assert.equal(preview.sent.length, 8);
  assert.equal(previewFixtureSchema.parse(fixture.inspect()).malformedSent, 8);
  fixture.send();
  const state = previewFixtureSchema.parse(fixture.inspect());
  const payload = preview.sent.at(-1)?.data;
  assert.equal(payload?.kind, 'miter.preview');
  assert.equal(payload?.html, state.html);
  assert.ok(state.html.startsWith('\ufeff'));
  assert.ok(state.html.includes('\r\n'));
  assert.ok(state.html.includes('😀'));

  const script = state.html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.equal(typeof script, 'string');
  for (const condition of ['isolated', 'wrong marker', 'parent readable', 'native API']) {
    const acknowledgements = [];
    const parent = { parent: { postMessage: (data) => acknowledgements.push(data) } };
    Object.defineProperty(parent, 'document', {
      get() {
        if (condition === 'parent readable') {
          return {};
        }
        throw new Error('Opaque parent DOM denied.');
      },
    });
    let text = 'Literal 😀 & exact';
    if (condition === 'wrong marker') {
      text = 'Wrong marker';
    }
    const context = { parent, document: { getElementById: () => ({ textContent: text }) } };
    if (condition === 'native API') {
      context.chrome = { runtime: {} };
    }
    runInNewContext(script, context);
    if (condition === 'isolated') {
      assert.equal(acknowledgements.length, 1);
      assert.equal(acknowledgements[0].kind, 'miter.preview.ready');
    } else {
      assert.equal(acknowledgements.length, 0);
    }
  }
  fixture.replay();
  assert.notEqual(preview.sent.at(-1)?.data.html, state.html);
  fixture.destroy();
  fixture.destroy();
  assert.equal(listeners.size, 0);
  assert.equal(view.frames.length, 0);
  assert.equal(previewFixtureSchema.parse(fixture.inspect()).html, '');
});

test('native observation proves a fresh isolated round trip rather than accepting arbitrary counts', () => {
  const observation = {
    version: '1.0.0-rc.27',
    projectId: 'temporary-project',
    root: '/owned/project',
    initialProjects: 0,
    projects: 1,
    workers: 0,
  };
  assert.deepEqual(nativeCheckSchema.parse(observation), observation);

  for (const changes of [{ initialProjects: 1 }, { projects: 0 }, { workers: 1 }, { projectId: '' }]) {
    assert.equal(nativeCheckSchema.safeParse({ ...observation, ...changes }).success, false);
  }
});
