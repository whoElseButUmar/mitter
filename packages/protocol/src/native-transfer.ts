import { MAX_FRAME } from './constants.js';
import { parseSchema } from './helpers.js';
import { isRecord } from './schemas/primitives.js';
import {
  nativeFragmentSchema,
  NATIVE_PART_EVENT,
  MAX_NATIVE_TRANSFER,
  PART_CHARS,
  type NativeFragment,
} from './schemas/native-transfer.js';

export { MAX_NATIVE_TRANSFER, nativeFragmentSchema, type NativeFragment } from './schemas/native-transfer.js';

/** Outgoing-only framing; it cannot enlarge browser action input. */
export function nativeMessages(message: unknown, transferId: string): unknown[] {
  const serialized = JSON.stringify(message);

  // JSON.stringify has no payload for undefined/functions/symbols. The legacy
  // sender passed those through rather than treating them as fragmented data.
  if (serialized === undefined) {
    return [message];
  }

  const bytes = new TextEncoder().encode(serialized).byteLength;

  if (bytes <= MAX_FRAME) {
    return [message];
  }

  if (bytes > MAX_NATIVE_TRANSFER) {
    throw new Error('Native response exceeds the 32 MB transfer limit.');
  }

  const parts = Math.ceil(serialized.length / PART_CHARS);

  return Array.from({ length: parts }, (_, index) => ({
    event: NATIVE_PART_EVENT,
    transferId,
    index,
    parts,
    characters: serialized.length,
    text: serialized.slice(index * PART_CHARS, (index + 1) * PART_CHARS),
  }));
}

/** In-memory assembly state, not a serialized protocol record. */
type PendingTransfer = {
  parts: number;
  characters: number;
  next: number;
  received: number;
  bytes: number;
  trailingHighSurrogate: boolean;
  text: string[];
  expires: number;
};

/** Per-port, ordered decoder. Completed or passthrough messages remain unknown:
 * callers must validate the method/event payload instead of assuming a type. */
export class NativeMessageInbox {
  private readonly pending = new Map<string, PendingTransfer>();
  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  accept(message: unknown): unknown {
    const now = this.clock();

    for (const [transferId, pending] of this.pending) {
      if (pending.expires < now) {
        this.pending.delete(transferId);
      }
    }

    if (!isRecord(message) || message.event !== NATIVE_PART_EVENT) {
      return message;
    }

    let fragment: NativeFragment;
    try {
      fragment = parseSchema(nativeFragmentSchema, message);
    } catch (error) {
      if (typeof message.transferId === 'string') {
        this.pending.delete(message.transferId);
      }
      throw error;
    }
    const { transferId, index, parts, characters, text } = fragment;
    let pending = this.pending.get(transferId);

    if (!pending) {
      if (index !== 0 || this.pending.size >= 4) {
        throw new Error('Unexpected native response fragment.');
      }

      pending = {
        parts,
        characters,
        next: 0,
        received: 0,
        bytes: 0,
        trailingHighSurrogate: false,
        text: [],
        expires: now + 10_000,
      };
      this.pending.set(transferId, pending);
    }

    if (pending.parts !== parts || pending.characters !== characters || pending.next !== index) {
      this.pending.delete(transferId);
      throw new Error('Out-of-order native response fragments.');
    }

    pending.received += text.length;

    if (pending.received > characters) {
      this.pending.delete(transferId);
      throw new Error('Native response size mismatch.');
    }

    pending.bytes += new TextEncoder().encode(text).byteLength;
    if (text.length > 0) {
      const first = text.charCodeAt(0);
      if (pending.trailingHighSurrogate && first >= 0xdc00 && first <= 0xdfff) {
        // Separate encodings count two replacement characters (6 bytes), while
        // joining the split surrogate pair produces one code point (4 bytes).
        pending.bytes -= 2;
      }
      const last = text.charCodeAt(text.length - 1);
      pending.trailingHighSurrogate = last >= 0xd800 && last <= 0xdbff;
    }
    if (pending.bytes > MAX_NATIVE_TRANSFER) {
      this.pending.delete(transferId);
      throw new Error('Native response exceeds its byte limit.');
    }

    pending.text.push(text);
    pending.next += 1;
    pending.expires = now + 10_000;

    if (pending.next !== parts) {
      return undefined;
    }

    this.pending.delete(transferId);

    if (pending.received !== characters) {
      throw new Error('Truncated native response.');
    }

    const payload = pending.text.join('');

    if (new TextEncoder().encode(payload).byteLength > MAX_NATIVE_TRANSFER) {
      throw new Error('Native response exceeds its byte limit.');
    }

    const result: unknown = JSON.parse(payload);

    if (isRecord(result) && result.event === NATIVE_PART_EVENT) {
      throw new Error('Nested native response fragments are not supported.');
    }

    return result;
  }

  clear(): void {
    this.pending.clear();
  }
}
