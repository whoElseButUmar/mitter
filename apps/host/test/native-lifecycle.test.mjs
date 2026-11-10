import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { z } from 'zod';
import { FrameDecoder, encodeFrame } from '../src/core/framing.js';
import { EXTENSION_ORIGIN, parseRequest } from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = fileURLToPath(new URL('../src/native.ts', import.meta.url));
const sourceLoader = fileURLToPath(
  new URL('../../../packages/bridge/src/runner/test-source-loader.mjs', import.meta.url),
);
const fixture = fileURLToPath(new URL('./native-lifecycle-fixture.mjs', import.meta.url));
const eventSchema = z
  .enum([
    'ready',
    'runtime.open',
    'terminals.construct',
    'terminals.close',
    'terminals.reset',
    'service.snapshot',
    'service.subscribe',
    'service.unsubscribe',
    'snapshot.timer.scheduled',
    'snapshot.timer.cleared',
    'snapshot.after-close',
    'requests.submit',
    'requests.close',
    'output.close',
    'stdin.pause',
    'runtime.dispatch',
    'runtime.dispatch.finished',
    'runtime.close.enter',
    'runtime.close.finished',
    'reset.prepare',
    'reset.clear',
    'reset.enter',
    'reset.finished',
    'process.exit',
    'shutdown.diagnostics.failed',
    'fixture.unhandled',
    'checkpoint',
  ])
  .describe('Observed cleanup and admission events from the isolated native entrypoint child.');

