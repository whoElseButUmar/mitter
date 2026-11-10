import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { build } from 'rolldown';
import '../runner/test-source-loader.mjs';
import { moduleReferences } from '../../../../scripts/module-imports.mjs';

const { PageTransport, PageBridgeError, PAGE_CHANNEL, PAGE_READER } = await import('../page-transport.ts');
const { readPageState, pageStateSchema } = await import('./page-state.ts');
const { installPageEndpoint } = await import('../page-endpoint.ts');
const { pageReplySchema } = await import('./messages.ts');

const action = {
  op: 'inspect',
  token: 'task-token',
  url: 'https://chatgpt.com/c/task-1',
  expiresAt: Number.MAX_SAFE_INTEGER,
};

function pageView(overrides = {}) {
  return {
    url: action.url,
    count: 0,
    userCount: 0,
    lastRole: '',
    assistantId: '',
    assistantText: '',
    lastUserText: '',
    busy: false,
    complete: false,
    draft: false,
    draftText: '',
    stopped: false,
    ready: true,
    ...overrides,
  };
}

function transportFixture(perform, timeoutMs = 100) {
  const requests = [];
  const injections = [];
  const logs = [];

  const api = {
    async send(tabId, message) {
      requests.push(message);
      let value;

      if (message.kind === 'hello') {
        value = {
          version: PAGE_CHANNEL,
          reader: PAGE_READER,
          instanceId: 'document-instance',
          url: action.url,
          readyState: 'complete',
        };
      } else {
        value = await perform(message, tabId);
      }

      return { channel: PAGE_CHANNEL, id: message.id, instanceId: 'document-instance', ok: true, value };
    },
    async inject(tabId) {
      injections.push(tabId);
    },
  };

  const transport = new PageTransport(api, (kind, message) => logs.push({ kind, message }), timeoutMs);

  return { transport, api, requests, injections, logs };
}

function installGlobal(context, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

  context.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, name, previous);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  });
}

function endpointFixture() {
  const listeners = [];
  const removed = [];
  const runtime = {
    id: 'extension-id',
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      },
      removeListener(listener) {
        removed.push(listener);
      },
    },
  };

  return { runtime, listeners, removed };
}

test('page state validation preserves absent observations without defaults', () => {
  const view = pageView();
  assert.deepEqual(readPageState(view, 'inspect'), view);
  assert.equal(
    pageStateSchema.description,
    'Validated page observations with bounded diagnostic lists and reply payloads.',
  );
  assert.equal(Object.hasOwn(readPageState(view, 'inspect'), 'outcome'), false);
});

test('page state validation rejects incomplete fields and malformed lifecycle receipts', () => {
  const malformed = [
    { userCount: -1 },
    { count: 1.5 },
    { ready: 'yes' },
    { composerSession: 'invalid document ID' },
    { visibility: 'gone' },
    { outcome: 'sent_maybe' },
    { userIds: Array(257).fill('user') },
    { disclosure: { state: 'pending', attempts: 4 } },
    { codeReplyIds: ['bad reply id'] },
    { codeReplyTotal: 66 },
    { codeRead: { characters: 400002, fingerprint: 'a', issue: 'candidate' } },
  ];

  for (const overrides of malformed) {
    assert.throws(() => readPageState(pageView(overrides), 'inspect'), {
      name: 'PageBridgeError',
      code: 'INVALID_PAGE_STATE',
      transient: true,
    });
  }

  assert.throws(() => readPageState(pageView(), 'commit'), { code: 'INVALID_PAGE_STATE' });
  assert.equal(readPageState(pageView({ outcome: 'clicked' }), 'commit').outcome, 'clicked');
});

test('page state validation bounds UTF-8 reply bytes without altering source text', () => {
  const reply = {
    id: 'reply-1',
    workerId: 'worker-1',
    projectId: 'project-1',
    text: '{"content":"  spaces\\n`backticks`\\\\"}',
    hasCopyControl: true,
  };

  assert.deepEqual(readPageState(pageView({ codeReply: reply }), 'reply').codeReply, reply);
  assert.throws(
    () => readPageState(pageView({ codeReply: { ...reply, text: '🔥'.repeat(100001) } }), 'reply'),
    {
      code: 'INVALID_PAGE_STATE',
    },
  );
});

