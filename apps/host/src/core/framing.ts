import os from 'node:os';
import { MAX_FRAME } from '../../../../packages/protocol/src/index.js';
const little = os.endianness() === 'LE';

export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');

  if (payload.length > MAX_FRAME) {
    throw new Error('Native message is too large.');
  }

  const header = Buffer.alloc(4);

  if (little) {
    header.writeUInt32LE(payload.length);
  } else {
    header.writeUInt32BE(payload.length);
  }

  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    while (this.buffer.length >= 4) {
      let length: number;

      if (little) {
        length = this.buffer.readUInt32LE(0);
      } else {
        length = this.buffer.readUInt32BE(0);
      }

      if (length === 0 || length > MAX_FRAME) {
        this.buffer = Buffer.alloc(0);

        throw new Error('Invalid native frame length.');
      }

      if (this.buffer.length < 4 + length) {
        break;
      }

      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      messages.push(
        JSON.parse(
          new TextDecoder('utf-8', {
            fatal: true,
          }).decode(body),
        ),
      );
    }

    if (this.buffer.length > MAX_FRAME + 4) {
      throw new Error('Native buffer exceeded limit.');
    }

    return messages;
  }

  end(): void {
    if (this.buffer.length) {
      throw new Error('Incomplete native message.');
    }
  }
}
