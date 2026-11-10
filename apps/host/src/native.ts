import { TerminalManager } from './core/terminal.js';
import { TERMINAL_METHODS } from '../../../packages/terminal/src/protocol.js';
import { RequestQueue } from './core/request-queue.js';
import { randomUUID } from 'node:crypto';
import { nativeMessages } from '../../../packages/protocol/src/native-transfer.js';
import { OutputQueue } from './core/output-queue.js';
import { openRuntime, defaultDataDir } from './runtime.js';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, encodeFrame } from './core/framing.js';
import { parseRequest, EXTENSION_ORIGIN } from '../../../packages/protocol/src/index.js';
import { errorMessage } from './core/types.js';
const portable = process.argv.includes('--portable');
const origin = process.argv.find((a) => a.startsWith('chrome-extension://'));

if (!origin || origin !== EXTENSION_ORIGIN) {
  process.stderr.write(
    'Mitter native host must be started by a registered Chrome extension. ' +
      'Use cli.js for terminal access.\n',
  );
  process.exit(1);
}
// Chrome can launch the registered shim from ~/.mitter/native. That is
// infrastructure inside the state tree, not a user workspace. Pin the native
// process to its installation, while retaining the original resolution of a
// relative MITTER_HOME. Do not relax the reset validator's cwd/home safeguards.
const dataDir = defaultDataDir();
process.chdir(fileURLToPath(new URL('../../../../', import.meta.url)));
const runtime = await openRuntime({
  portable,
  dataDir,
});
let terminals = new TerminalManager(() => runtime.service.snapshot());
const decoder = new FrameDecoder();
let closing = false;
let resetGate = runtime.resetRequired;
let resetBusy = false; // Backpressure-aware writes; stdout is reserved EXCLUSIVELY for native frames.
const output = new OutputQueue(
  async (message) => {
    for (const part of nativeMessages(message, randomUUID())) {
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(encodeFrame(part), (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  },
  (error) => {
    process.stderr.write(errorMessage(error) + '\n');
    void close();
  },
);

function send(message: unknown) {
  if (!closing) {
    output.send(message);
  }
}

let updateTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: undefined | (() => void);

function subscribe() {
  if (closing) {
    return;
  }

  unsubscribe?.();
  unsubscribe = runtime.service.subscribe(() => {
    if (updateTimer || closing || resetGate) {
      return;
    }
    updateTimer = setTimeout(() => {
      updateTimer = undefined;

      if (!closing && !resetGate) {
        send({
          event: 'snapshot',
          data: runtime.service.snapshot(),
        });
      }
    }, 120);
  });
}

if (!resetGate) {
  subscribe();
}

const requests = new RequestQueue((error) => process.stderr.write(errorMessage(error) + '\n'));
process.stdin.on('data', (chunk: unknown) => {
  if (closing) {
    return;
  }

  try {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error('Native input must be bytes.');
    }

    for (const message of decoder.push(chunk)) {
      if (closing) {
        return;
      }

      let request;

      try {
        request = parseRequest(message);
      } catch (error) {
        send({
          id: 'invalid',
          ok: false,
          error: errorMessage(error),
        });
        continue;
      }

      if (
        request.method === 'system.resetPrepare' ||
        request.method === 'system.reset' ||
        request.method === 'system.resetComplete'
      ) {
        if (request.params.confirmation !== 'CLEAR') {
          send({
            id: request.id,
            ok: false,
            error: 'Type exactly CLEAR to reset all Miter data.',
          });
          continue;
        }

        if (resetBusy) {
          send({
            id: request.id,
            ok: false,
            error: 'A data reset is already running.',
          });
          continue;
        }
        resetGate = true;
        resetBusy = true;

        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }

        const selected = request;
        void (async () => {
          try {
            if (selected.method === 'system.resetPrepare') {
              const result = await runtime.prepareReset(
                selected.params.confirmation,
                () => terminals.reset(),
                () => requests.whenIdle(),
              );
              send({
                id: selected.id,
                ok: true,
                result,
              });
            } else if (selected.method === 'system.reset') {
              const result = await runtime.reset(
                selected.params.confirmation,
                () => terminals.reset(),
                () => requests.whenIdle(),
              );
              send({
                id: selected.id,
                ok: true,
                result,
              });
            } else {
              const result = await runtime.completeReset(selected.params.confirmation);

              if (closing) {
                return;
              }

              terminals = new TerminalManager(() => runtime.service.snapshot());
              resetGate = false;
              subscribe();
              send({
                id: selected.id,
                ok: true,
                result,
              });
              send({
                event: 'snapshot',
                data: runtime.service.snapshot(),
              });
            }
          } catch (error) {
            send({
              id: selected.id,
              ok: false,
              error: 'Data reset incomplete: ' + errorMessage(error),
            });
          } finally {
            resetBusy = false;
          }
        })();
        continue;
      }

      const execute = async () => {
        if (closing) {
          return;
        }

        if (resetGate) {
          send({
            id: request.id,
            ok: false,
            error: 'Data reset is incomplete or running. No work was executed.',
          });
          return;
        }

        try {
          if (TERMINAL_METHODS.has(request.method)) {
            const result = await terminals.dispatch(request.method, request.params);
            send({
              id: request.id,
              ok: true,
              result,
            });
          } else {
            send(await runtime.service.dispatch(request));
          }
        } catch (error) {
          send({
            id: request.id,
            ok: false,
            error: errorMessage(error),
          });
        }
      };

      if (!requests.submit(request.method, execute)) {
        send({
          id: request.id,
          ok: false,
          error:
            'The local host is busy. This request was not executed; wait for ' +
            'current work before retrying.',
        });
      }
    }
  } catch (error) {
    process.stderr.write('Invalid native message: ' + errorMessage(error) + '\n');
    void close();
  }
});

async function close() {
  if (closing) {
    return;
  }
  closing = true;
  const stopUpdates = unsubscribe;
  const pendingUpdate = updateTimer;
  unsubscribe = undefined;
  updateTimer = undefined;

  const failures: string[] = [];
  const cleanupSteps = [
    { resource: 'terminals', release: () => terminals.close() },
    { resource: 'request queue', release: () => requests.close() },
    { resource: 'output queue', release: () => output.close() },
    { resource: 'snapshot subscription', release: () => stopUpdates?.() },
    {
      resource: 'snapshot timer',
      release: () => {
        if (pendingUpdate !== undefined) {
          clearTimeout(pendingUpdate);
        }
      },
    },
    { resource: 'stdin', release: () => process.stdin.pause() },
  ];

  for (const step of cleanupSteps) {
    try {
      step.release();
    } catch (error) {
      failures.push(step.resource + ': ' + errorMessage(error));
    }
  }

  try {
    await runtime.close();
  } catch (error) {
    failures.push('runtime: ' + errorMessage(error));
  }

  let exitCode = 0;

  if (failures.length) {
    exitCode = 1;

    try {
      process.stderr.write('Native shutdown:\n' + failures.join('\n') + '\n');
    } catch {
      // A broken diagnostic stream must not prevent the explicit failed exit.
    }
  }

  process.exit(exitCode);
}
process.stdin.on('end', () => {
  try {
    decoder.end();
  } catch (error) {
    process.stderr.write('Invalid native message: ' + errorMessage(error) + '\n');
  }
  void close();
});
process.stdout.on('error', () => void close());
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());

if (runtime.resetRequired) {
  send({
    event: 'resetRequired',
    error: 'A previous data reset did not finish. Retry Clear all Miter data.',
  });
} else {
  send({
    event: 'snapshot',
    data: runtime.service.snapshot(),
  });
}
