import type {
  TerminalInfo,
  TerminalRead,
  TerminalFrame,
} from '../../../../../packages/terminal/src/protocol.js';
import type { PtyProcess, PtySubscription } from './pty-adapter.js';

export type TerminalSession = {
  info: Omit<TerminalInfo, 'owned' | 'occupied'>;
  pty: PtyProcess;
  kill: (signal?: string) => void;
  owner: string | undefined;
  frames: TerminalFrame[];
  next: number;
  ack: number;
  delivered: number;
  bytes: number;
  subscriptions: PtySubscription[];
  outputStopped: boolean;
  closed: boolean;
};
const HIGH_WATER = 512 * 1024;
const LOW_WATER = 128 * 1024;
const HISTORY = 128 * 1024;
const READ_LIMIT = 64 * 1024;

function unacknowledgedBytes(session: TerminalSession): number {
  let bytes = 0;

  for (const frame of session.frames) {
    if (frame.seq > session.ack) {
      bytes += frame.data.length * 2;
    }
  }

  return bytes;
}

export function trimTerminalHistory(session: TerminalSession): void {
  while (session.bytes > HISTORY && session.frames.length > 1) {
    const first = session.frames[0];

    if (!first || first.seq > session.ack) {
      break;
    }

    const removed = session.frames.shift();

    if (removed) {
      session.bytes -= removed.data.length * 2;
    }
  }
}

export function appendTerminalOutput(session: TerminalSession, data: string): void {
  if (session.closed || session.outputStopped || !data) {
    return;
  }

  // Native output is UTF-8 decoded. Never tear a UTF-16 surrogate pair between frames.

  for (let offset = 0; offset < data.length;) {
    let end = Math.min(offset + 8192, data.length);

    if (end < data.length && /[\uD800-\uDBFF]/.test(data.charAt(end - 1))) {
      end--;
    }

    const text = data.slice(offset, end);
    offset = end;
    session.frames.push({
      seq: ++session.next,
      data: text,
    });
    session.bytes += text.length * 2;
  }

  if (unacknowledgedBytes(session) >= HIGH_WATER && !session.info.paused && !session.info.exited) {
    session.pty.pause();
    session.info.paused = true;
  }

  // A producer ignoring pause is terminated instead of consuming unbounded memory.

  if (session.bytes > HIGH_WATER * 4) {
    session.outputStopped = true;
    session.frames = session.frames.slice(-32);
    session.bytes = session.frames.reduce((bytes, frame) => bytes + frame.data.length * 2, 0);

    try {
      session.kill();
    } catch {
      // A kill request is not exit confirmation; reset still waits for onExit.
    }
  }

  trimTerminalHistory(session);
}

export function readTerminalOutput(session: TerminalSession, after: number): TerminalRead {
  if (after > session.delivered) {
    throw new Error('Terminal acknowledgement is ahead of delivered output.');
  }

  if (after > session.ack) {
    session.ack = after;
    trimTerminalHistory(session);
  }

  const first = session.frames[0]?.seq ?? session.next + 1;
  const reset = after < first - 1;
  const frames: TerminalFrame[] = [];
  let bytes = 0;

  for (const frame of session.frames) {
    if (frame.seq <= after) {
      continue;
    }

    if (bytes && bytes + frame.data.length * 2 > READ_LIMIT) {
      break;
    }
    frames.push(frame);
    bytes += frame.data.length * 2;
  }

  const last = frames.at(-1);

  if (last) {
    session.delivered = Math.max(session.delivered, last.seq);
  }

  if (
    session.info.paused &&
    !session.outputStopped &&
    unacknowledgedBytes(session) < LOW_WATER &&
    !session.info.exited
  ) {
    session.info.paused = false;
    session.pty.resume();
  }

  return {
    frames,
    exited: session.info.exited && (last?.seq ?? after) >= session.next,
    exitCode: session.info.exitCode,
    reset,
    paused: session.info.paused,
  };
}
