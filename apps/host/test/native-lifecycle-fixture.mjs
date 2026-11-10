import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { RequestQueue as ActualRequestQueue } from '../src/core/request-queue.js';
import { OutputQueue as ActualOutputQueue } from '../src/core/output-queue.js';
import { encodeFrame } from '../src/core/framing.js';
import { parseRequest } from '../../../packages/protocol/src/index.js';

const configurationSchema = z
  .strictObject({
    failTerminals: z.boolean().default(false).describe('Throw a terminal cleanup aggregate in this child.'),
    failRuntime: z.boolean().default(false).describe('Reject runtime closure after its barrier settles.'),
    failRequests: z.boolean().default(false).describe('Throw after closing the real request queue.'),
    failOutput: z.boolean().default(false).describe('Throw after closing the real output queue.'),
    failUnsubscribe: z.boolean().default(false).describe('Throw after removing the snapshot callback.'),
    failStdin: z.boolean().default(false).describe('Throw when the native entrypoint pauses stdin.'),
    failShutdownDiagnostics: z
      .boolean()
      .default(false)
      .describe('Throw when shutdown writes its final errors.'),
    holdRuntime: z.boolean().default(false).describe('Wait for the explicit runtime-release IPC command.'),
    holdDispatch: z
      .boolean()
      .default(false)
      .describe('Hold the first admitted RPC until explicitly released.'),
    holdReset: z.boolean().default(false).describe('Hold reset completion until explicitly released.'),
    resetRequired: z.boolean().default(false).describe('Start behind the native reset gate.'),
    reentrantClose: z
      .boolean()
      .default(false)
      .describe('Emit SIGTERM synchronously during terminal cleanup.'),
  })
  .describe('Controlled native-entrypoint lifecycle faults; no real state or PTY is opened.');
const configuration = configurationSchema.parse(JSON.parse(process.argv.at(-1) ?? '{}'));
const commandSchema = z
  .enum([
    'service-change',
    'release-runtime',
    'release-dispatch',
    'release-reset',
    'end',
    'output-error',
    'buffered-reset',
    'late-timer',
    'checkpoint',
  ])
  .describe('An explicit command to an isolated native lifecycle fixture.');

function trace(event) {
  if (process.connected && process.send) {
    process.send(event);
  }
}

