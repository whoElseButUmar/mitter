import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

/** POSIX process groups keep npx, pnpm and their build descendants inside the same timeout. */
export async function runBounded({ cwd, env, args, log, timeoutMs, signal }) {
  signal?.throwIfAborted();
  if (process.platform === 'win32') {
    throw new Error('Bounded processes require POSIX process-group cleanup (macOS or Linux).');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new Error('timeoutMs must be an integer between 1 and 2147483647 ms.');
  }

  let output;
  let child;
  let failed = false;
  let failure;

  function fail(error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }

  function killGroup() {
    if (child?.pid === undefined) {
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error instanceof Error && error.code === 'ESRCH') {
        return;
      }
      fail(error);
      try {
        child.kill('SIGKILL');
      } catch (killError) {
        fail(killError);
      }
    }
  }

  function interrupt() {
    fail(signal.reason);
    killGroup();
  }

  const timer = setTimeout(() => {
    fail(new Error(`Timed out after ${timeoutMs} ms: node ${args.join(' ')}`));
    killGroup();
  }, timeoutMs);

  try {
    signal?.addEventListener('abort', interrupt, { once: true });
    if (signal?.aborted) {
      interrupt();
    }
    output = await open(log, 'a');
    // Opening is not cancellable: wait for it, close its handle, and never launch cancelled work.
    if (failed) {
      throw failure;
    }
    child = spawn(process.execPath, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', output.fd, output.fd],
    });
    child.on('error', fail);
    await new Promise((resolve) => {
      child.once('close', (code, exitSignal) => {
        if (code !== 0) {
          fail(new Error(`node ${args.join(' ')} exited ${code} (${exitSignal}). See ${log}`));
        }
        resolve();
      });
      if (failed) {
        killGroup();
      }
    });
  } catch (error) {
    fail(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', interrupt);
    killGroup();
    child?.removeListener('error', fail);
    try {
      await output?.close();
    } catch (error) {
      fail(error);
    }
  }

  if (failed) {
    throw failure;
  }
}
