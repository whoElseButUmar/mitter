import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  TERMINAL_CONTROL_DESCRIPTOR,
  TERMINAL_CONTROL_MAX_BYTES,
  terminalControlRequestSchema,
  terminalControlResponseSchema,
  terminalDescriptorSchema,
  terminalListSchema,
  terminalOperationSchema,
  terminalPreviewResultSchema,
  terminalStatusSchema,
  type TerminalControlRequest,
  type TerminalControlResponse,
  type TerminalDescriptor,
  type TerminalStartParams,
  type TerminalPreviewParams,
  type TerminalStopParams,
  type TerminalResumeParams,
} from '../../../../../packages/protocol/src/terminal-control.js';
import { hasErrorCode } from '../types.js';

type TerminalCall =
  | { method: 'start'; params: TerminalStartParams }
  | { method: 'stop'; params: TerminalStopParams }
  | { method: 'resume'; params: TerminalResumeParams }
  | { method: 'preview'; params: TerminalPreviewParams }
  | { method: 'status'; params: { workerId: string } }
  | { method: 'operation'; params: { requestId: string } }
  | { method: 'list'; params: Record<string, never> };

export type TerminalClientOptions = {
  dataDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export class TerminalControlError extends Error {
  readonly delivery: 'not-sent' | 'unknown' | 'rejected';

  constructor(message: string, delivery: 'not-sent' | 'unknown' | 'rejected', cause?: unknown) {
    super(message, { cause });
    this.name = 'TerminalControlError';
    this.delivery = delivery;
  }
}

function unavailable(cause: unknown): TerminalControlError {
  return new TerminalControlError(
    'Miter is not accepting terminal commands. Open Miter in Chrome once to activate the host. After an update, reload the Miter extension card, then reopen its workspace.',
    'not-sent',
    cause,
  );
}

async function readEndpoint(dataDir: string): Promise<TerminalDescriptor> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new TerminalControlError('Terminal task control currently requires macOS or Linux.', 'not-sent');
  }

  const root = await fs.lstat(dataDir);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== uid || (root.mode & 0o022) !== 0) {
    throw new Error(
      'The Miter data directory is linked, writable by another user, or belongs to another user.',
    );
  }
  const canonicalRoot = await fs.realpath(dataDir);
  const descriptorPath = path.join(canonicalRoot, TERMINAL_CONTROL_DESCRIPTOR);
  const descriptor = await fs.open(
    descriptorPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let parsed: TerminalDescriptor;
  try {
    const info = await descriptor.stat();
    if (
      !info.isFile() ||
      info.uid !== uid ||
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1 ||
      info.size > 4096
    ) {
      throw new Error('The terminal descriptor must be a private, owner-only regular file.');
    }
    const bytes = Buffer.alloc(4097);
    const read = await descriptor.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 4096) {
      throw new Error('The terminal descriptor is too large.');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead));
    parsed = terminalDescriptorSchema.parse(JSON.parse(text));
    const current = await fs.lstat(descriptorPath);
    if (current.dev !== info.dev || current.ino !== info.ino || current.isSymbolicLink()) {
      throw new Error('The terminal descriptor changed while it was being read.');
    }
  } finally {
    await descriptor.close();
  }

  if (!path.isAbsolute(parsed.socketPath)) {
    throw new Error('The terminal socket path is not absolute.');
  }
  const endpointPath = path.dirname(parsed.socketPath);
  const endpoint = await fs.lstat(endpointPath);
  if (
    !endpoint.isDirectory() ||
    endpoint.isSymbolicLink() ||
    endpoint.uid !== uid ||
    (endpoint.mode & 0o777) !== 0o700
  ) {
    throw new Error('The terminal socket directory is not private to this user.');
  }
  if ((await fs.realpath(endpointPath)) !== endpointPath) {
    throw new Error('The terminal socket directory contains an unresolved link.');
  }
  const socket = await fs.lstat(parsed.socketPath);
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) {
    throw new Error('The terminal endpoint is not a private socket owned by this user.');
  }
  const finalRoot = await fs.lstat(canonicalRoot);
  if (finalRoot.dev !== root.dev || finalRoot.ino !== root.ino || finalRoot.isSymbolicLink()) {
    throw new Error('The Miter data directory changed during endpoint discovery.');
  }
  return parsed;
}