const nativeUrl = new URL('../src/native.ts', import.meta.url).href;
const substitutedImports = new Set([
  './runtime.js',
  './core/terminal.js',
  './core/request-queue.js',
  './core/output-queue.js',
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === nativeUrl && substitutedImports.has(specifier)) {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const exitProcess = process.exit.bind(process);
process.exit = (code) => {
  trace('process.exit');
  return exitProcess(code);
};
process.on('unhandledRejection', (error) => {
  trace('fixture.unhandled');
  process.stderr.write('Fixture unhandled rejection: ' + String(error) + '\n');
  exitProcess(91);
});

const writeStdout = process.stdout.write.bind(process.stdout);
let ready = false;
process.stdout.write = (...arguments_) => {
  const result = writeStdout(...arguments_);

  if (!ready) {
    ready = true;
    trace('ready');
  }
  return result;
};
const writeStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (...arguments_) => {
  const message = arguments_[0];

  if (
    configuration.failShutdownDiagnostics &&
    typeof message === 'string' &&
    message.startsWith('Native shutdown:')
  ) {
    trace('shutdown.diagnostics.failed');
    throw new Error('fixture shutdown diagnostic write failed');
  }
  return writeStderr(...arguments_);
};
const pauseStdin = process.stdin.pause.bind(process.stdin);
process.stdin.pause = () => {
  trace('stdin.pause');

  if (configuration.failStdin) {
    throw new Error('fixture stdin pause failed');
  }
  return pauseStdin();
};

const scheduleTimeout = globalThis.setTimeout;
const cancelTimeout = globalThis.clearTimeout;
let snapshotTimer;
let snapshotCallback;
globalThis.setTimeout = (callback, delay, ...arguments_) => {
  let controlledDelay = delay;

  if (delay === 120) {
    // Parent commands control delivery, avoiding scheduling-sensitive timing assertions.
    controlledDelay = 60000;
  }
  const timer = scheduleTimeout(callback, controlledDelay, ...arguments_);

  if (delay === 120) {
    snapshotTimer = timer;
    snapshotCallback = callback;
    trace('snapshot.timer.scheduled');
  }
  return timer;
};
globalThis.clearTimeout = (timer) => {
  if (timer !== undefined && timer === snapshotTimer) {
    trace('snapshot.timer.cleared');
    snapshotTimer = undefined;
  }
  cancelTimeout(timer);
};

const runtimeRelease = Promise.withResolvers();
const dispatchRelease = Promise.withResolvers();
const resetRelease = Promise.withResolvers();
let activeReset;
let onChange;
let runtimeClosing = false;
const snapshot = {
  protocol: 'mitter/1',
  projects: [],
  workers: [],
  events: [],
  settings: { coderModelPath: '', contextSize: 8192, maxTokens: 2048, gpu: 'auto' },
  runtime: { node: process.version, workflow: 'fixture', models: 'fixture' },
};

export function defaultDataDir() {
  return path.join(tmpdir(), 'mitter-native-fixture-never-opened');
}

export async function openRuntime() {
  trace('runtime.open');

  return {
    resetRequired: configuration.resetRequired,
    service: {
      snapshot() {
        if (runtimeClosing) {
          trace('snapshot.after-close');
        }
        trace('service.snapshot');
        return snapshot;
      },
      subscribe(listener) {
        trace('service.subscribe');
        onChange = listener;

        return () => {
          trace('service.unsubscribe');
          onChange = undefined;

          if (configuration.failUnsubscribe) {
            throw new Error('fixture subscription cleanup failed');
          }
        };
      },
      async dispatch(request) {
        trace('runtime.dispatch');

        if (configuration.holdDispatch) {
          await dispatchRelease.promise;
        }
        trace('runtime.dispatch.finished');
        return { id: request.id, ok: true, result: { accepted: true } };
      },
    },
    async prepareReset() {
      trace('reset.prepare');
      return { prepared: true };
    },
    async reset() {
      trace('reset.clear');
      return { cleared: true };
    },
    async completeReset() {
      trace('reset.enter');

      if (runtimeClosing) {
        throw new Error('fixture reset admitted after shutdown');
      }

      if (configuration.holdReset) {
        activeReset = resetRelease.promise;
        await activeReset;
      }
      trace('reset.finished');
      return { cleared: true };
    },
    async close() {
      trace('runtime.close.enter');
      runtimeClosing = true;
      await activeReset;

      if (configuration.holdRuntime) {
        await runtimeRelease.promise;
      }
      trace('runtime.close.finished');

      if (configuration.failRuntime) {
        throw new Error('fixture runtime closure failed');
      }
    },
  };
}

export class TerminalManager {
  constructor() {
    trace('terminals.construct');
  }

  close() {
    trace('terminals.close');

    if (configuration.reentrantClose) {
      process.emit('SIGTERM');
    }

    if (configuration.failTerminals) {
      throw new AggregateError(
        [new Error('fixture PTY kill refused'), new Error('fixture terminal subscription failed')],
        'fixture terminal cleanup failed: PTY kill refused; terminal subscription failed',
      );
    }
  }

  async reset() {
    trace('terminals.reset');
  }
}

export class RequestQueue {
  constructor(onError) {
    this.queue = new ActualRequestQueue(onError);
  }

  submit(method, execute) {
    trace('requests.submit');
    return this.queue.submit(method, execute);
  }

  whenIdle() {
    return this.queue.whenIdle();
  }

  close() {
    trace('requests.close');
    this.queue.close();

    if (configuration.failRequests) {
      throw new Error('fixture request queue cleanup failed');
    }
  }
}

export class OutputQueue {
  constructor(write, onError) {
    this.queue = new ActualOutputQueue(write, onError);
  }

  send(message) {
    this.queue.send(message);
  }

  close() {
    trace('output.close');
    this.queue.close();

    if (configuration.failOutput) {
      throw new Error('fixture output queue cleanup failed');
    }
  }
}

process.on('message', (raw) => {
  const command = commandSchema.parse(raw);

  switch (command) {
    case 'service-change': {
      onChange?.();
      break;
    }
    case 'release-runtime': {
      runtimeRelease.resolve();
      break;
    }
    case 'release-dispatch': {
      dispatchRelease.resolve();
      break;
    }
    case 'release-reset': {
      resetRelease.resolve();
      break;
    }
    case 'end': {
      process.stdin.emit('end');
      break;
    }
    case 'output-error': {
      process.stdout.emit('error', new Error('fixture output failure'));
      break;
    }
    case 'buffered-reset': {
      const request = parseRequest({
        id: 'buffered-reset',
        method: 'system.resetComplete',
        params: { confirmation: 'CLEAR' },
      });
      process.stdin.emit('data', encodeFrame(request));
      break;
    }
    case 'late-timer': {
      snapshotCallback?.();
      break;
    }
    case 'checkpoint': {
      trace('checkpoint');
      break;
    }
  }
});
