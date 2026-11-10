import { z } from 'zod';
import { isRecord } from '../types.js';

export type PtySubscription = {
  dispose(): void;
};

export type PtyExit = z.infer<typeof ptyExitSchema>;

export type PtyProcess = {
  pid: number;

  write(data: string): void;

  resize(cols: number, rows: number): void;

  kill(signal?: string): void;

  pause(): void;

  resume(): void;

  onData(callback: (data: string) => void): PtySubscription;

  onExit(callback: (event: PtyExit) => void): PtySubscription;
};

export type PtyOptions = {
  name: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  encoding: 'utf8';
};

export type PtyFactory = {
  spawn(shell: string, args: string[], options: PtyOptions): PtyProcess;
};
const ptyExitSchema = z
  .object({
    exitCode: z.number().int().describe('The native shell process exit status.'),
    signal: z
      .number()
      .int()
      .optional()
      .describe('The numeric terminating OS signal, when reported by node-pty.'),
  })
  .describe('A checked native PTY process-exit event.');

function nativeMethod(resource: Record<string, unknown>, name: string) {
  const method = resource[name];

  if (typeof method !== 'function') {
    throw new Error('Missing native PTY method: ' + name + '.');
  }

  return (...arguments_: unknown[]): unknown => {
    const result: unknown = Reflect.apply(method, resource, arguments_);

    return result;
  };
}

function subscription(value: unknown): PtySubscription {
  if (!isRecord(value)) {
    throw new Error('Native PTY subscription is not a resource.');
  }

  const dispose = nativeMethod(value, 'dispose');

  return {
    dispose() {
      dispose();
    },
  };
}

export function adaptPtyProcess(value: unknown): PtyProcess {
  if (!isRecord(value)) {
    throw new Error('Native PTY did not return a process resource.');
  }

  const pid = z.number().int().positive().parse(value.pid);
  const write = nativeMethod(value, 'write');
  const resize = nativeMethod(value, 'resize');
  const kill = nativeMethod(value, 'kill');
  const pause = nativeMethod(value, 'pause');
  const resume = nativeMethod(value, 'resume');
  const onData = nativeMethod(value, 'onData');
  const onExit = nativeMethod(value, 'onExit');

  return {
    pid,
    write(data) {
      write(data);
    },
    resize(cols, rows) {
      resize(cols, rows);
    },
    kill(signal) {
      kill(signal);
    },
    pause() {
      pause();
    },
    resume() {
      resume();
    },
    onData(callback) {
      return subscription(onData((data: unknown) => callback(z.string().parse(data))));
    },
    onExit(callback) {
      return subscription(onExit((event: unknown) => callback(ptyExitSchema.parse(event))));
    },
  };
}

/** Never assign an unchecked require() result to the typed factory. */

export function adaptPtyFactory(value: unknown): PtyFactory {
  if (!isRecord(value)) {
    throw new Error('Native PTY module is not an object.');
  }

  let resource = value;

  if (typeof resource.spawn !== 'function') {
    if (!isRecord(resource.default)) {
      throw new Error('Missing native PTY factory.');
    }
    resource = resource.default;
  }

  const spawn = nativeMethod(resource, 'spawn');

  return {
    spawn(shell, args, options) {
      return adaptPtyProcess(spawn(shell, args, options));
    },
  };
}