test('untrusted page observations cannot supply coordinator-only reply evidence', () => {
  const original = Object.freeze(pageView({ replyEvidence: 'exchange' }));
  const parsed = readPageState(original, 'inspect');
  assert.equal(Object.hasOwn(parsed, 'replyEvidence'), false);
  assert.equal(original.replyEvidence, 'exchange');
});

test('a version-only or malformed hello cannot authorize a page operation', async (context) => {
  for (const value of [
    { version: PAGE_CHANNEL, reader: PAGE_READER },
    {
      version: PAGE_CHANNEL,
      reader: PAGE_READER,
      instanceId: 'document-instance',
      url: action.url,
      readyState: 1,
    },
  ]) {
    await context.test(JSON.stringify(value), async () => {
      const fixture = transportFixture(async () => pageView());
      fixture.api.send = async (_tabId, message) => {
        fixture.requests.push(message);
        return { channel: PAGE_CHANNEL, id: message.id, instanceId: 'document-instance', ok: true, value };
      };
      await assert.rejects(fixture.transport.request(7, action), { code: 'STALE_PAGE_READER' });
      assert.equal(
        fixture.requests.some((message) => message.kind === 'request'),
        false,
      );
    });
  }
});

test('invalid page-state diagnostics stay in the cause rather than the user-facing message', () => {
  assert.throws(
    () => readPageState(pageView({ busy: 'PRIVATE_DATA' }), 'inspect'),
    (error) => {
      assert.equal(error.code, 'INVALID_PAGE_STATE');
      assert.equal(error.message.includes('PRIVATE_DATA'), false);
      assert.equal(error.cause.name, 'ZodError');
      return true;
    },
  );
});

test('known page reply payloads require real hello, observation, or reset data', () => {
  const header = { channel: PAGE_CHANNEL, id: 'request', instanceId: 'document', ok: true };
  for (const value of [
    {
      version: PAGE_CHANNEL,
      reader: PAGE_READER,
      instanceId: 'document',
      url: action.url,
      readyState: 'complete',
    },
    pageView(),
    { cleared: true },
  ]) {
    assert.equal(pageReplySchema.safeParse({ ...header, value }).success, true);
  }
  for (const value of [
    undefined,
    null,
    {},
    'private data',
    { cleared: 'true' },
    pageView({ busy: 'false' }),
  ]) {
    assert.equal(pageReplySchema.safeParse({ ...header, value }).success, false);
  }
  assert.deepEqual(
    pageReplySchema.parse({ ...header, ok: false, error: { code: 'STOPPED', message: 'Paused.' } }),
    {
      ...header,
      ok: false,
      error: { code: 'STOPPED', message: 'Paused.' },
    },
  );
});

test('malformed outgoing page requests are rejected before browser checks, injection, or dispatch', async () => {
  for (const request of [
    undefined,
    null,
    { ...action, op: 'unknown' },
    { ...action, expiresAt: 'tomorrow' },
    { ...action, receipt: {} },
  ]) {
    const fixture = transportFixture(async () => pageView());
    fixture.api.checkAvailable = async () => assert.fail('Invalid requests cannot reach browser APIs');
    await assert.rejects(fixture.transport.request(7, request), (error) => {
      assert.equal(error.code, 'BAD_REQUEST');
      assert.equal(error.cause.name, 'ZodError');
      return true;
    });
    assert.deepEqual(fixture.requests, []);
    assert.deepEqual(fixture.injections, []);
  }
});

test('outgoing page validation preserves every prompt character rather than coercing or trimming', async () => {
  const prompt = '  literal\\path\r\n`code`\t\u0000🙂\n';
  const fixture = transportFixture(async () => pageView({ outcome: 'prepared' }));
  await fixture.transport.request(7, { ...action, op: 'prepare', text: prompt, messageId: 'message' });
  assert.equal(fixture.requests.find((request) => request.kind === 'request').action.text, prompt);
});

test('read operations can reconnect once after a lost response', async () => {
  let calls = 0;
  const fixture = transportFixture(async () => {
    calls++;

    if (calls === 1) {
      throw new Error('Document connection lost');
    }

    return pageView();
  });

  assert.deepEqual(await fixture.transport.request(7, action), pageView());
  assert.equal(calls, 2);
  assert.equal(fixture.requests.filter((message) => message.kind === 'hello').length, 2);
});