function exchange(
  descriptor: TerminalDescriptor,
  request: TerminalControlRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<TerminalControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let sent = false;
    let finished = false;
    const timer = setTimeout(
      () => fail('Miter did not acknowledge the terminal request before the timeout.'),
      timeoutMs,
    );

    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
    }

    function fail(message: string, cause?: unknown): void {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      if (sent) {
        reject(new TerminalControlError(message + ' The request may have been accepted.', 'unknown', cause));
      } else {
        reject(new TerminalControlError(message + ' The request was not sent.', 'not-sent', cause));
      }
    }

    function abort(): void {
      fail('Terminal monitoring was interrupted.');
    }

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    socket.on('error', (error) =>
      fail('Could not reach the running Miter host. Open its workspace in Chrome.', error),
    );
    socket.on('end', () => fail('Miter closed the connection without a complete acknowledgement.'));
    socket.on('data', (chunk: Buffer) => {
      if (finished) {
        return;
      }
      byteCount += chunk.length;
      if (byteCount > TERMINAL_CONTROL_MAX_BYTES) {
        fail('Miter returned an oversized acknowledgement.');
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(10)) {
        return;
      }
      try {
        const bytes = Buffer.concat(chunks, byteCount);
        const newline = bytes.indexOf(10);
        if (newline !== bytes.length - 1) {
          throw new Error('Expected exactly one response line.');
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline));
        const response = terminalControlResponseSchema.parse(JSON.parse(text));
        if (response.id !== request.id) {
          throw new Error('The response belongs to another request.');
        }
        finished = true;
        cleanup();
        resolve(response);
      } catch (error) {
        fail(
          'Miter returned an invalid acknowledgement. Update and reload its extension before continuing.',
          error,
        );
      }
    });
    socket.connect(descriptor.socketPath, () => {
      if (finished) {
        return;
      }
      sent = true;
      socket.write(JSON.stringify(request) + '\n');
    });
  });
}

export function createTerminalClient(options: TerminalClientOptions = {}) {
  const defaultDataDir = process.env.MITTER_HOME || path.join(os.homedir(), '.mitter');
  const dataDir = path.resolve(options.dataDir ?? defaultDataDir);

  async function request<Result>(call: TerminalCall, parse: (value: unknown) => Result): Promise<Result> {
    let descriptor: TerminalDescriptor;
    try {
      descriptor = await readEndpoint(dataDir);
    } catch (error) {
      if (error instanceof TerminalControlError) {
        throw error;
      }
      if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ECONNREFUSED')) {
        throw unavailable(error);
      }
      throw new TerminalControlError(
        'Miter terminal connection files are unsafe or incompatible. Reopen the updated Miter workspace to recreate its private connection; no request was sent.',
        'not-sent',
        error,
      );
    }
    const outgoing = terminalControlRequestSchema.parse({
      version: 1,
      id: randomUUID(),
      token: descriptor.token,
      ...call,
    });
    const bytes = Buffer.byteLength(JSON.stringify(outgoing) + '\n');
    if (bytes > TERMINAL_CONTROL_MAX_BYTES) {
      throw new TerminalControlError(
        'The terminal request is too large. Shorten the task instruction.',
        'not-sent',
      );
    }
    let timeoutMs = 30000;
    if (call.method === 'preview') {
      timeoutMs = 370000;
    }
    const response = await exchange(descriptor, outgoing, options.timeoutMs ?? timeoutMs, options.signal);
    if (!response.ok) {
      throw new TerminalControlError(response.error, 'rejected');
    }
    try {
      return parse(response.result);
    } catch (error) {
      throw new TerminalControlError(
        'Miter returned an acknowledgement for the wrong command. The request may have been accepted; check its saved receipt before retrying.',
        'unknown',
        error,
      );
    }
  }

  return {
    async start(params: TerminalStartParams) {
      return request({ method: 'start', params }, (value) => {
        const result = terminalOperationSchema.parse(value);
        if (result.requestId !== params.requestId || result.kind !== 'start') {
          throw new Error('The receipt does not match the requested start.');
        }
        return result;
      });
    },
    async stop(params: TerminalStopParams) {
      return request({ method: 'stop', params }, (value) => {
        const result = terminalOperationSchema.parse(value);
        if (
          result.requestId !== params.requestId ||
          result.kind !== 'stop' ||
          result.workerId !== params.workerId
        ) {
          throw new Error('The receipt does not match the requested stop.');
        }
        return result;
      });
    },
    async resume(params: TerminalResumeParams) {
      return request({ method: 'resume', params }, (value) => {
        const result = terminalOperationSchema.parse(value);
        if (
          result.requestId !== params.requestId ||
          result.kind !== 'resume' ||
          result.workerId !== params.workerId ||
          result.expectedRun?.runId !== params.expectedRun.runId ||
          result.expectedRun?.epoch !== params.expectedRun.epoch
        ) {
          throw new Error('The receipt does not match the requested resume.');
        }
        return result;
      });
    },
    async preview(params: TerminalPreviewParams) {
      return request({ method: 'preview', params }, (value) => {
        const result = terminalPreviewResultSchema.parse(value);
        if (
          result.workerId !== params.workerId ||
          result.expectedRun.runId !== params.expectedRun.runId ||
          result.expectedRun.epoch !== params.expectedRun.epoch
        ) {
          throw new Error('The preview belongs to a different task run.');
        }
        return result.preview;
      });
    },
    async status(workerId: string) {
      return request({ method: 'status', params: { workerId } }, (value) => {
        const result = terminalStatusSchema.parse(value);
        if (result.worker.id !== workerId) {
          throw new Error('The status belongs to another task.');
        }
        return result;
      });
    },
    async operation(requestId: string) {
      return request({ method: 'operation', params: { requestId } }, (value) => {
        const result = terminalOperationSchema.parse(value);
        if (result.requestId !== requestId) {
          throw new Error('The receipt belongs to another operation.');
        }
        return result;
      });
    },
    async list() {
      return request({ method: 'list', params: {} }, (value) => terminalListSchema.parse(value));
    },
  };
}

export type TerminalClient = ReturnType<typeof createTerminalClient>;
