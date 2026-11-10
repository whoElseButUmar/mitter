import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, getEventListeners } from 'node:events';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { temporaryDirectory } from './fixtures.mjs';
import { ModelProcess } from '../src/adapters/models.js';
const settings = {
  coderModelPath: '',
  contextSize: 8192,
  maxTokens: 2048,
  gpu: 'auto',
};

function childFixture() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new EventEmitter();
  child.requests = [];
  child.callbacks = [];
  child.send = (request, callback) => {
    child.requests.push(request);
    child.callbacks.push(callback);
  };
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => {
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
    });

    return true;
  };

  return child;
}
test('model host validates IPC before resolving requests and never inherits ' + 'agent secrets', async () => {
  const child = childFixture();
  const models = new ModelProcess(
    () => settings,
    (worker, args, options) => {
      assert.equal(options.env.HF_HUB_OFFLINE, '1');
      assert.equal(options.env.NODE_OPTIONS, undefined);
      assert.equal(options.env.HOME, process.env.HOME);
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'pipe', 'ipc']);

      return child;
    },
  );
  const request = models.propose('prompt', new AbortController().signal);
  child.emit('message', {
    id: child.requests[0].id,
    ok: true,
    result: 'checked result',
  });
  assert.equal(await request, 'checked result');
  // Late send failure cannot poison a completed request or kill its successor.
  child.callbacks[0](new Error('late send error'));
  const next = models.propose('next', new AbortController().signal);
  const rejected = assert.rejects(next, /invalid IPC response/);
  child.emit('message', {
    id: child.requests[1].id,
    ok: true,
    result: {
      unchecked: true,
    },
  });
  await rejected;
  await models.settled();
  assert.equal(child.signalCode, 'SIGKILL');
});
test(
  'aborting a model request kills its process and settles all pending ' + 'callers without replay',
  async () => {
    const child = childFixture();
    const models = new ModelProcess(
      () => settings,
      () => child,
    );
    const abort = new AbortController();
    const first = models.propose('first', abort.signal);
    const second = models.propose('second', new AbortController().signal);
    const firstRejected = assert.rejects(first, /stopped or timed out/);
    const secondRejected = assert.rejects(second, /stopped or timed out/);
    abort.abort();
    await Promise.all([firstRejected, secondRejected]);
    await models.settled();
    assert.equal(child.requests.length, 2);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    assert.equal(child.listenerCount('message'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
  },
);

test(
  'a real inference worker crash is not replayed and a fresh worker reports missing GGUF',
  { timeout: 10000 },
  async (t) => {
    const home = await temporaryDirectory(t);
    const worker = fileURLToPath(new URL('../../inference/src/worker.ts', import.meta.url));
    const loader = fileURLToPath(
      new URL('../../../packages/bridge/src/runner/test-source-loader.mjs', import.meta.url),
    );
    const children = [];
    const closed = [];
    const transmissions = [];
    const models = new ModelProcess(
      () => settings,
      (requestedWorker, args, options) => {
        const child = fork(worker, args, {
          ...options,
          cwd: home,
          execArgv: ['--import', loader],
          env: { ...options.env, HOME: home, USERPROFILE: home, TMPDIR: home },
        });
        const send = child.send.bind(child);
        child.send = (...arguments_) => {
          transmissions.push(arguments_[0]);
          return send(...arguments_);
        };
        children.push(child);
        closed.push(new Promise((resolve) => child.once('close', resolve)));
        return child;
      },
    );
    t.after(async () => {
      models.close();
      await models.settled();
      await Promise.all(closed);
    });
    const first = models.propose('must not be replayed', new AbortController().signal);
    const rejected = assert.rejects(first, /Local model process exited|channel closed/i);
    const initialChild = children[0];
    assert.ok(initialChild);
    assert.equal(initialChild.kill('SIGKILL'), true);
    await rejected;
    await closed[0];

    await assert.rejects(
      models.propose('new explicit request', new AbortController().signal),
      /local GGUF file is required/,
    );
    assert.equal(children.length, 2);
    assert.deepEqual(
      transmissions.map((request) => request.input),
      ['must not be replayed', 'new explicit request'],
    );
  },
);

test('a failed model spawn settles after close even when no exit event is emitted', async (t) => {
  const root = await temporaryDirectory(t);
  const child = spawn(path.join(root, 'missing-model-executable'), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const models = new ModelProcess(
    () => settings,
    () => child,
  );
  t.after(() => models.close());

  await assert.rejects(models.propose('prompt', new AbortController().signal), /ENOENT/);
  await closed;

  let now = 0;
  t.mock.method(Date, 'now', () => {
    now += 6000;
    return now;
  });
  await models.settled();
});

test('cancellation during model startup does not send a request and releases its abort listener', async () => {
  const child = childFixture();
  const abort = new AbortController();
  const models = new ModelProcess(
    () => settings,
    () => {
      abort.abort();
      return child;
    },
  );

  await assert.rejects(models.propose('cancelled prompt', abort.signal), /stopped or timed out/);
  await models.settled();

  assert.equal(child.requests.length, 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('a model termination error rejects every pending caller while keeping reset blocked', async (t) => {
  const child = childFixture();
  child.kill = () => {
    throw new Error('termination refused');
  };
  const models = new ModelProcess(
    () => settings,
    () => child,
  );
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = models.propose('first', firstAbort.signal);
  const second = models.propose('second', secondAbort.signal);
  const rejected = Promise.all([
    assert.rejects(first, /termination refused/),
    assert.rejects(second, /termination refused/),
  ]);

  assert.doesNotThrow(() => models.close());
  await rejected;
  assert.equal(getEventListeners(firstAbort.signal, 'abort').length, 0);
  assert.equal(getEventListeners(secondAbort.signal, 'abort').length, 0);

  let now = 0;
  t.mock.method(Date, 'now', () => {
    now += 6000;
    return now;
  });
  await assert.rejects(models.settled(), /reset refused/);

  child.emit('exit', null, 'SIGKILL');
  child.emit('close', null, 'SIGKILL');
  await models.settled();
});