test('forget releases transport bookkeeping for closed tabs', async () => {
  const fixture = transportFixture(() => pageView());
  for (const tabId of [7, 8, 9]) {
    await fixture.transport.request(tabId, action);
    fixture.transport.forget(tabId);
  }
  assert.equal(fixture.transport.attachedTabs.size, 0);
  assert.equal(fixture.transport.pendingConnections.size, 0);
  assert.equal(fixture.transport.documentGenerations.size, 0);
});

test('a forgotten pending connection cannot attach over a replacement connection', async () => {
  const fixture = transportFixture(() => pageView());
  const send = fixture.api.send;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let held = false;
  fixture.api.send = async (tabId, message) => {
    if (message.kind === 'hello' && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return send(tabId, message);
  };
  const connecting = fixture.transport.ensure(7);
  const rejection = assert.rejects(connecting, { code: 'BRIDGE_NAVIGATED' });
  await entered.promise;
  fixture.transport.forget(7);
  try {
    await fixture.transport.ensure(7);
    assert.equal(fixture.transport.attachedTabs.has(7), true);
  } finally {
    release.resolve();
    await rejection;
  }
  assert.equal(fixture.transport.attachedTabs.has(7), true);
  assert.equal(fixture.transport.pendingConnections.size, 0);
  assert.equal(fixture.injections.length, 0);
  fixture.transport.forget(7);
  assert.equal(fixture.transport.documentGenerations.size, 0);
});

test('forget between connection and dispatch prevents an unbound mutation', async () => {
  let calls = 0;
  const fixture = transportFixture(() => {
    calls++;
    return pageView({ outcome: 'clicked' });
  });
  const ensure = fixture.transport.ensure.bind(fixture.transport);
  fixture.transport.ensure = async (tabId) => {
    await ensure(tabId);
    fixture.transport.forget(tabId);
  };
  await assert.rejects(fixture.transport.request(7, { ...action, op: 'commit', text: '  exact prompt\n' }), {
    code: 'BRIDGE_NAVIGATED',
  });
  assert.equal(calls, 0);
});

test('composer mutations are never replayed after ambiguous transport failure', async () => {
  for (const operation of ['prepare', 'commit', 'send']) {
    let calls = 0;
    const fixture = transportFixture(async () => {
      calls++;
      throw new Error('Lost mutation acknowledgement');
    });

    await assert.rejects(fixture.transport.request(7, { ...action, op: operation, text: 'task text' }), {
      code: 'BRIDGE_DISCONNECTED',
    });
    assert.equal(calls, 1);
  }
});

test('a timed-out commit clears its timer and never sends twice', async () => {
  let calls = 0;
  const fixture = transportFixture(() => {
    calls++;
    return new Promise(() => {});
  }, 5);

  await assert.rejects(fixture.transport.request(7, { ...action, op: 'commit', text: 'task text' }), {
    code: 'BRIDGE_TIMEOUT',
  });
  assert.equal(calls, 1);
});

test('a navigation during commit invalidates the old answer without replay', async () => {
  let calls = 0;
  const fixture = transportFixture(() => {
    calls++;
    fixture.transport.forget(7);
    return pageView({ outcome: 'clicked' });
  });

  await assert.rejects(fixture.transport.request(7, { ...action, op: 'commit', text: 'task text' }), {
    code: 'BRIDGE_NAVIGATED',
  });
  assert.equal(calls, 1);
});

test('malformed envelopes never become successful operation results', async () => {
  const fixture = transportFixture(() => pageView());
  fixture.api.send = async () => ({
    channel: PAGE_CHANNEL,
    id: 'wrong-id',
    instanceId: 'instance',
    ok: true,
  });

  await assert.rejects(fixture.transport.request(7, action), { code: 'INVALID_BRIDGE_REPLY' });
});

test('suspended browser documents do not trigger injection or page requests', async () => {
  const fixture = transportFixture(() => pageView());
  fixture.api.checkAvailable = async () => {
    throw new PageBridgeError('TAB_FROZEN', 'The browser froze this tab.', true);
  };

  await assert.rejects(fixture.transport.request(7, action), { code: 'TAB_FROZEN' });
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.injections.length, 0);
});

