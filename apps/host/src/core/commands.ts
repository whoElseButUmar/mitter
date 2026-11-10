import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { listFiles } from './workspace.js';
import type { Profile } from '../../../../packages/protocol/src/index.js';
import { z } from 'zod';
import { commandProfileInputSchema } from '../../../../packages/protocol/src/rpc.js';
export { commandProfileInputSchema } from '../../../../packages/protocol/src/rpc.js';
import { RedactedOutput } from './redaction.js';
export { redact } from './redaction.js';
/** Best-effort refusal list, NOT a sandbox. A basename blocklist cannot prove
 * safety: reviewed approval of the full program+argv is the actual control, and
 * any approved program runs with your OS user permissions. See README.md. */
const BLOCKED_PROGRAMS = new Set([
  // privilege escalation and direct deletion
  'sudo',
  'su',
  'doas',
  'runuser',
  'rm',
  'del',
  'rmdir',
  'rd',
  'kill',
  'pkill',
  'killall',
  'taskkill',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'format',
  'diskpart',
  // shells and Windows script hosts
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'ash',
  'busybox',
  'cmd',
  'command',
  'powershell',
  'pwsh',
  'mshta',
  'wscript',
  'cscript',
  'rundll32',
  'regsvr32',
  'reg',
  // process launchers that smuggle a blocked program past the basename check
  'env',
  'nice',
  'nohup',
  'stdbuf',
  'timeout',
  'watch',
  'xargs',
  'parallel',
  'setsid',
  'script',
  'expect',
  'screen',
  'tmux',
  'dtach',
  'daemonize',
  // remote access, transfer and download
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'ftp',
  'tftp',
  'telnet',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'curl',
  'wget',
  'fetch',
  'aria2c',
  'axel',
  // arbitrary-code interpreters that are not the reviewed-script runtime
  'osascript',
  'osacompile',
  'awk',
  'gawk',
  'mawk',
  'perl',
  'ruby',
  'php',
  'lua',
  'luajit',
  'rscript',
  'r',
  'jshell',
  'ghci',
  'abcl',
  'tclsh',
  'wish',
  // schedulers and service control
  'crontab',
  'at',
  'launchctl',
  'systemctl',
  'service',
  'schtasks',
  'anacron',
]);
/** Interpreters allowed as programs (reviewed script files), with the inline
 * flags that would turn an argument into arbitrary code. */
const INTERPRETER_INLINE = new Map<string, RegExp>([
  ['node', /^(?:--(?:eval|print|require|import|loader|experimental-loader)(?:=|$)|-(?:e|p|r|c)(?:[^-].*)?$)/],
  ['deno', /^(?:eval|repl)(?:$|,)|^-e/],
  ['bun', /^(?:--eval|-e(?:$|=)|--require|-r(?:$|=))/],
  ['python', /^-(?:c|m=|i$)/],
  ['python3', /^-(?:c|m=|i$)/],
  ['python3.11', /^-(?:c|m=|i$)/],
]);

export function parseProfile(value: unknown): Profile {
  const profile = commandProfileInputSchema.parse(value);
  const program = profile.program;
  const base = path
    .basename(program)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '');

  if (BLOCKED_PROGRAMS.has(base)) {
    throw new Error(
      'This program is refused as a common shell, launcher, remote, download, ' +
        'or arbitrary-code shortcut. Register the specific tool you reviewed ' +
        'instead; approval of the full program and arguments is the real ' +
        'control, and every approved command runs with your OS user ' +
        'permissions.',
    );
  }

  const args = profile.args;
  const inline = INTERPRETER_INLINE.get(base);

  if (inline && args.some((argument) => inline.test(argument))) {
    throw new Error(
      'Inline code execution and injected loaders are disabled. Use a ' + 'reviewed project script.',
    );
  }

  if (base === 'git') {
    if (
      args.some((argument) =>
        [
          'push',
          'reset',
          'clean',
          'checkout',
          'restore',
          'rebase',
          'merge',
          'config',
          'filter-branch',
          'upload-archive',
        ].includes(argument),
      ) ||
      args.includes('-c') ||
      args.includes('--exec-path')
    ) {
      throw new Error(
        'Destructive, remote, configurable, and helper-executing Git operations ' + 'are disabled.',
      );
    }
  }

  if (
    base === 'find' &&
    args.some((argument) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprintf'].includes(argument))
  ) {
    throw new Error('find is limited to reading: -delete and -exec families are disabled.');
  }

  return profile;
}

