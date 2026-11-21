import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import {
  TERMINAL_CONTROL_DESCRIPTOR,
  TERMINAL_CONTROL_MAX_BYTES,
  terminalControlRequestSchema,
  terminalControlResponseSchema,
  terminalDescriptorSchema,
  type TerminalDescriptor,
} from '../../../../../packages/protocol/src/terminal-control.js';
import type { Service } from '../service.js';
import { errorMessage, hasErrorCode } from '../types.js';
import { TerminalOperations } from './operations.js';

type FileIdentity = Pick<Stats, 'dev' | 'ino'>;

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownsFile(stats: Stats, uid: number): boolean {
  return stats.uid === uid && !stats.isSymbolicLink();
}

async function removeOwnedFile(filename: string, identity: FileIdentity): Promise<void> {
  try {
    const current = await fs.lstat(filename);

    if (sameFile(current, identity) && !current.isSymbolicLink()) {
      await fs.unlink(filename);
    }
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

async function checkOldDescriptor(filename: string, uid: number): Promise<FileIdentity | undefined> {
  let before: Stats;

  try {
    before = await fs.lstat(filename);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }

  if (
    !ownsFile(before, uid) ||
    !before.isFile() ||
    before.nlink !== 1 ||
    (before.mode & 0o077) !== 0 ||
    before.size > 4096
  ) {
    throw new Error(
      'Miter’s terminal descriptor has unsafe ownership or permissions. Remove that descriptor after closing Miter, then reopen the workspace.',
    );
  }

  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    if (!sameFile(before, await file.stat())) {
      throw new Error('Miter’s terminal descriptor changed while it was being read.');
    }

    const raw: unknown = JSON.parse(await file.readFile('utf8'));
    const descriptor = terminalDescriptorSchema.parse(raw);
    let running = true;

    try {
      process.kill(descriptor.pid, 0);
    } catch (error) {
      if (hasErrorCode(error, 'ESRCH')) {
        running = false;
      } else {
        throw error;
      }
    }

    if (running) {
      throw new Error(
        'Another live Miter terminal endpoint is already registered. Close that Miter host before opening another.',
      );
    }

    return before;
  } finally {
    await file.close();
  }
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      server.removeListener('listening', ready);
      reject(error);
    };
    const ready = () => {
      server.removeListener('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && !hasErrorCode(error, 'ERR_SERVER_NOT_RUNNING')) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

/** A private local socket delegates to the already-running native host service. */
export class TerminalControlServer {
  private readonly sockets = new Set<Socket>();
  private readonly deliveries = new Set<Promise<void>>();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly server: Server,
    private readonly operations: TerminalOperations,
    private readonly descriptor: TerminalDescriptor,
    private readonly descriptorPath: string,
    private readonly descriptorIdentity: FileIdentity,
    private readonly directory: string,
    private readonly directoryIdentity: FileIdentity,
    private readonly socketIdentity: FileIdentity,
  ) {
    server.removeAllListeners('connection');
    server.on('connection', (socket) => this.accept(socket));
    // Established requests receive their own socket errors. A listener also keeps
    // an unexpected server-level error from terminating the native messaging host.
    server.on('error', () => {});
  }

  claim(params: unknown) {
    return this.operations.claim(params);
  }

  complete(params: unknown) {
    return this.operations.complete(params);
  }

  private accept(socket: Socket): void {
    if (this.closing || this.sockets.size >= 16) {
      socket.destroy();
      return;
    }

    this.sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let received = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('data', (chunk: Buffer) => {
      if (received || this.closing) {
        socket.destroy();
        return;
      }

      if (buffer.length + chunk.length > TERMINAL_CONTROL_MAX_BYTES) {
        socket.destroy();
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);

      if (end < 0) {
        return;
      }

      received = true;

      if (end !== buffer.length - 1) {
        socket.destroy();
        return;
      }

      let payload: string;

      try {
        payload = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
      } catch {
        socket.destroy();
        return;
      }

      buffer = Buffer.alloc(0);
      const delivery = this.respond(socket, payload);
      this.deliveries.add(delivery);
      void delivery.then(
        () => this.deliveries.delete(delivery),
        () => {
          this.deliveries.delete(delivery);
          socket.destroy();
        },
      );
    });
  }

  private async respond(socket: Socket, payload: string): Promise<void> {
    let id: string | undefined;

    try {
      const raw: unknown = JSON.parse(payload);
      const request = terminalControlRequestSchema.parse(raw);
      id = request.id;

      if (!timingSafeEqual(Buffer.from(request.token, 'hex'), Buffer.from(this.descriptor.token, 'hex'))) {
        throw new Error(
          'Miter’s terminal connection changed. Run the command again to discover its current endpoint.',
        );
      }

      if (request.method === 'preview') {
        socket.setTimeout(360000);
      }
      const result = await this.operations.dispatch(request);
      const response = terminalControlResponseSchema.parse({ version: 1, id, ok: true, result });
      const line = JSON.stringify(response) + '\n';

      if (Buffer.byteLength(line) > TERMINAL_CONTROL_MAX_BYTES) {
        throw new Error(
          'This task status is too large for the terminal connection. Open its workspace to inspect it.',
        );
      }

      socket.end(line);
    } catch (error) {
      if (id === undefined) {
        socket.destroy();
        return;
      }

      const message = errorMessage(error).slice(0, 2000);
      const response = terminalControlResponseSchema.parse({
        version: 1,
        id,
        ok: false,
        error: message || 'Miter could not acknowledge this request. Check its saved operation receipt.',
      });
      socket.end(JSON.stringify(response) + '\n');
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = this.shutdown();
    }

    return this.closePromise;
  }

  private async shutdown(): Promise<void> {
    const stopping = closeServer(this.server);
    const errors: unknown[] = [];

    try {
      await this.operations.close();
      await Promise.allSettled([...this.deliveries]);
    } catch (error) {
      errors.push(error);
    }

    for (const socket of this.sockets) {
      socket.destroy();
    }

    for (const cleanup of [
      () => stopping,
      () => removeOwnedFile(this.descriptorPath, this.descriptorIdentity),
      () => removeOwnedFile(this.descriptor.socketPath, this.socketIdentity),
      async () => {
        const current = await fs.lstat(this.directory);

        if (sameFile(current, this.directoryIdentity) && current.isDirectory() && !current.isSymbolicLink()) {
          await fs.rmdir(this.directory);
        }
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          errors.push(error);
        }
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Miter closed its terminal connection, but some endpoint cleanup failed.',
      );
    }
  }
}

export async function startTerminalControl(options: {
  dataDir: string;
  service: Service;
}): Promise<TerminalControlServer> {
  if (process.platform === 'win32' || !process.getuid) {
    throw new Error(
      'Miter terminal commands currently require macOS or Linux. Use the browser workspace on this system.',
    );
  }

  const uid = process.getuid();
  const root = await fs.lstat(options.dataDir);

  if (
    !ownsFile(root, uid) ||
    !root.isDirectory() ||
    (root.mode & 0o022) !== 0 ||
    (await fs.realpath(options.dataDir)) !== options.dataDir
  ) {
    throw new Error(
      'Miter’s data folder must be a real folder owned by you and not writable by other users.',
    );
  }

  const descriptorPath = path.join(options.dataDir, TERMINAL_CONTROL_DESCRIPTOR);
  const oldDescriptor = await checkOldDescriptor(descriptorPath, uid);
  const temporaryRoot = await fs.realpath('/tmp');
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'miter-' + uid + '-'));
  await fs.chmod(directory, 0o700);
  const directoryIdentity = await fs.lstat(directory);
  const socketPath = path.join(directory, 'control.sock');
  const server = createServer((socket) => socket.destroy());
  const temporaryDescriptor = path.join(options.dataDir, '.terminal-' + randomUUID() + '.tmp');
  let descriptorIdentity: FileIdentity | undefined;
  let socketIdentity: FileIdentity | undefined;
  let controller: TerminalControlServer | undefined;

  try {
    if (Buffer.byteLength(socketPath) >= 104) {
      throw new Error(
        'The temporary folder path is too long for Miter’s local terminal socket. Choose a shorter system temporary folder.',
      );
    }

    await listen(server, socketPath);
    await fs.chmod(socketPath, 0o600);
    socketIdentity = await fs.lstat(socketPath);
    const descriptor = terminalDescriptorSchema.parse({
      version: 1,
      pid: process.pid,
      socketPath,
      token: randomBytes(32).toString('hex'),
    });
    const file = await fs.open(
      temporaryDescriptor,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );

    try {
      await file.writeFile(JSON.stringify(descriptor) + '\n', 'utf8');
      await file.sync();
      descriptorIdentity = await file.stat();
    } finally {
      await file.close();
    }

    if (!sameFile(root, await fs.lstat(options.dataDir))) {
      throw new Error('Miter’s data folder changed while its terminal endpoint was being created.');
    }

    const operations = new TerminalOperations(options.service);
    controller = new TerminalControlServer(
      server,
      operations,
      descriptor,
      descriptorPath,
      descriptorIdentity,
      directory,
      directoryIdentity,
      socketIdentity,
    );

    if (oldDescriptor) {
      if (!sameFile(oldDescriptor, await fs.lstat(descriptorPath))) {
        throw new Error('Miter’s terminal descriptor changed during startup.');
      }

      await fs.rename(temporaryDescriptor, descriptorPath);
    } else {
      // Linking publishes without replacing a descriptor another owner just wrote.
      await fs.link(temporaryDescriptor, descriptorPath);
      await fs.unlink(temporaryDescriptor);
    }

    return controller;
  } catch (error) {
    const cleanups: Array<() => Promise<unknown>> = [];

    if (controller) {
      const owner = controller;
      await owner.close().catch(() => {});
    } else {
      cleanups.push(() => closeServer(server));
    }

    if (descriptorIdentity) {
      const identity = descriptorIdentity;
      cleanups.push(() => removeOwnedFile(temporaryDescriptor, identity));
      cleanups.push(() => removeOwnedFile(descriptorPath, identity));
    }

    if (socketIdentity) {
      const identity = socketIdentity;
      cleanups.push(() => removeOwnedFile(socketPath, identity));
    }

    cleanups.push(() => fs.rmdir(directory));
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
    throw error;
  }
}