test('endpoint reinjection keeps existing Stop state and the committed-send ledger', (context) => {
  const fixture = endpointFixture();
  const previous = {
    token: action.token,
    composerSession: 'prepared-document',
    stopped: false,
    prepared: null,
    committed: new Map([['send-1', { text: 'task text', time: 100 }]]),
    reveals: new Map(),
  };

  installGlobal(context, '__mitterSessionV4', previous);
  installGlobal(context, '__mitterSessionV3', undefined);
  installGlobal(context, '__mitterPageEndpointV4', undefined);
  installPageEndpoint(fixture.runtime);

  assert.equal(previous.stopped, true);
  assert.notEqual(globalThis.__mitterSessionV4, previous);
  assert.equal(globalThis.__mitterSessionV4.stopped, false);
  assert.equal(globalThis.__mitterSessionV4.committed, previous.committed);
});

test('page reset removes endpoint and session globals rather than leaving undefined properties', async (context) => {
  const fixture = endpointFixture();
  for (const name of [
    '__mitterSessionV3',
    '__mitterSessionV4',
    '__mitterPageEndpointV3',
    '__mitterPageEndpointV4',
  ]) {
    installGlobal(context, name, undefined);
  }
  installGlobal(context, 'document', { getElementById: () => null });
  installPageEndpoint(fixture.runtime);
  const listener = fixture.listeners[0];
  assert.equal(Object.hasOwn(globalThis, '__mitterPageEndpointV4'), true);
  const response = Promise.withResolvers();
  assert.equal(
    listener(
      { channel: PAGE_CHANNEL, id: 'reset-1', kind: 'reset', confirmation: 'CLEAR' },
      { id: fixture.runtime.id },
      response.resolve,
    ),
    true,
  );
  const reply = await response.promise;
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.value, { cleared: true });
  for (const name of ['__mitterSessionV3', '__mitterSessionV4', '__mitterPageEndpointV4']) {
    assert.equal(Object.hasOwn(globalThis, name), false);
  }
  assert.equal(fixture.removed.includes(listener), true);
  const afterReset = [];
  assert.equal(
    listener(
      { channel: PAGE_CHANNEL, id: 'after-reset', kind: 'hello' },
      { id: fixture.runtime.id },
      (answer) => afterReset.push(answer),
    ),
    false,
  );
  assert.equal(afterReset.length, 0);
  assert.equal(Object.hasOwn(globalThis, '__mitterPageEndpointV4'), false);
});

test('deferred reset cleanup cannot retire a replacement endpoint or its session', async (context) => {
  const fixture = endpointFixture();
  for (const name of [
    '__mitterSessionV3',
    '__mitterSessionV4',
    '__mitterPageEndpointV3',
    '__mitterPageEndpointV4',
  ]) {
    installGlobal(context, name, undefined);
  }
  installGlobal(context, 'document', { getElementById: () => null });
  installPageEndpoint(fixture.runtime);
  const resetting = fixture.listeners[0];
  const response = Promise.withResolvers();
  assert.equal(
    resetting(
      { channel: PAGE_CHANNEL, id: 'reset-old', kind: 'reset', confirmation: 'CLEAR' },
      { id: fixture.runtime.id },
      response.resolve,
    ),
    true,
  );
  installPageEndpoint(fixture.runtime);
  const replacementEndpoint = globalThis.__mitterPageEndpointV4;
  const replacementSession = {
    token: 'replacement-task',
    composerSession: 'replacement-document',
    stopped: false,
    prepared: null,
    committed: new Map([['replacement-send', { text: 'literal new prompt', time: 200 }]]),
    reveals: new Map(),
  };
  globalThis.__mitterSessionV4 = replacementSession;
  const reply = await response.promise;
  assert.equal(reply.ok, true);
  assert.equal(globalThis.__mitterPageEndpointV4, replacementEndpoint);
  assert.equal(globalThis.__mitterSessionV4, replacementSession);
  assert.equal(replacementSession.stopped, false);
  assert.equal(replacementSession.committed.size, 1);
  assert.equal(fixture.removed.includes(resetting), true);
  assert.equal(fixture.removed.includes(replacementEndpoint.listener), false);
});

