import { execFile, spawn } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { redact, RedactedOutput } from '../redaction.js';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { QUALITY_SANDBOX } from '../quality/readiness.js';
import { hasErrorCode } from '../types.js';

export type ProcessOptions = {
  cwd: string;
  scratch: string;
  executable: string;
  args: string[];
  signal: AbortSignal;
  store?: string;
  port?: number;
  production?: boolean;
  forceWasi?: boolean;
  portable?: boolean;
  preload?: string;
  onOutput?: (text: string) => void;
};

function sandbox(options: ProcessOptions): string[] {
  const params = new Map([
    ['EXE', options.executable],
    ['SCRATCH', options.scratch],
  ]);
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow sysctl-read)',
    '(allow file-read-metadata)',
    '(allow file-read* (literal "/") (literal (param "EXE")) (subpath (param "SCRATCH")) (subpath "/System/Library") (subpath "/usr/lib") (subpath "/private/var/db/timezone") (subpath "/dev/fd") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    '(allow file-write* (subpath (param "SCRATCH")) (literal "/dev/null"))',
    '(allow process-exec (literal (param "EXE")))',
    '(allow signal (target self) (target children))',
  ];
  if (options.store) {
    // Only the bundled installer gets network access. Its clean working directory contains
    // the registry manifest and optional lockfile; project code is added in a later phase.
    params.set('STORE', options.store);
    profile.push(
      '(allow file-read* file-write* (subpath (param "STORE")))',
      '(allow file-read* (subpath "/private/etc/ssl") (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf") (literal "/private/var/run/resolv.conf"))',
      '(allow mach-lookup (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.networkd") (global-name "com.apple.trustd.agent") (global-name "com.apple.trustd"))',
      '(allow network-outbound (literal "/private/var/run/mDNSResponder") (remote tcp "*:443"))',
    );
  } else {
    // Vite's optimizer and Next's server workers execute their platform binaries and Node.
    // Every descendant inherits these same filesystem and network restrictions.
    params.set('MODULES', path.join(options.cwd, 'node_modules'));
    profile.push(
      '(allow process-fork)',
      '(allow process-exec (subpath (param "MODULES")))',
      '(allow mach-lookup (global-name "com.apple.FSEvents"))',
    );
    if (options.port) {
      profile.push('(allow network-inbound network-bind (local tcp "localhost:' + options.port + '"))');
    }
    profile.push('(allow network-bind network-inbound network-outbound (subpath (param "SCRATCH")))');
  }
  const args: string[] = [];
  for (const [name, value] of params) {
    args.push('-D', name + '=' + value);
  }
  return [...args, '-p', profile.join('\n'), options.executable, ...options.args];
}

