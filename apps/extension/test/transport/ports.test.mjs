import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTerminalPort } from '../../src/terminal-port.ts';
import { bindFilePreviewPort } from '../../src/file-preview-port.ts';
import { mockPort, deferred, settle, terminalInfo, assetChunk } from './chrome-mock.mjs';

const extensionId = 'extension';
const viewURLs = ['chrome-extension://extension/workspace.html'];
const viewerURL = 'chrome-extension://extension/file.html';

function request(id, method, params) {
  return { id, method, params };
}

function boundPort(kind, rpc) {
  if (kind === 'terminal') {
    const port = mockPort('miter-terminal');

    return { port, bind: () => bindTerminalPort(port, { extensionId, viewURLs, rpc }) };
  }

  const port = mockPort('miter-file-preview', viewerURL + '?task=worker&file=index.html');

  return { port, bind: () => bindFilePreviewPort(port, { extensionId, viewerURL, rpc }) };
}

for (const kind of ['terminal', 'file']) {
  test(`${kind} server port disconnect removes listeners and fences queued callbacks`, async () => {
    const calls = [];
    const { port, bind } = boundPort(kind, async (method, params) => {
      calls.push({ method, params });
      return { released: true };
    });
    const queued = {};

    for (const eventName of ['onMessage', 'onDisconnect']) {
      const add = port[eventName].addListener;
      port[eventName].addListener = (listener) => {
        queued[eventName] = listener;
        add(listener);
      };
    }

    bind();
    port.disconnect();
    assert.equal(port.onMessage.size, 0);
    assert.equal(port.onDisconnect.size, 0);
    await settle();
    const before = calls.length;
    queued.onMessage(request('late', 'terminal.create', { projectId: 'project', confirm: true }));
    queued.onMessage(request('late-read', 'worker.asset', { workerId: 'worker', path: 'index.html' }));
    queued.onDisconnect();
    await settle();
    assert.equal(calls.length, before);
    assert.equal(port.messages.length, 0);
  });

  for (const eventName of ['onMessage', 'onDisconnect']) {
    test(`${kind} server port partial ${eventName} setup releases all registered listeners`, async () => {
      const { port, bind } = boundPort(kind, async () => ({ released: true }));
      const failure = new Error('Server port registration failed');
      const add = port[eventName].addListener;
      port[eventName].addListener = (listener) => {
        add(listener);
        throw failure;
      };
      assert.throws(bind, (error) => error === failure);
      assert.equal(port.onMessage.size, 0);
      assert.equal(port.onDisconnect.size, 0);
      assert.equal(port.disconnects, 1);
      assert.equal(port.messages.length, 0);
      await settle();
    });
  }
}

test('terminal rejects untrusted senders, nested frames, and caller-owned capability tokens', async () => {
  const calls = [];
  const rpc = async (...args) => {
    calls.push(args);
    return { written: true };
  };
  const foreign = mockPort('miter-terminal', 'https://chatgpt.com/');
  assert.equal(bindTerminalPort(foreign, { extensionId, viewURLs, rpc }), undefined);
  assert.equal(foreign.disconnects, 1);
  const nested = mockPort('miter-terminal');
  nested.sender.frameId = 1;
  assert.equal(bindTerminalPort(nested, { extensionId, viewURLs, rpc }), undefined);

  const port = mockPort('miter-terminal');
  assert.equal(typeof bindTerminalPort(port, { extensionId, viewURLs, rpc }), 'function');
  port.onMessage.emit(
    request('injected', 'terminal.write', {
      sessionId: 'session',
      data: 'input',
      clientId: 'attacker',
    }),
  );
  port.onMessage.emit(request('release-all', 'terminal.disconnect', {}));
  port.onMessage.emit(request('valid', 'terminal.write', { sessionId: 'session', data: 'input' }));
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'terminal.write');
  assert.notEqual(calls[0][1].clientId, 'attacker');
  assert.equal(port.messages.filter((message) => message.ok).length, 1);
});

test('terminal mutations are serialized, duplicate in-flight requests are not sent, and disposal releases ownership', async () => {
  const calls = [];
  const create = deferred();
  const rpc = async (method, params) => {
    calls.push({ method, params });

    if (method === 'terminal.create') {
      return create.promise;
    }

    if (method === 'terminal.write') {
      return { written: true };
    }

    return { released: true };
  };
  const port = mockPort('miter-terminal');
  bindTerminalPort(port, { extensionId, viewURLs, rpc });
  const start = request('create', 'terminal.create', {
    projectId: 'project',
    cols: 80,
    rows: 24,
    confirm: true,
  });
  port.onMessage.emit(start);
  port.onMessage.emit(start);
  port.onMessage.emit(request('write', 'terminal.write', { sessionId: 'session', data: 'input' }));
  await settle();
  assert.deepEqual(
    calls.map((call) => call.method),
    ['terminal.create'],
  );
  port.disconnect();
  assert.equal(port.onMessage.size, 0);
  assert.equal(port.onDisconnect.size, 0);
  create.resolve(terminalInfo);
  await settle();
  assert.equal(
    calls.some((call) => call.method === 'terminal.write'),
    false,
  );
  assert.equal(
    calls.some((call) => call.method === 'terminal.disconnect'),
    true,
  );
  assert.equal(port.messages.length, 0);
});

test('file port is pinned to its original task but permits validated local dependencies', async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    return assetChunk;
  };
  const port = mockPort('miter-file-preview', viewerURL + '?task=worker&file=index.html');
  assert.equal(typeof bindFilePreviewPort(port, { extensionId, viewerURL, rpc }), 'function');
  port.onMessage.emit(request('foreign', 'worker.asset', { workerId: 'another', path: 'index.html' }));
  port.onMessage.emit(request('mutation', 'worker.run', { workerId: 'worker' }));
  port.onMessage.emit(request('traversal', 'worker.asset', { workerId: 'worker', path: '../secret' }));
  port.onMessage.emit(request('valid', 'worker.asset', { workerId: 'worker', path: 'index.html' }));
  await settle();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { workerId: 'worker', path: 'index.html' });
  assert.deepEqual(port.messages.at(-1).result, assetChunk);
});

test('file port bounds concurrent reads and ignores completions after disposal', async () => {
  const reads = deferred();
  let sent = 0;
  const rpc = async () => {
    sent++;
    return reads.promise;
  };
  const port = mockPort('miter-file-preview', viewerURL + '?task=worker&file=index.html');
  bindFilePreviewPort(port, { extensionId, viewerURL, rpc });

  for (let index = 0; index < 5; index++) {
    port.onMessage.emit(request('read-' + index, 'worker.asset', { workerId: 'worker', path: 'index.html' }));
  }

  port.onMessage.emit(request('read-0', 'worker.asset', { workerId: 'worker', path: 'index.html' }));
  assert.equal(sent, 4);
  assert.match(port.messages[0].error, /Too many pending/);
  port.disconnect();
  assert.equal(port.onMessage.size, 0);
  assert.equal(port.onDisconnect.size, 0);
  reads.resolve(assetChunk);
  await settle();
  assert.equal(port.messages.length, 1);
});