test(
  'reset teardown errors return a failure instead of escaping as an unhandled rejection',
  { timeout: 1000 },
  async (context) => {
    const fixture = endpointFixture();
    for (const name of [
      '__mitterSessionV3',
      '__mitterSessionV4',
      '__mitterPageEndpointV3',
      '__mitterPageEndpointV4',
    ]) {
      installGlobal(context, name, undefined);
    }
    installGlobal(context, 'document', { getElementById: () => null });
    installPageEndpoint(fixture.runtime);
    fixture.runtime.onMessage.removeListener = () => {
      throw new Error('The old extension context is unavailable.');
    };
    const response = Promise.withResolvers();
    fixture.listeners[0](
      { channel: PAGE_CHANNEL, id: 'reset-failed', kind: 'reset', confirmation: 'CLEAR' },
      { id: fixture.runtime.id },
      response.resolve,
    );
    const reply = await response.promise;
    assert.equal(reply.ok, false);
    assert.deepEqual(reply.error, {
      code: 'RESET_FAILED',
      message: 'The old extension context is unavailable.',
    });
    assert.equal(globalThis.__mitterSessionV4, undefined);
    assert.equal(Object.hasOwn(globalThis, '__mitterPageEndpointV4'), false);
  },
);

test('reset still releases its endpoint when removing the page control throws', async (context) => {
  const fixture = endpointFixture();
  for (const name of [
    '__mitterSessionV3',
    '__mitterSessionV4',
    '__mitterPageEndpointV3',
    '__mitterPageEndpointV4',
  ]) {
    installGlobal(context, name, undefined);
  }
  installGlobal(context, 'document', {
    getElementById: () => ({
      remove() {
        throw new Error('The page control could not be removed.');
      },
    }),
  });
  installPageEndpoint(fixture.runtime);
  const listener = fixture.listeners[0];
  const response = Promise.withResolvers();
  assert.equal(
    listener(
      { channel: PAGE_CHANNEL, id: 'reset-control-failed', kind: 'reset', confirmation: 'CLEAR' },
      { id: fixture.runtime.id },
      response.resolve,
    ),
    true,
  );
  const reply = await response.promise;
  assert.equal(reply.ok, false);
  assert.deepEqual(reply.error, {
    code: 'RESET_FAILED',
    message: 'The page control could not be removed.',
  });
  assert.equal(Object.hasOwn(globalThis, '__mitterPageEndpointV4'), false);
  assert.equal(fixture.removed.includes(listener), true);
});