function runNative(t, configuration = {}) {
  const child = spawn(
    process.execPath,
    ['--import', sourceLoader, '--import', fixture, source, EXTENSION_ORIGIN, JSON.stringify(configuration)],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
  );
  const events = [];
  const stdout = [];
  const stderr = [];
  const waiters = new Set();
  const exit = Promise.withResolvers();
  let finished = false;

  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('message', (raw) => {
    const event = eventSchema.parse(raw);
    events.push(event);

    for (const waiter of waiters) {
      if (waiter.event === event && count(events, event) >= waiter.occurrences) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  });
  child.on('error', (error) => {
    exit.reject(error);

    for (const waiter of waiters) {
      waiter.reject(error);
    }
    waiters.clear();
  });
  child.on('close', (code, signal) => {
    finished = true;
    const result = {
      code,
      signal,
      events,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };
    exit.resolve(result);

    for (const waiter of waiters) {
      waiter.reject(new Error('Native child exited before ' + waiter.event + ': ' + result.stderr));
    }
    waiters.clear();
  });
  t.after(async () => {
    if (!finished) {
      child.kill('SIGKILL');
      await exit.promise;
    }
  });

  return {
    child,
    events,
    exited: exit.promise,
    waitFor(event, occurrences = 1) {
      if (count(events, event) >= occurrences) {
        return Promise.resolve();
      }

      if (finished) {
        return Promise.reject(new Error('Native child already exited before ' + event));
      }

      return new Promise((resolve, reject) => {
        waiters.add({ event, occurrences, resolve, reject });
      });
    },
    command(command) {
      child.send(command);
    },
    request(id, method, params = {}) {
      child.stdin.write(encodeFrame(parseRequest({ id, method, params })));
    },
  };
}

function count(events, event) {
  return events.filter((value) => value === event).length;
}

function assertReleased(result, expectedCode) {
  assert.equal(result.code, expectedCode, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(count(result.events, 'fixture.unhandled'), 0, result.stderr);

  for (const event of [
    'terminals.close',
    'requests.close',
    'output.close',
    'service.unsubscribe',
    'snapshot.timer.cleared',
    'runtime.close.enter',
    'runtime.close.finished',
    'process.exit',
  ]) {
    assert.equal(count(result.events, event), 1, event + ': ' + result.events.join(', '));
  }
  assert.ok(result.events.includes('stdin.pause'));
  assert.ok(result.events.indexOf('requests.close') < result.events.indexOf('runtime.close.enter'));
  assert.ok(result.events.indexOf('service.unsubscribe') < result.events.indexOf('runtime.close.enter'));
  assert.ok(result.events.indexOf('snapshot.timer.cleared') < result.events.indexOf('runtime.close.enter'));

  const decoder = new FrameDecoder();
  const frames = decoder.push(result.stdout);
  decoder.end();
  assert.equal(frames.length, 1);
  assert.equal(z.object({ event: z.literal('snapshot') }).parse(frames[0]).event, 'snapshot');
}

for (const scenario of [
  { name: 'normal EOF', configuration: {}, expectedCode: 0 },
  { name: 'terminal cleanup failure', configuration: { failTerminals: true }, expectedCode: 1 },
  { name: 'runtime closure failure', configuration: { failRuntime: true }, expectedCode: 1 },
  {
    name: 'terminal and runtime failures',
    configuration: { failTerminals: true, failRuntime: true },
    expectedCode: 1,
  },
]) {
  test('native shutdown releases every resource after ' + scenario.name, { timeout: 10000 }, async (t) => {
    const native = runNative(t, scenario.configuration);
    await native.waitFor('ready');
    native.command('service-change');
    await native.waitFor('snapshot.timer.scheduled');
    native.child.stdin.end();
    const result = await native.exited;

    assertReleased(result, scenario.expectedCode);

    if (scenario.configuration.failTerminals) {
      assert.match(result.stderr, /terminals: fixture terminal cleanup failed/);
      assert.match(result.stderr, /PTY kill refused; terminal subscription failed/);
    }

    if (scenario.configuration.failRuntime) {
      assert.match(result.stderr, /runtime: fixture runtime closure failed/);
    }
  });
}

test(
  'native cleanup continues through queue, subscription and stdin failures',
  { timeout: 10000 },
  async (t) => {
    const native = runNative(t, {
      failTerminals: true,
      failRuntime: true,
      failRequests: true,
      failOutput: true,
      failUnsubscribe: true,
      failStdin: true,
    });
    await native.waitFor('ready');
    native.command('service-change');
    await native.waitFor('snapshot.timer.scheduled');
    native.command('end');
    const result = await native.exited;

    assertReleased(result, 1);

    for (const message of [
      'terminal cleanup failed',
      'request queue cleanup failed',
      'output queue cleanup failed',
      'subscription cleanup failed',
      'stdin pause failed',
      'runtime closure failed',
    ]) {
      assert.ok(result.stderr.includes(message), message + ': ' + result.stderr);
    }
  },
);

test('failed shutdown diagnostics still exit nonzero without rejection', { timeout: 10000 }, async (t) => {
  const native = runNative(t, {
    failTerminals: true,
    failRuntime: true,
    failShutdownDiagnostics: true,
  });
  await native.waitFor('ready');
  native.command('service-change');
  await native.waitFor('snapshot.timer.scheduled');
  native.child.stdin.end();
  const result = await native.exited;

  assertReleased(result, 1);
  assert.equal(count(result.events, 'shutdown.diagnostics.failed'), 1);
  assert.equal(result.stderr, '');
});

test(
  'signals and repeated close events share one shutdown without snapshot or reset re-entry',
  { timeout: 10000 },
  async (t) => {
    const native = runNative(t, {
      holdRuntime: true,
      failTerminals: true,
      failRuntime: true,
      reentrantClose: true,
    });
    await native.waitFor('ready');
    native.command('service-change');
    await native.waitFor('snapshot.timer.scheduled');
    native.child.kill('SIGTERM');
    await native.waitFor('runtime.close.enter');
    native.child.kill('SIGINT');
    native.command('end');
    native.command('output-error');
    native.command('buffered-reset');
    native.command('late-timer');
    native.command('checkpoint');
    await native.waitFor('checkpoint');

    assert.equal(count(native.events, 'runtime.close.enter'), 1);
    assert.equal(count(native.events, 'terminals.close'), 1);
    assert.equal(count(native.events, 'reset.enter'), 0);
    assert.equal(count(native.events, 'snapshot.after-close'), 0);
    native.command('release-runtime');
    const result = await native.exited;
    assertReleased(result, 1);
    assert.match(result.stderr, /fixture terminal cleanup failed/);
    assert.match(result.stderr, /fixture runtime closure failed/);
  },
);

test(
  'closing native drops queued RPCs and suppresses late results without replay',
  { timeout: 10000 },
  async (t) => {
    const native = runNative(t, { holdRuntime: true, holdDispatch: true });
    await native.waitFor('ready');
    native.command('service-change');
    await native.waitFor('snapshot.timer.scheduled');
    native.request('running-request', 'state');
    await native.waitFor('runtime.dispatch');
    native.request('queued-request', 'state');
    await native.waitFor('requests.submit', 2);
    assert.equal(count(native.events, 'requests.submit'), 2);
    native.child.kill('SIGTERM');
    await native.waitFor('runtime.close.enter');
    native.command('release-dispatch');
    await native.waitFor('runtime.dispatch.finished');
    native.command('release-runtime');
    const result = await native.exited;

    assertReleased(result, 0);
    assert.equal(count(result.events, 'runtime.dispatch'), 1);
  },
);

test(
  'native shutdown waits for reset and cannot revive terminals or subscriptions from its late completion',
  { timeout: 10000 },
  async (t) => {
    const native = runNative(t, {
      resetRequired: true,
      holdReset: true,
      holdRuntime: true,
      failTerminals: true,
    });
    await native.waitFor('ready');
    native.request('complete-reset', 'system.resetComplete', { confirmation: 'CLEAR' });
    await native.waitFor('reset.enter');
    native.child.kill('SIGTERM');
    await native.waitFor('runtime.close.enter');

    assert.equal(count(native.events, 'runtime.close.finished'), 0);
    native.command('release-reset');
    await native.waitFor('reset.finished');
    native.command('checkpoint');
    await native.waitFor('checkpoint');
    assert.equal(count(native.events, 'terminals.construct'), 1);
    assert.equal(count(native.events, 'service.subscribe'), 0);
    native.command('release-runtime');
    const result = await native.exited;

    assert.equal(result.code, 1, result.stderr);
    assert.equal(count(result.events, 'fixture.unhandled'), 0);
    assert.equal(count(result.events, 'runtime.close.finished'), 1);
    assert.equal(count(result.events, 'process.exit'), 1);
    assert.ok(result.events.indexOf('reset.finished') < result.events.indexOf('runtime.close.finished'));
    const decoder = new FrameDecoder();
    const frames = decoder.push(result.stdout);
    decoder.end();
    assert.equal(frames.length, 1);
    assert.equal(z.object({ event: z.literal('resetRequired') }).parse(frames[0]).event, 'resetRequired');
  },
);
