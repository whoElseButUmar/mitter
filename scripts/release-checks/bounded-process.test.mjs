import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runBounded } from './bounded-process.mjs';

const posix = { skip: process.platform === 'win32', timeout: 10000 };
const env = { PATH: process.env.PATH };

async function fixture(context) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mitter-bounded-test-'));
  context.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });
  return cwd;
}

async function waitForPids(log) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const match = /PIDS (\d+) (\d+)/.exec(await fs.readFile(log, 'utf8'));
      if (match) {
        return match.slice(1).map(Number);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    await delay(10);
  }
  throw new Error('Child did not report its descendant before the test deadline.');
}

async function assertStopped(pid) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
    });
    assert.ifError(status.error);
    assert.ok(status.status === 0 || status.status === 1);
    // An orphan can await reaping on Linux; a zombie cannot execute or retain open files.
    if (status.stdout.trim() === '' || status.stdout.trim().startsWith('Z')) {
      return;
    }
    await delay(10);
  }
  assert.fail('Process is still running: ' + pid);
}

function treeProgram(marker, exitCode) {
  const descendant =
    'process.on("SIGTERM", () => {});' +
    'setTimeout(() => require("node:fs").writeFileSync(' +
    JSON.stringify(marker) +
    ', "escaped"), 1200);' +
    'setTimeout(() => process.exit(0), 3000);';
  let program =
    'const child = require("node:child_process").spawn(process.execPath, ["-e", ' +
    JSON.stringify(descendant) +
    '], { stdio: "ignore" });' +
    'console.log("PIDS", process.pid, child.pid);';
  if (exitCode !== undefined) {
    program += 'setTimeout(() => process.exit(' + exitCode + '), 100);';
  } else {
    // A broken runner still cannot leave these tests waiting indefinitely.
    program += 'setTimeout(() => process.exit(0), 4000);';
  }
  return program;
}

test('retains stdout/stderr and rejects a real nonzero exit', posix, async (context) => {
  const cwd = await fixture(context);
  const log = path.join(cwd, 'build.log');
  const options = { cwd, env, log, timeoutMs: 5000 };
  await runBounded({ ...options, args: ['-e', 'console.log("stdout"); console.error("stderr");'] });
  assert.match(await fs.readFile(log, 'utf8'), /stdout\nstderr\n/);
  await assert.rejects(runBounded({ ...options, args: ['-e', 'process.exitCode = 7;'] }), /exited 7/);
});

for (const interruption of ['timeout', 'abort']) {
  test(interruption + ' stops a real child and descendant before returning', posix, async (context) => {
    const cwd = await fixture(context);
    const log = path.join(cwd, 'build.log');
    const marker = path.join(cwd, 'escaped-child');
    const controller = new AbortController();
    const reason = new Error('test interruption');
    const running = runBounded({
      cwd,
      env,
      log,
      args: ['-e', treeProgram(marker)],
      timeoutMs: 500,
      signal: controller.signal,
    });
    // Install the rejection handler immediately, even if readiness polling fails.
    let rejected;
    if (interruption === 'timeout') {
      rejected = assert.rejects(running, /Timed out after 500 ms/);
    } else {
      rejected = assert.rejects(running, (error) => error === reason);
    }
    try {
      const pids = await waitForPids(log);
      if (interruption === 'abort') {
        controller.abort(reason);
      }
      await rejected;
      for (const pid of pids) {
        await assertStopped(pid);
      }
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      await delay(1300);
      await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    } finally {
      controller.abort(reason);
      await rejected;
    }
  });
}

test('normal and nonzero leader exits also clean up surviving descendants', posix, async (context) => {
  const cwd = await fixture(context);
  for (const exitCode of [0, 7]) {
    const log = path.join(cwd, 'exit-' + exitCode + '.log');
    const marker = path.join(cwd, 'escaped-' + exitCode);
    const running = runBounded({
      cwd,
      env,
      log,
      timeoutMs: 5000,
      args: ['-e', treeProgram(marker, exitCode)],
    });
    if (exitCode === 0) {
      await running;
    } else {
      await assert.rejects(running, /exited 7/);
    }
    for (const pid of await waitForPids(log)) {
      await assertStopped(pid);
    }
  }
  await delay(1300);
  for (const exitCode of [0, 7]) {
    await assert.rejects(fs.access(path.join(cwd, 'escaped-' + exitCode)), { code: 'ENOENT' });
  }
});

test(
  'open/spawn failures and cancellation during opening release handles, timers and listeners',
  posix,
  async (context) => {
    const cwd = await fixture(context);
    const log = path.join(cwd, 'build.log');
    const handles = [];
    const timers = new Set();
    const realOpen = fs.open;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let afterOpen = async () => {};
    const openMock = context.mock.method(fs, 'open', async (...args) => {
      const handle = await realOpen(...args);
      handles.push(handle);
      await afterOpen();
      return handle;
    });
    const timerMock = context.mock.method(globalThis, 'setTimeout', (...args) => {
      const timer = realSetTimeout(...args);
      timers.add(timer);
      return timer;
    });
    const clearMock = context.mock.method(globalThis, 'clearTimeout', (timer) => {
      timers.delete(timer);
      realClearTimeout(timer);
    });
    syncBuiltinESMExports();
    try {
      for (const failure of ['open', 'sync spawn', 'async spawn', 'abort opening', 'timeout opening']) {
        const controller = new AbortController();
        const options = {
          cwd,
          env,
          log,
          timeoutMs: 5000,
          signal: controller.signal,
          args: ['-e', 'console.log("must not launch");'],
        };
        let expected = { code: 'ENOENT' };
        if (failure === 'open') {
          options.log = path.join(cwd, 'missing', 'log');
        } else if (failure === 'sync spawn') {
          options.cwd = 123;
          expected = { code: 'ERR_INVALID_ARG_TYPE' };
        } else if (failure === 'async spawn') {
          options.cwd = path.join(cwd, 'missing');
        } else if (failure === 'abort opening') {
          afterOpen = async () => controller.abort(null);
          expected = (error) => error === null;
        } else {
          afterOpen = async () => delay(50);
          options.timeoutMs = 10;
          expected = /Timed out after 10 ms/;
        }
        await assert.rejects(runBounded(options), expected);
        assert.ok(
          handles.every((handle) => handle.fd === -1),
          failure + ' closed every log descriptor',
        );
        assert.equal(timers.size, 0, failure + ' cleared its timer');
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        afterOpen = async () => {};
      }
      assert.equal(await fs.readFile(log, 'utf8'), '');
      const controller = new AbortController();
      controller.abort(0);
      await assert.rejects(
        runBounded({ cwd, env, log, args: [], timeoutMs: 5000, signal: controller.signal }),
        (error) => error === 0,
      );
      for (const timeoutMs of [0, -1, NaN, 2147483648]) {
        await assert.rejects(runBounded({ cwd, env, log, args: [], timeoutMs }), /timeoutMs must/);
      }
      assert.equal(timers.size, 0);
    } finally {
      for (const timer of timers) {
        realClearTimeout(timer);
      }
      for (const handle of handles) {
        if (handle.fd !== -1) {
          await handle.close();
        }
      }
      openMock.mock.restore();
      timerMock.mock.restore();
      clearMock.mock.restore();
      syncBuiltinESMExports();
    }
  },
);
