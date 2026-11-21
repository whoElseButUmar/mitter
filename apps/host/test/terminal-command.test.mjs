import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { APP_VERSION, EXTENSION_ORIGIN } from '../../../packages/protocol/src/index.ts';
import { NativeMessageInbox } from '../../../packages/protocol/src/native-transfer.ts';
import { TERMINAL_CONTROL_DESCRIPTOR } from '../../../packages/protocol/src/terminal-control.ts';
import { FrameDecoder, encodeFrame } from '../src/core/framing.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const nativeSource = fileURLToPath(new URL('../src/native.ts', import.meta.url));
const cliSource = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const sourceLoader = fileURLToPath(
  new URL('../../../packages/bridge/src/runner/test-source-loader.mjs', import.meta.url),
);

async function bounded(promise, message, milliseconds = 15000) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function openNative(dataDir) {
  const child = spawn(
    process.execPath,
    ['--import', sourceLoader, nativeSource, EXTENSION_ORIGIN, '--portable'],
    {
      cwd: root,
      env: { ...process.env, MITTER_HOME: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const decoder = new FrameDecoder();
  const inbox = new NativeMessageInbox();
  const ready = Promise.withResolvers();
  const exit = Promise.withResolvers();
  const pending = new Map();
  let stderr = '';
  let finished = false;
  const rejectPending = (error) => {
    ready.reject(error);

    for (const request of pending.values()) {
      request.reject(error);
    }

    pending.clear();
  };

  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-256000);
  });
  child.stdout.on('data', (chunk) => {
    try {
      for (const frame of decoder.push(chunk)) {
        const message = inbox.accept(frame);

        if (message?.event === 'snapshot') {
          ready.resolve(message.data);
        } else if (message?.id) {
          const request = pending.get(message.id);

          if (request) {
            pending.delete(message.id);

            if (message.ok) {
              request.resolve(message.result);
            } else {
              request.reject(new Error(message.error));
            }
          }
        }
      }
    } catch (error) {
      rejectPending(error);
    }
  });
  child.on('error', rejectPending);
  child.stdin.on('error', rejectPending);
  child.on('close', (code, signal) => {
    finished = true;
    exit.resolve({ code, signal, stderr });
    rejectPending(new Error('Native host exited before its response: ' + stderr));
  });

  return {
    ready: bounded(ready.promise, 'Native host did not publish its initial snapshot.'),
    exited: exit.promise,
    end: () => child.stdin.end(),
    async request(method, params) {
      const id = randomUUID();
      const response = Promise.withResolvers();
      pending.set(id, response);

      try {
        child.stdin.write(encodeFrame({ id, method, params }));
        return await bounded(response.promise, 'Native request timed out: ' + method);
      } finally {
        pending.delete(id);
      }
    },
    async cleanup() {
      if (!finished) {
        child.kill('SIGKILL');
        await bounded(exit.promise, 'Native fixture did not exit after forced cleanup.', 5000);
      }
    },
  };
}

function runCli(dataDir, args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', sourceLoader, cliSource, ...args],
      {
        cwd: root,
        env: { ...process.env, MITTER_HOME: dataDir },
        timeout: 15000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }

        let code = 0;

        if (error) {
          code = error.code;
        }

        resolve({ code, stdout, stderr });
      },
    );
  });
}

function jsonResult(result) {
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'Each one-shot JSON command should print one complete record.');
  return JSON.parse(lines[0]);
}

