import { isRecord } from './types.js';

function isSnapshot(message: unknown): boolean {
  return isRecord(message) && message.event === 'snapshot';
}

/** Coalesce unsent status snapshots while preserving RPC results in FIFO order.
 * Both count and serialized-size bounds protect a slow/disconnected browser.
 * Size is charged as UTF-16 storage, conservatively covering JSON text in memory;
 * one currently-writing response is separately bounded by nativeMessages(). */

export class OutputQueue {
  private messages: {
    text: string;
    bytes: number;
    snapshot: boolean;
  }[] = [];
  private queuedBytes = 0;
  private writing = false;
  private closed = false;

  constructor(
    private write: (message: unknown) => Promise<void>,
    private error: (e: unknown) => void,
    private maxQueuedBytes = 64 * 1024 * 1024,
  ) {}

  send(message: unknown) {
    if (this.closed) {
      return;
    }

    let text: string;
    let snapshot: boolean;

    try {
      const serialized = JSON.stringify(message);

      if (serialized === undefined) {
        throw Error('Native output must be a JSON value.');
      }
      text = serialized;
      const payload: unknown = JSON.parse(text);
      snapshot = isSnapshot(payload);
    } catch (error) {
      this.fail(error);
      return;
    }

    const bytes = text.length * 2;
    let index = -1;

    if (snapshot) {
      index = this.messages.findIndex((queued) => queued.snapshot);
    }

    let replacedBytes = 0;

    if (index >= 0) {
      replacedBytes = this.messages[index]?.bytes ?? 0;
    }

    const total = this.queuedBytes - replacedBytes + bytes;

    if (total > this.maxQueuedBytes || (index < 0 && this.messages.length >= 256)) {
      this.fail(Error('Native output queue exceeded its count or size bound.'));
      return;
    }

    if (index >= 0) {
      this.messages[index] = {
        text,
        bytes,
        snapshot,
      };
    } else {
      this.messages.push({
        text,
        bytes,
        snapshot,
      });
    }
    this.queuedBytes = total;
    void this.flush();
  }

  private fail(error: unknown) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.messages = [];
    this.queuedBytes = 0;
    this.error(error);
  }

  private async flush() {
    if (this.writing || this.closed) {
      return;
    }
    this.writing = true;

    try {
      while (this.messages.length && !this.closed) {
        const next = this.messages.shift();

        if (!next) {
          break;
        }
        this.queuedBytes -= next.bytes;
        const message: unknown = JSON.parse(next.text);
        await this.write(message);
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.writing = false;
    }
  }

  close() {
    this.closed = true;
    this.messages = [];
    this.queuedBytes = 0;
  }
}
