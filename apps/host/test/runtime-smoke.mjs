import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { TerminalManager } from '../src/core/terminal.js';
import { prepareNativeTerminal } from '../src/core/pty-runtime.js';
import { snapshotSchema } from '../../../packages/protocol/src/index.js';
import { TerminalInfoSchema, TerminalReadSchema } from '../../../packages/terminal/src/protocol.js';
import { workerFixture } from './fixtures.mjs';

// Standalone, deliberately outside the *.test.mjs unit-suite glob. No runtime state is opened.
const clientId = 'runtime-smoke';
const ownedPids = new Set();
const watchdog = setTimeout(() => {
  for (const pid of ownedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The shell may have exited just before the timeout.
    }
  }
  console.error('Real PTY smoke exceeded its 25-second bound. No launch was retried.');
  process.exit(1);
}, 25000);
watchdog.unref();

function startupFreeArguments(shell) {
  switch (path.basename(shell)) {
    case 'zsh': {
      return ['-d', '-f'];
    }
    case 'bash': {
      return ['--noprofile', '--norc', '-i'];
    }
    case 'sh':
    case 'dash': {
      return ['-f', '-i'];
    }
    default: {
      throw new Error('No startup-file-free smoke arguments are defined for shell ' + shell + '.');
    }
  }
}

async function waitForOutput(manager, session, label, ready) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const result = TerminalReadSchema.parse(
      await manager.dispatch('terminal.read', {
        clientId,
        sessionId: session.id,
        after: session.after,
      }),
    );

    for (const frame of result.frames) {
      session.after = frame.seq;
      session.text += frame.data;
    }
    assert.ok(session.text.length < 64000, 'Smoke output must stay bounded.');

    if (ready(result, session.text)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Real PTY did not confirm ' + label + ' within five seconds.');
}