test(
  'real terminal commands share the native owner, preserve retries, and close without a second database',
  { timeout: 60000 },
  async (context) => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'miter-terminal-command-')));
    const dataDir = path.join(directory, 'state');
    const projectPath = path.join(directory, 'project');
    const goalFile = path.join(directory, 'brief.txt');
    const goal = '  Build a café booking app.\nKeep the exact literal `$HOME` and whitespace.\n';
    await fs.writeFile(goalFile, goal, 'utf8');
    const native = openNative(dataDir);
    context.after(async () => {
      try {
        await native.cleanup();
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });

    const initial = await native.ready;
    assert.equal(initial.runtime.version, APP_VERSION);
    assert.deepEqual(initial.workers, []);
    const sessionId = randomUUID();
    const heartbeat = () =>
      native.request('terminal.claim', { sessionId, version: APP_VERSION, available: false });
    assert.deepEqual(await heartbeat(), { command: null });
    const descriptorPath = path.join(dataDir, TERMINAL_CONTROL_DESCRIPTOR);
    const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
    assert.ok((await fs.stat(descriptor.socketPath)).isSocket());

    const requestId = randomUUID();
    const args = [
      'start',
      '--project',
      projectPath,
      '--create',
      '--goal-file',
      goalFile,
      '--request-id',
      requestId,
      '--max-turns',
      '7',
      '--max-minutes',
      '12',
      '--json',
    ];
    const started = jsonResult(await runCli(dataDir, args));
    assert.equal(started.type, 'operation');
    assert.equal(started.requestId, requestId);
    assert.equal(started.state, 'queued');
    assert.ok(started.workerId);
    assert.ok((await fs.stat(projectPath)).isDirectory());

    await heartbeat();
    const repeated = jsonResult(await runCli(dataDir, args));
    assert.deepEqual(repeated, started, 'An exact retry must return its original receipt and task.');
    const status = jsonResult(await runCli(dataDir, ['status', started.workerId, '--json']));
    assert.equal(status.type, 'status');
    assert.equal(status.worker.id, started.workerId);
    assert.equal(status.worker.projectPath, projectPath);
    assert.equal(status.worker.goal, goal);
    assert.deepEqual(status.worker.expectedRun, started.expectedRun);
    assert.equal(status.browserConnected, true);
    const listed = jsonResult(await runCli(dataDir, ['list', '--json']));
    assert.equal(listed.type, 'list');
    assert.deepEqual(
      listed.tasks.map((worker) => worker.id),
      [started.workerId],
    );

    // This fixture acknowledges dispatch only; it never opens Chrome or runs a model.
    const claim = await native.request('terminal.claim', {
      sessionId,
      version: APP_VERSION,
      available: true,
    });
    assert.deepEqual(claim.command, {
      requestId,
      workerId: started.workerId,
      expectedRun: started.expectedRun,
      claimToken: claim.command.claimToken,
      kind: 'start',
      consent: true,
      maxTurns: 7,
      maxMinutes: 12,
    });
    const completion = { sessionId, requestId, claimToken: claim.command.claimToken, ok: true };
    assert.deepEqual(await native.request('terminal.complete', completion), { recorded: true });
    assert.deepEqual(await native.request('terminal.complete', completion), { recorded: true });
    const operation = jsonResult(await runCli(dataDir, ['operation', requestId, '--json']));
    assert.equal(operation.state, 'succeeded');
    assert.equal(operation.workerId, started.workerId);
    assert.deepEqual(
      await native.request('terminal.claim', { sessionId, version: APP_VERSION, available: true }),
      { command: null },
    );
    const acknowledged = jsonResult(await runCli(dataDir, ['status', started.workerId, '--json']));
    assert.equal(acknowledged.worker.state, 'idle');
    assert.equal(acknowledged.worker.completion, undefined);

    await heartbeat();
    const resumeId = randomUUID();
    const resumeArgs = ['resume', started.workerId, '--request-id', resumeId, '--json'];
    const resumed = jsonResult(await runCli(dataDir, resumeArgs));
    assert.equal(resumed.kind, 'resume');
    assert.equal(resumed.state, 'queued');
    assert.equal(resumed.workerId, started.workerId);
    assert.deepEqual(resumed.expectedRun, started.expectedRun);
    assert.deepEqual(jsonResult(await runCli(dataDir, resumeArgs)), resumed);
    const resumeClaim = await native.request('terminal.claim', {
      sessionId,
      version: APP_VERSION,
      available: true,
    });
    assert.deepEqual(resumeClaim.command, {
      requestId: resumeId,
      kind: 'resume',
      workerId: started.workerId,
      expectedRun: started.expectedRun,
      claimToken: resumeClaim.command.claimToken,
    });
    assert.deepEqual(
      await native.request('terminal.complete', {
        sessionId,
        requestId: resumeId,
        claimToken: resumeClaim.command.claimToken,
        ok: true,
      }),
      { recorded: true },
    );
    assert.equal(jsonResult(await runCli(dataDir, ['operation', resumeId, '--json'])).state, 'succeeded');
    const afterResume = jsonResult(await runCli(dataDir, ['status', started.workerId, '--json']));
    assert.deepEqual(afterResume.worker, acknowledged.worker, 'Dispatch must not reset or run local work.');
    assert.deepEqual(
      jsonResult(await runCli(dataDir, ['list', '--json'])).tasks.map((worker) => worker.id),
      [started.workerId],
      'Resume must not create another task.',
    );

    native.end();
    const closed = await bounded(native.exited, 'Native host did not close after stdin ended.');
    assert.equal(closed.code, 0, closed.stderr);
    await assert.rejects(fs.stat(descriptorPath), { code: 'ENOENT' });
    await assert.rejects(fs.stat(descriptor.socketPath), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.dirname(descriptor.socketPath)), { code: 'ENOENT' });
    const files = (await fs.readdir(dataDir)).sort();
    const database = await fs.readFile(path.join(dataDir, 'mitter.sqlite'));
    const offline = await runCli(dataDir, ['status', started.workerId, '--json']);
    assert.equal(offline.code, 1);
    assert.match(offline.stderr, /Open Miter in Chrome/);
    assert.equal(offline.stdout, '');
    assert.deepEqual((await fs.readdir(dataDir)).sort(), files);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'mitter.sqlite')), database);
    const absentState = path.join(directory, 'never-opened-state');
    const absent = await runCli(absentState, ['list', '--json']);
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /Open Miter in Chrome/);
    await assert.rejects(fs.stat(absentState), { code: 'ENOENT' });
  },
);
