import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hasErrorCode } from '../types.js';
import { QUALITY_SANDBOX } from './readiness.js';

const MAX_OUTPUT_BYTES = 64 * 1024;

export type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  stopped: string | undefined;
};

// This probe intentionally has no Node permissions: the OS must enforce these
// denials independently before any supplied source can execute.
const SANDBOX_PROBE = `
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
const [outside, source, data, node] = process.argv.slice(2);
function refused(operation) {
  try {
    operation();
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      return;
    }
    throw error;
  }
  throw new Error('The operating-system sandbox did not enforce an isolation boundary.');
}
refused(() => fs.readFileSync(outside));
refused(() => fs.writeFileSync(outside, 'changed'));
refused(() => fs.writeFileSync(source + '/probe-write', 'changed'));
const probeData = fs.mkdtempSync(data + '/.miter-probe-');
refused(() => fs.linkSync(outside, probeData + '/outside-link'));
const child = spawnSync(node, ['--version']);
if (!child.error || !['EPERM', 'EACCES'].includes(child.error.code)) {
  throw new Error('The operating-system sandbox allowed a child process.');
}
const listener = net.createServer();
await new Promise((resolve, reject) => {
  listener.once('error', error => {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      resolve();
    } else {
      reject(error);
    }
  });
  listener.listen(0, '127.0.0.1', () => {
    listener.close();
    reject(new Error('The operating-system sandbox allowed a network listener.'));
  });
});
fs.writeFileSync(probeData + '/scratch', 'scratch works');
fs.unlinkSync(probeData + '/scratch');
fs.rmdirSync(probeData);
console.log('MITER_SANDBOX_READY');
`;

function sandboxArguments(node: string, source: string, data: string, probe: string): string[] {
  const parameters = new Map([
    ['NODE', node],
    ['SOURCE', source],
    ['DATA', data],
    ['PROBE', probe],
  ]);
  const ancestors = new Set<string>();
  for (const filename of [node, source, data, probe]) {
    let directory = path.dirname(filename);
    while (true) {
      ancestors.add(directory);
      if (directory === path.dirname(directory)) {
        break;
      }
      directory = path.dirname(directory);
    }
  }
  const metadata: string[] = [];
  for (const [index, directory] of [...ancestors].entries()) {
    const key = 'ANCESTOR_' + index;
    parameters.set(key, directory);
    metadata.push('(literal (param "' + key + '"))');
  }
  // Root-directory data access is required by dyld. Ancestors grant only
  // metadata, never their contents. No process-fork, network or IPC is allowed.
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec (literal (param "NODE")))',
    '(allow sysctl-read)',
    '(allow file-read-metadata ' + metadata.join(' ') + ')',
    '(allow file-read* (literal "/") (literal (param "NODE")) (literal (param "PROBE")) ' +
      '(subpath (param "SOURCE")) (subpath (param "DATA")) ' +
      '(subpath "/System/Library") (subpath "/usr/lib") ' +
      '(literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-write-data file-write-create file-write-unlink (subpath (param "DATA")))',
    '(deny file-write-unlink (literal (param "DATA")))',
    '(allow file-write-data (literal "/dev/null"))',
  ].join('\n');
  const args: string[] = [];
  for (const [key, value] of parameters) {
    args.push('-D', key + '=' + value);
  }
  return [...args, '-p', profile, node];
}

export async function execute(
  args: string[],
  source: string,
  data: string,
  signal: AbortSignal,
  timeout: number,
  input = '',
  outputLimit = MAX_OUTPUT_BYTES,
): Promise<ProcessResult> {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn(QUALITY_SANDBOX, args, {
      cwd: source,
      env: {
        HOME: data,
        TMPDIR: data,
        TMP: data,
        TEMP: data,
        MITER_TEST_DATA: data,
        PATH: '',
        LANG: 'C.UTF-8',
        CI: '1',
        NO_COLOR: '1',
      },
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => {
      // Early process exits can close stdin before the request is written.
    });
    child.stdin.end(input);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let retained = 0;
    let stopped: string | undefined;
    const stop = (reason: string) => {
      stopped ??= reason;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
            child.kill('SIGKILL');
          }
        }
      }
    };
    const collect = (destination: Buffer[], chunk: unknown) => {
      if (stopped) {
        return;
      }
      if (!Buffer.isBuffer(chunk)) {
        stop('Process output was not a byte stream.');
        return;
      }
      const remaining = outputLimit - retained;
      destination.push(chunk.subarray(0, remaining));
      retained += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        stop(
          'Process output exceeded the ' + Math.floor(outputLimit / 1024) + ' KiB combined UTF-8 byte limit.',
        );
      }
    };
    child.stdout.on('data', (chunk: unknown) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: unknown) => collect(stderr, chunk));
    const abort = () => stop('The owning task cancelled execution.');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    const timer = setTimeout(() => stop('Execution exceeded its time limit.'), timeout);
    timer.unref();
    child.once('error', (error) => {
      stopped ??= 'The isolated process could not start: ' + error.message;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        stopped,
      });
    });
  });
}

export async function verifiedNodeSandbox(
  scratch: string,
  source: string,
  data: string,
  signal: AbortSignal,
): Promise<string[]> {
  const node = await fs.realpath(process.execPath);
  const probe = path.join(scratch, 'probe.mjs');
  const outside = path.join(scratch, 'outside.txt');
  await fs.writeFile(probe, SANDBOX_PROBE, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(outside, 'Host-owned isolation sentinel.', { flag: 'wx', mode: 0o600 });
  const sandbox = sandboxArguments(node, source, data, probe);
  const result = await execute([...sandbox, probe, outside, source, data, node], source, data, signal, 5000);
  signal.throwIfAborted();
  if (result.code !== 0 || result.stopped || result.stdout !== 'MITER_SANDBOX_READY\n') {
    throw new Error(
      'Operating-system isolation could not be verified. ' +
        (result.stopped || result.stderr).split(scratch).join('<scratch>').slice(0, 2000),
    );
  }
  return [
    ...sandbox,
    '--permission',
    '--allow-fs-read=' + source,
    '--allow-fs-read=' + data,
    '--allow-fs-write=' + data,
    '--max-old-space-size=128',
    '--disable-sigusr1',
  ];
}

export async function removeScratch(directory: string): Promise<void> {
  // Supplied tests may create mode-000 directories. The child is already gone;
  // inspect entries without following symlinks before restoring traversal.
  try {
    if (!(await fs.lstat(directory)).isDirectory()) {
      await fs.unlink(directory);
      return;
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  await fs.chmod(directory, 0o700);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await removeScratch(path.join(directory, entry.name));
    }
  }
  await fs.rm(directory, { recursive: true, force: true });
}
