import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { protocolMessageSchema, protocolRequestSchema } from './chrome-schemas.mjs';
import { parseJsonContract } from '../helpers/runtime.mjs';

export function browserEnvironment(directory, inherited = process.env) {
  const env = {};

  for (const [key, value] of Object.entries(inherited)) {
    if (/^(PATH|LANG|LC_[A-Z_]+|TZ)$/i.test(key)) {
      env[key] = value;
    }
  }

  const home = path.join(directory, 'home');

  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    MITTER_HOME: path.join(directory, 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    TMPDIR: path.join(directory, 'tmp'),
    TMP: path.join(directory, 'tmp'),
    TEMP: path.join(directory, 'tmp'),
  };
}

/** Owns one isolated Chrome process and its private, NUL-delimited DevTools pipe. */
export class ChromePipe {
  constructor(executable, directory, log, signal) {
    signal.throwIfAborted();
    this.signal = signal;
    this.pending = new Map();
    this.events = [];
    this.sequence = 0;
    this.buffer = '';
    this.failure = undefined;
    this.child = spawn(
      executable,
      [
        '--headless=new',
        '--remote-debugging-pipe',
        '--enable-unsafe-extension-debugging',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-breakpad',
        '--use-mock-keychain',
        '--password-store=basic',
        '--proxy-server=http://127.0.0.1:9',
        '--proxy-bypass-list=<-loopback>',
        '--host-resolver-rules=MAP * ~NOTFOUND',
        '--user-data-dir=' + directory + '/profile',
        'about:blank',
      ],
      {
        cwd: directory,
        detached: true,
        env: browserEnvironment(directory),
        stdio: ['ignore', 'ignore', log, 'pipe', 'pipe'],
      },
    );
    this.exited = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.fail(new Error(`Chrome closed (${code}, ${signal}).`));
        resolve();
      });
    });
    this.child.once('error', (error) => this.fail(error));
    this.input = this.child.stdio[3];
    const output = this.child.stdio[4];

    if (!(this.input instanceof Writable) || !(output instanceof Readable)) {
      this.kill();
      throw new Error('Chrome did not provide both debugging pipes.');
    }

    this.input.on('error', (error) => this.fail(error));
    output.on('error', (error) => this.fail(error));
    output.setEncoding('utf8');
    output.on('data', (chunk) => {
      try {
        this.receive(chunk);
      } catch (error) {
        this.fail(error);
        this.kill();
      }
    });
    this.interrupt = () => {
      this.fail(signal.reason);
      this.kill();
    };
    signal.addEventListener('abort', this.interrupt, { once: true });

    if (signal.aborted) {
      this.interrupt();
    }
  }

  receive(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
      throw new Error('Chrome debugging output exceeded the 8 MB safety limit.');
    }

    let separator = this.buffer.indexOf('\0');
    while (separator !== -1) {
      const text = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 1);
      const message = parseJsonContract(
        protocolMessageSchema,
        text,
        'Invalid Chrome debugging message. Inspect the retained release-check log.',
      );

      if ('id' in message) {
        const request = this.pending.get(message.id);
        if (request) {
          if (request.sessionId !== message.sessionId) {
            throw new Error('Chrome reply belongs to a different debugging session: ' + request.method);
          }

          this.pending.delete(message.id);
          clearTimeout(request.timer);
          if ('error' in message) {
            request.reject(new Error(request.method + ': ' + message.error.message));
          } else {
            request.resolve(message.result);
          }
        }
      } else if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') {
        this.events.push(message);
        if (this.events.length > 100) {
          throw new Error('Chrome emitted too many runtime errors; inspect its retained log.');
        }
      }

      separator = this.buffer.indexOf('\0');
    }
  }

  request(method, params = {}, sessionId = undefined) {
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    const id = this.sequence + 1;
    const parsed = protocolRequestSchema.safeParse({ id, method, params, sessionId });

    if (!parsed.success) {
      return Promise.reject(new Error('Invalid Chrome command or JSON parameters.', { cause: parsed.error }));
    }

    const message = parsed.data;
    this.sequence = id;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Chrome command timed out after 10 seconds: ' + method));
      }, 10000);
      this.pending.set(id, { method, sessionId, resolve, reject, timer });
      this.input.write(JSON.stringify(message) + '\0', (error) => {
        if (error) {
          this.fail(error);
        }
      });
    });
  }

  fail(error) {
    this.failure ??= error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(this.failure);
    }
    this.pending.clear();
    this.buffer = '';
  }

  kill() {
    if (this.child.pid !== undefined) {
      try {
        process.kill(-this.child.pid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error) || error.code !== 'ESRCH') {
          this.child.kill('SIGKILL');
        }
      }
    }
  }

  async close() {
    const forcedExit = setTimeout(() => this.kill(), 1500);
    try {
      await this.request('Browser.close').catch(() => {});
      await this.exited;
    } finally {
      clearTimeout(forcedExit);
      this.kill();
      this.signal.removeEventListener('abort', this.interrupt);
      this.events.length = 0;
    }
  }
}
