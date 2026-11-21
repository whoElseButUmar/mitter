import type { DevServer } from '../dev-server/index.js';

export type FrameworkUpstream = { origin: string; hostname: string; port: string; sourceRoot: string };

function upstream(server: DevServer): FrameworkUpstream {
  const target = new URL(server.url);
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    !target.port ||
    target.pathname !== '/' ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  ) {
    throw new Error('Miter could not verify the local dev server address.');
  }
  return {
    origin: target.origin,
    hostname: target.hostname,
    port: target.port,
    sourceRoot: server.sourceRoot,
  };
}

/** A published preview retains its browser origin across one unexpected process exit. */
export class FrameworkRuntime {
  private readonly stopSignal = new AbortController();
  private end = () => {};
  readonly exited = new Promise<void>((resolve) => {
    this.end = resolve;
  });
  private current: DevServer | undefined;
  target: FrameworkUpstream | undefined;
  private recovery: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    initial: DevServer,
    private readonly restart?: (signal: AbortSignal) => Promise<DevServer>,
  ) {
    this.attach(initial);
  }

  private attach(server: DevServer): void {
    this.target = upstream(server);
    this.current = server;
    const released = () => {
      if (this.current !== server || this.stopSignal.signal.aborted) {
        return;
      }
      this.current = undefined;
      this.target = undefined;
      if (!this.recovery && this.restart) {
        this.recovery = this.recover(this.restart);
        void this.recovery.catch(() => this.end());
      } else {
        this.end();
      }
    };
    void server.exited.then(released, released);
  }

  private async recover(start: (signal: AbortSignal) => Promise<DevServer>): Promise<void> {
    let next: DevServer | undefined;
    try {
      next = await start(this.stopSignal.signal);
      this.stopSignal.signal.throwIfAborted();
      this.attach(next);
    } catch {
      try {
        await next?.close();
      } finally {
        this.end();
      }
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.stopSignal.abort();
      this.target = undefined;
      this.closing = Promise.all([this.current?.close(), this.recovery])
        .then(() => {})
        .finally(() => this.end());
    }
    return this.closing;
  }
}