export function launchProcess(options: ProcessOptions) {
  options.signal.throwIfAborted();
  const { scratch } = options;
  const home = path.join(scratch, 'home');
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_RUNTIME_DIR: path.join(scratch, 'tmp'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    TMPDIR: path.join(scratch, 'tmp'),
    PATH: path.dirname(process.execPath),
    LANG: 'en_US.UTF-8',
    CI: '1',
    NO_COLOR: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: '/dev/null',
    CHOKIDAR_USEPOLLING: 'true',
    WATCHPACK_POLLING: 'true',
  };
  if (options.store) {
    // pnpm coordinates simultaneous installs through per-user XDG runtime locks.
    env.XDG_RUNTIME_DIR = options.store;
  }
  if (options.forceWasi) {
    env.NAPI_RS_FORCE_WASI = 'error';
  }
  if (options.portable) {
    // Chrome-quarantined packages must not enter dyld, including optional file watchers.
    // Node reports disabled addons immediately so frameworks can select their JS/WASM paths.
    env.NODE_OPTIONS = '--no-addons';
    if (options.preload) {
      env.NODE_OPTIONS += ' --require=' + JSON.stringify(options.preload);
    }
  }
  if (options.production) {
    env.NODE_ENV = 'production';
  }
  const child = spawn(QUALITY_SANDBOX, sandbox(options), {
    cwd: options.cwd,
    env,
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ended = false;
  let tail = '';
  let error: Error | undefined;
  const collect = (text: string) => {
    const plain = stripVTControlCharacters(text);
    tail = (tail + plain).slice(-16_384);
    options.onOutput?.(plain);
  };
  // Keep the streams separate so interleaved or split credentials cannot be exposed.
  for (const stream of [child.stdout, child.stderr]) {
    const output = new RedactedOutput(collect);
    stream.on('data', (chunk: Buffer) => output.push(chunk));
    stream.on('end', () => output.end());
  }
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (cause) {
      if (!hasErrorCode(cause, 'ESRCH')) {
        child.kill(signal);
      }
    }
  };
  const cancel = () => kill('SIGKILL');
  options.signal.addEventListener('abort', cancel, { once: true });
  const finished = new Promise<number | null>((resolve) => {
    child.once('error', (cause) => {
      error = cause;
    });
    // A parent can exit before its descendants close inherited pipes.
    child.once('exit', cancel);
    child.once('close', (code) => {
      ended = true;
      options.signal.removeEventListener('abort', cancel);
      resolve(code);
    });
  });
  if (options.signal.aborted) {
    cancel();
  }
  return {
    pid: child.pid,
    finished,
    get ended() {
      return ended;
    },
    detail() {
      return redact(error?.message || tail)
        .replace(/\u001b\[[\d;]*m/g, '')
        .trim()
        .slice(-3200);
    },
    async close() {
      if (!ended) {
        kill('SIGTERM');
        const timer = setTimeout(cancel, 750);
        timer.unref();
        try {
          await finished;
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
}

export async function runStage(options: ProcessOptions, label: string, timeoutMs: number) {
  const bounded = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
  const child = launchProcess({ ...options, signal: bounded });
  const code = await child.finished;
  options.signal.throwIfAborted();
  if (bounded.aborted) {
    throw new Error(label + ' exceeded its time limit. ' + child.detail());
  }
  if (code !== 0) {
    throw new Error(label + ' failed. ' + child.detail());
  }
}

// Selection reserves a fresh port, but the framework must bind it itself. Confirm the
// actual listener belongs to this launch (Next uses a child), even if another process
// claimed the port between selection and startup.
async function ownsListener(url: URL, pid: number | undefined, signal: AbortSignal) {
  if (!pid) {
    return false;
  }
  try {
    const { stdout } = await promisify(execFile)(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-g', String(pid), '-iTCP:' + url.port, '-sTCP:LISTEN', '-Fn'],
      { signal, timeout: 3000, maxBuffer: 32 * 1024 },
    );
    return stdout.split('\n').includes('n127.0.0.1:' + url.port);
  } catch {
    return false;
  }
}

export async function waitForPage(
  url: string,
  process: ReturnType<typeof launchProcess>,
  signal: AbortSignal,
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  let lastStatus = '';
  const address = new URL(url);
  while (!deadline.aborted && !process.ended) {
    try {
      if (await ownsListener(address, process.pid, deadline)) {
        const response = await fetch(address, {
          signal: AbortSignal.any([deadline, AbortSignal.timeout(4000)]),
          redirect: 'manual',
        });
        await response.body?.cancel();
        if (response.status >= 200 && response.status < 400) {
          return;
        }
        lastStatus = ' HTTP ' + response.status;
        if (response.status >= 400) {
          break;
        }
      }
    } catch {
      /* Wait through initial compilation and port startup. */
    }
    try {
      await delay(150, undefined, { signal: deadline });
    } catch {
      break;
    }
  }
  signal.throwIfAborted();
  if (process.ended) {
    throw new Error('The framework server exited before the app opened. ' + process.detail());
  }
  throw new Error(
    'The framework server could not serve its entry page.' + lastStatus + ' ' + process.detail(),
  );
}
