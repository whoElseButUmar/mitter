import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { TerminalManager } from '../src/core/terminal.js';
import { prepareNativeTerminal } from '../src/core/pty-runtime.js';
import { snapshotSchema } from '../../../packages/protocol/src/index.js';
import { TerminalInfoSchema, TerminalReadSchema } from '../../../packages/terminal/src/protocol.js';

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
      workers: [],
      events: [],
      settings: { coderModelPath: '', contextSize: 8192, maxTokens: 2048, gpu: 'auto' },
      runtime: { node: process.version, workflow: 'standalone smoke', models: 'not invoked' },
    });
    manager = new TerminalManager(
      () => snapshot,
      async () => ({
        spawn(shell, args, options) {
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