export const commandResultSchema = z
  .object({
    code: z
      .number()
      .int()
      .nullable()
      .describe('The process exit status, or null when no exit code was observed.'),
    stdout: z.string().describe('Retained redacted standard output, bounded by the collector.'),
    stderr: z.string().describe('Retained redacted standard error, bounded by the collector.'),
    timedOut: z.boolean().describe('Whether the command exceeded its reviewed timeout.'),
    aborted: z.boolean().describe('Whether the owning run cancelled the command.'),
  })
  .describe('Bounded, redacted command output with explicit termination status.');

export type CommandResult = z.infer<typeof commandResultSchema>;

export async function runCommand(
  profile: Profile,
  root: string,
  scratch: string,
  signal: AbortSignal,
  onOutput?: (line: string) => void,
): Promise<CommandResult> {
  signal.throwIfAborted();
  await fs.mkdir(scratch, {
    recursive: true,
  });
  signal.throwIfAborted();
  // No inherited API keys, NODE_OPTIONS, PYTHONPATH, or credential-bearing environment.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: scratch,
    USERPROFILE: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    LANG: 'C.UTF-8',
    CI: '1',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
  };

  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot;
    env.WINDIR = process.env.WINDIR;
    env.PATHEXT = process.env.PATHEXT;
  }

  let program = profile.program;
  let args = [...profile.args]; // Windows npm/pnpm .cmd files need a shell. We refuse that implicit fallback.

  if (process.platform === 'win32' && /^(npm|pnpm|yarn)(\.cmd)?$/i.test(program)) {
    throw new Error(
      'On Windows use node.exe with the absolute path to the package manager ' +
        '.cjs/.js entrypoint as its first argument. See SETUP.md.',
    );
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutText = '';
    let stderrText = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let outputError: unknown;
    let stopping = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (hard = false) => {
      if (!child.pid) {
        return;
      }

      try {
        if (process.platform === 'win32') {
          // child.kill() only reaches the direct child; npm→tsc→esbuild trees
          // survive it. taskkill /T walks the whole descendant tree.
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          let signal: NodeJS.Signals = 'SIGTERM';

          if (hard) {
            signal = 'SIGKILL';
          }
          process.kill(-child.pid, signal);
        }
      } catch {
        /* already exited */
      }
    };
    const stop = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      kill();
      hardTimer = setTimeout(() => kill(true), 1000);
      hardTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, profile.timeoutMs);
    timer.unref();
    const abort = () => {
      aborted = true;
      stop();
    };
    signal.addEventListener('abort', abort, {
      once: true,
    });
    const collect = (kind: 'out' | 'err', text: string) => {
      if (kind === 'out') {
        stdoutText = (stdoutText + text).slice(-24000);
      } else {
        stderrText = (stderrText + text).slice(-24000);
      }

      if (outputError === undefined) {
        try {
          onOutput?.(text.slice(0, 3000));
        } catch (error) {
          outputError = error ?? new Error('Command output reporting failed.');
          stop();
        }
      }
    };
    const stdout = new RedactedOutput((text) => collect('out', text));
    const stderr = new RedactedOutput((text) => collect('err', text));
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdout.once('end', () => stdout.end());
    child.stderr.once('end', () => stderr.end());
    const clean = () => {
      clearTimeout(timer);

      if (hardTimer) {
        clearTimeout(hardTimer);
      }
      signal.removeEventListener('abort', abort);
    };
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clean();
        reject(error);
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        kill(true);
        clean();

        if (outputError !== undefined) {
          reject(outputError);
        } else {
          resolve({
            code,
            stdout: stdoutText,
            stderr: stderrText,
            timedOut,
            aborted,
          });
        }
      }
    });
  });
}

export async function gitDiff(root: string, scratch: string, signal: AbortSignal): Promise<CommandResult> {
  const files = await listFiles(root, '.', 100);
  let readableFiles = files;

  if (!files.length) {
    readableFiles = ['.__mitter_no_readable_files__'];
  }

  return runCommand(
    {
      id: 'internal-diff',
      label: 'Git diff',
      program: 'git',
      args: [
        '--no-pager',
        '-c',
        'core.fsmonitor=false',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--',
        ...readableFiles,
      ],
      timeoutMs: 20000,
    },
    root,
    scratch,
    signal,
  );
}