async function smoke() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mitter-real-pty-smoke-'));
  const root = await fs.realpath(temporary);
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  const scratch = path.join(root, 'tmp');
  let manager;

  try {
    await Promise.all([project, home, scratch].map((directory) => fs.mkdir(directory, { mode: 0o700 })));
    const environment = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      ZDOTDIR: home,
      TMPDIR: scratch,
      LANG: 'C.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Miter',
      PS1: 'smoke> ',
    };
    const native = await prepareNativeTerminal({ repair: false });
    console.log('Native dependency inspection:', JSON.stringify(native.check));
    const snapshot = snapshotSchema.parse({
      protocol: 'mitter/1',
      projects: [{ id: 'smoke-project', name: 'PTY smoke', root: project, profiles: [], revision: 0 }],
      workers: [{ ...workerFixture(), projectId: 'smoke-project' }],
      events: [],
      settings: { coderModelPath: '', contextSize: 8192, maxTokens: 2048, gpu: 'auto' },
      runtime: { node: process.version, workflow: 'standalone smoke', models: 'not invoked' },
    });
    manager = new TerminalManager(
      () => snapshot,
      async () => ({
        spawn(shell, args, options) {
          if (shell === process.execPath) {
            return native.factory.spawn(shell, args, {
              ...options,
              env: { ...environment, PATH: options.env.PATH },
            });
          }
          // Still the real checked factory and selected shell; only isolate env and disable rc files.
          const safeArguments = startupFreeArguments(shell);
          console.log('Real PTY launch:', shell, JSON.stringify(safeArguments));
          return native.factory.spawn(shell, safeArguments, { ...options, env: environment });
        },
      }),
    );
    const create = async () => {
      const info = TerminalInfoSchema.parse(
        await manager.dispatch('terminal.create', {
          clientId,
          projectId: 'smoke-project',
          cols: 80,
          rows: 24,
          confirm: true,
        }),
      );
      assert.ok(info.pid > 0);
      assert.notEqual(info.pid, process.pid);
      assert.equal(info.cwd, project);
      ownedPids.add(info.pid);
      console.log('Real shell PID:', info.pid);
      return { ...info, after: 0, text: '' };
    };
    const write = async (session, data) => {
      assert.deepEqual(
        await manager.dispatch('terminal.write', {
          clientId,
          sessionId: session.id,
          data,
        }),
        { written: true },
      );
    };
    const first = await create();
    await write(first, 'stty -echo; printf \'\\nHOME=%s\\nCWD=%s\\nPTY_ECHO_OK\\n\' "$HOME" "$PWD"\r');
    await waitForOutput(manager, first, 'echo/read and isolated HOME/cwd', (result, text) => {
      return (
        text.includes('\nHOME=' + home + '\r\n') &&
        text.includes('\nCWD=' + project + '\r\n') &&
        text.includes('\nPTY_ECHO_OK\r\n')
      );
    });
    assert.deepEqual(
      await manager.dispatch('terminal.resize', {
        clientId,
        sessionId: first.id,
        cols: 100,
        rows: 30,
      }),
      { resized: true },
    );
    await write(first, "printf '\\nPTY_SIZE='; stty size\r");
    await waitForOutput(manager, first, 'native resize', (result, text) => {
      return text.includes('\nPTY_SIZE=30 100\r\n');
    });
    await write(first, 'exit 0\r');
    const exited = await waitForOutput(manager, first, 'normal shell exit', (result) => result.exited);
    assert.equal(exited.exitCode, 0);
    assert.throws(() => process.kill(first.pid, 0), { code: 'ESRCH' });
    ownedPids.delete(first.pid);

    const manualSession = async () => {
      const receipt = Promise.withResolvers();
      const controller = new AbortController();
      const id = await manager.startManualSetup({
        projectId: 'smoke-project',
        workerId: 'worker',
        root: project,
        signal: controller.signal,
        onFinish(sessionId, result) {
          receipt.resolve({ sessionId, ...result });
        },
      });
      const info = TerminalInfoSchema.parse(
        await manager.dispatch('terminal.attach', { clientId, sessionId: id }),
      );
      const session = { ...info, after: 0, text: '' };
      ownedPids.add(info.pid);
      void receipt.promise.then(() => ownedPids.delete(info.pid));
      assert.equal(session.cwd, project);
      assert.equal(session.title, 'Project setup');
      await waitForOutput(manager, session, 'empty command prompt', (_result, text) =>
        text.includes('Setup command ›'),
      );
      return { session, receipt, controller };
    };
    const failed = await manualSession();
    await assert.rejects(fs.access(path.join(project, 'package.json')), { code: 'ENOENT' });
    let manifestCommand = `printf '%s' '{"name":"project"}' > package.json`;
    if (process.platform === 'darwin') {
      manifestCommand = 'pnpm init --yes --no-init-package-manager > /dev/null';
    }
    await write(
      failed.session,
      `unused=human-keyboard-only; ${manifestCommand} && printf 'setup-file-created\\n'; printf 'token=do-not-share-this\\n' >&2; exit 7\r`,
    );
    assert.deepEqual(await failed.receipt.promise, {
      sessionId: failed.session.id,
      code: 7,
      output: 'setup-file-created\ntoken=[REDACTED]',
    });
    assert.equal(JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8')).name, 'project');
    const interactive = await manualSession();
    await write(interactive.session, ':interactive\r');
    await waitForOutput(manager, interactive.session, 'full terminal prompt', (_result, text) =>
      text.includes('Full terminal mode.'),
    );
    await write(
      interactive.session,
      'test -t 0 && test -t 1 && test -t 2 && echo visible-only-in-terminal\r',
    );
    assert.deepEqual(await interactive.receipt.promise, {
      sessionId: interactive.session.id,
      code: 0,
      output: '',
    });
    const cancelled = await manualSession();
    cancelled.controller.abort();
    const cancellation = await cancelled.receipt.promise;
    assert.equal(cancellation.code, null);
    assert.match(cancellation.output, /closed/);
    const interrupted = await manualSession();
    await write(interrupted.session, 'echo $$ > child.pid; printf "CHILD_READY\\n"; exec sleep 60\r');
    await waitForOutput(manager, interrupted.session, 'running setup child', (_result, text) =>
      text.includes('\nCHILD_READY\r\n'),
    );
    const childPid = Number(await fs.readFile(path.join(project, 'child.pid'), 'utf8'));
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    interrupted.controller.abort();
    assert.equal((await interrupted.receipt.promise).code, null);
    const exitDeadline = Date.now() + 3000;
    while (Date.now() < exitDeadline) {
      try {
        process.kill(childPid, 0);
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    console.log(
      'PASS: project setup waits for keyboard input, creates package.json, reports redacted program output, supports interactive tools and cancels an empty prompt.',
    );

    const second = await create();
    await write(second, "stty -echo; printf '\\nPTY_RESET_READY\\n'\r");
    await waitForOutput(manager, second, 'live shell before reset', (result, text) => {
      return text.includes('\nPTY_RESET_READY\r\n');
    });
    await manager.reset();
    assert.throws(() => process.kill(second.pid, 0), { code: 'ESRCH' });
    ownedPids.delete(second.pid);
    await assert.rejects(create(), /terminal host is closed/);
    console.log('PASS: real PTY echo/read, isolated HOME/cwd, resize, exit, and confirmed reset.');
  } finally {
    await manager?.reset();
    await fs.rm(root, { recursive: true, force: true });
    clearTimeout(watchdog);
  }
}

try {
  await smoke();
} catch (error) {
  console.error('Real PTY smoke failed:', error);
  process.exitCode = 1;
}