test('a replaced listener is inert even when Chrome could not detach it', async (context) => {
  const fixture = endpointFixture();
  for (const name of [
    '__mitterSessionV3',
    '__mitterSessionV4',
    '__mitterPageEndpointV3',
    '__mitterPageEndpointV4',
  ]) {
    installGlobal(context, name, undefined);
  }
  installGlobal(context, 'document', { getElementById: () => null, readyState: 'complete' });
  installGlobal(context, 'location', new URL(action.url));
  installPageEndpoint(fixture.runtime);
  const previous = fixture.listeners[0];
  fixture.runtime.onMessage.removeListener = () => {
    throw new Error('The old extension context is unavailable.');
  };
  installPageEndpoint(fixture.runtime);
  const replacementEndpoint = globalThis.__mitterPageEndpointV4;
  const replacementSession = {
    token: 'replacement-task',
    composerSession: 'replacement-document',
    stopped: false,
    prepared: null,
    committed: new Map([['new-send', { text: '  exact new prompt\n', time: 200 }]]),
    reveals: new Map(),
  };
  globalThis.__mitterSessionV4 = replacementSession;
  const answers = [];
  for (const message of [
    { channel: PAGE_CHANNEL, id: 'old-hello', kind: 'hello' },
    {
      channel: PAGE_CHANNEL,
      id: 'old-stop',
      kind: 'request',
      action: { ...action, op: 'stop', token: replacementSession.token },
    },
    { channel: PAGE_CHANNEL, id: 'old-reset', kind: 'reset', confirmation: 'CLEAR' },
  ]) {
    assert.equal(
      previous(message, { id: fixture.runtime.id }, (answer) => answers.push(answer)),
      false,
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answers.length, 0);
  assert.equal(globalThis.__mitterPageEndpointV4, replacementEndpoint);
  assert.equal(globalThis.__mitterSessionV4, replacementSession);
  assert.equal(replacementSession.stopped, false);
  assert.equal(replacementSession.committed.size, 1);
  assert.equal(
    replacementEndpoint.listener(
      { channel: PAGE_CHANNEL, id: 'new-hello', kind: 'hello' },
      { id: fixture.runtime.id },
      (answer) => answers.push(answer),
    ),
    false,
  );
  assert.equal(answers.length, 1);
  assert.equal(answers[0].ok, true);
});

test('a closed reset response channel does not leak a rejected cleanup promise', async (context) => {
  const fixture = endpointFixture();
  for (const name of [
    '__mitterSessionV3',
    '__mitterSessionV4',
    '__mitterPageEndpointV3',
    '__mitterPageEndpointV4',
  ]) {
    installGlobal(context, name, undefined);
  }
  installGlobal(context, 'document', { getElementById: () => null });
  installPageEndpoint(fixture.runtime);
  const listener = fixture.listeners[0];
  listener(
    { channel: PAGE_CHANNEL, id: 'reset-disconnected', kind: 'reset', confirmation: 'CLEAR' },
    { id: fixture.runtime.id },
    () => {
      throw new Error('Response channel disconnected.');
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Object.hasOwn(globalThis, '__mitterPageEndpointV4'), false);
  assert.equal(fixture.removed.includes(listener), true);
});

test('reinjection releases the retired legacy endpoint reference', (context) => {
  const fixture = endpointFixture();
  const legacyListener = () => false;
  installGlobal(context, '__mitterPageEndpointV3', {
    runtimeId: fixture.runtime.id,
    version: PAGE_CHANNEL,
    listener: legacyListener,
  });
  installGlobal(context, '__mitterPageEndpointV4', undefined);
  installGlobal(context, '__mitterSessionV3', undefined);
  installGlobal(context, '__mitterSessionV4', undefined);
  installPageEndpoint(fixture.runtime);
  assert.equal(fixture.removed.includes(legacyListener), true);
  assert.equal(Object.hasOwn(globalThis, '__mitterPageEndpointV3'), false);
});

test('endpoint authenticates senders and rejects malformed actions before any DOM operation', (context) => {
  const fixture = endpointFixture();
  installGlobal(context, '__mitterSessionV4', undefined);
  installGlobal(context, '__mitterPageEndpointV4', undefined);
  installPageEndpoint(fixture.runtime);

  const listener = fixture.listeners[0];
  const answers = [];
  const invalidRequest = {
    channel: PAGE_CHANNEL,
    id: 'request-1',
    kind: 'request',
    action: { ...action, expiresAt: 'tomorrow' },
  };

  assert.equal(
    listener(invalidRequest, { id: 'unrelated-extension' }, (answer) => answers.push(answer)),
    false,
  );
  assert.equal(
    listener(invalidRequest, { id: fixture.runtime.id, tab: {} }, (answer) => answers.push(answer)),
    false,
  );
  assert.equal(answers.length, 0);

  assert.equal(
    listener(invalidRequest, { id: fixture.runtime.id }, (answer) => answers.push(answer)),
    false,
  );
  assert.equal(answers[0].error.code, 'BAD_REQUEST');
  assert.equal(globalThis.__mitterSessionV4, undefined);
});

test('the real bundled page installs and answers authenticated requests without module imports', async () => {
  const entry = fileURLToPath(new URL('../page-entry.ts', import.meta.url));
  const bundle = await build({ input: entry, write: false, platform: 'browser', output: { format: 'iife' } });
  assert.equal(bundle.output.length, 1);
  const script = bundle.output[0].code;
  assert.deepEqual(moduleReferences(script, 'mitter-page.js'), []);

  const fixture = endpointFixture();
  const sandbox = createContext({
    chrome: { runtime: fixture.runtime },
    crypto: webcrypto,
    URL,
    TextEncoder,
    location: new URL(action.url),
    document: { readyState: 'complete' },
  });
  runInContext(script, sandbox);
  assert.equal(fixture.listeners.length, 1);

  const listener = fixture.listeners[0];
  const answers = [];
  const hello = { channel: PAGE_CHANNEL, id: 'hello-1', kind: 'hello' };
  assert.equal(
    listener(hello, { id: fixture.runtime.id }, (answer) => answers.push(answer)),
    false,
  );
  assert.equal(answers[0].value.reader, PAGE_READER);

  const response = new Promise((resolve) => {
    const keptOpen = listener(
      { channel: PAGE_CHANNEL, id: 'read-1', kind: 'request', action: { ...action, op: 'control' } },
      { id: fixture.runtime.id },
      resolve,
    );
    assert.equal(keptOpen, true);
  });

  const answer = await response;
  assert.equal(answer.ok, true);
  assert.equal(answer.value.ready, false);
  assert.equal(answer.value.url, action.url);
});
