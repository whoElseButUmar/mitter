import { z } from 'zod';
import { ToastInputSchema, ToastKindSchema, ToastViewSchema } from './schemas.js';

export type ToastKind = z.infer<typeof ToastKindSchema>;
export type ToastAction = { label: string; run: () => void | Promise<unknown> };
export type ToastInput = z.infer<typeof ToastInputSchema> & { action?: ToastAction };
export type ToastView = z.infer<typeof ToastViewSchema> & { action: ToastAction | undefined };
type Entry = ToastView & { key: string; remaining: number; since: number; paused: Set<string> };
export type ToastClock = {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
};

// Opaque clock handles are looked up, never cast into a platform-specific timeout type.
const timers = new Map<unknown, ReturnType<typeof setTimeout>>();
const clock: ToastClock = {
  now: () => Date.now(),
  set(fn, milliseconds) {
    const handle = setTimeout(() => {
      timers.delete(handle);
      fn();
    }, milliseconds);
    timers.set(handle, handle);
    return handle;
  },
  clear(id) {
    const handle = timers.get(id);

    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(id);
    }
  },
};

/** Local ephemeral feedback. No source storage, cross-window broadcasts, or interval/animation loop. */
export class ToastCenter {
  private entries: Entry[] = [];
  private listeners = new Set<(items: ToastView[]) => void>();
  private globalPause = new Set<string>();
  private timer: unknown;
  private serial = 0;
  private disposed = false;

  constructor(
    private time: ToastClock = clock,
    private visibleLimit = 3,
    private queueLimit = 20,
  ) {}

  subscribe(listener: (items: ToastView[]) => void): () => void {
    if (!this.disposed) {
      this.listeners.add(listener);
    }

    try {
      listener(this.items());
    } catch (reason) {
      this.listeners.delete(listener);
      throw reason;
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  items(): ToastView[] {
    return this.entries.slice(0, this.visibleLimit).map(({ id, message, kind, action, busy }) => ({
      id,
      message,
      kind,
      action,
      busy,
    }));
  }

  private settle(): void {
    const now = this.time.now();

    for (const entry of this.entries.slice(0, this.visibleLimit)) {
      if (!this.globalPause.size && !entry.paused.size && !entry.busy) {
        entry.remaining = Math.max(0, entry.remaining - (now - entry.since));
      }

      entry.since = now;
    }
  }

  private changed(): void {
    if (this.timer !== undefined) {
      this.time.clear(this.timer);
      this.timer = undefined;
    }

    if (this.disposed) {
      return;
    }

    const now = this.time.now();

    for (const entry of this.entries) {
      entry.since = now;
    }

    try {
      for (const listener of this.listeners) {
        listener(this.items());
      }
    } finally {
      const active = this.entries
        .slice(0, this.visibleLimit)
        .filter((entry) => !entry.paused.size && !entry.busy);

      if (!this.globalPause.size && active.length) {
        this.timer = this.time.set(
          () => {
            if (this.disposed) {
              return;
            }

            this.settle();
            this.entries = this.entries.filter((entry) => entry.remaining > 0);
            this.changed();
          },
          Math.max(1, Math.min(...active.map((entry) => entry.remaining))),
        );
      }
    }
  }

  push(input: ToastInput): string {
    if (this.disposed || !input.message.trim()) {
      return '';
    }

    this.settle();
    const kind = input.kind || 'info';
    const key = input.key || kind + ':' + input.message;
    let defaultDuration = 4500;

    if (input.action) {
      defaultDuration = 8000;
    } else if (kind === 'error') {
      defaultDuration = 10000;
    } else if (kind === 'warning') {
      defaultDuration = 7000;
    }

    let duration = input.duration ?? defaultDuration;

    if (!Number.isFinite(duration)) {
      duration = 4500;
    }

    const remaining = Math.max(1000, Math.min(60000, duration));
    const previous = this.entries.find((entry) => entry.key === key && !entry.busy);

    if (previous) {
      previous.message = input.message;
      previous.kind = kind;
      previous.action = input.action;
      previous.remaining = remaining;
      this.changed();
      return previous.id;
    }

    if (this.entries.length >= this.visibleLimit + this.queueLimit) {
      if (this.entries.length <= this.visibleLimit) {
        return '';
      }

      this.entries.splice(this.visibleLimit, 1);
    }

    this.serial += 1;
    const entry: Entry = {
      id: 'miter-toast-' + this.serial,
      key,
      message: input.message,
      kind,
      action: input.action,
      busy: false,
      remaining,
      since: this.time.now(),
      paused: new Set(),
    };

    this.entries.push(entry);
    this.changed();
    return entry.id;
  }

  dismiss(id: string): void {
    if (this.disposed) {
      return;
    }

    this.settle();
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.changed();
  }

  pause(id: string, reason: string, paused: boolean): void {
    const entry = this.entries.find((entry) => entry.id === id);

    if (!entry || entry.paused.has(reason) === paused) {
      return;
    }

    this.settle();

    if (paused) {
      entry.paused.add(reason);
    } else {
      entry.paused.delete(reason);
    }

    this.changed();
  }

  pauseAll(reason: string, paused: boolean): void {
    if (this.disposed) {
      return;
    }

    this.settle();

    if (paused) {
      this.globalPause.add(reason);
    } else {
      this.globalPause.delete(reason);
    }

    this.changed();
  }

  async invoke(id: string): Promise<void> {
    const entry = this.entries.find((entry) => entry.id === id);

    if (!entry || entry.busy || !entry.action) {
      return;
    }

    this.settle();
    entry.busy = true;
    this.changed();

    try {
      await entry.action.run();

      if (this.entries.includes(entry)) {
        this.dismiss(id);
      }
    } catch (error) {
      if (!this.entries.includes(entry)) {
        return;
      }

      this.settle();
      let message: unknown = error;

      if (error instanceof Error) {
        message = error.message;
      } else if (typeof error === 'object' && error !== null && 'message' in error) {
        message = error.message;
      }

      entry.message = 'The notification action failed.';

      if (typeof message === 'string' && message.trim()) {
        entry.message = message.trim();
      }

      entry.kind = 'error';
      entry.busy = false;
      entry.action = undefined;
      entry.remaining = 10000;
      this.changed();
    }
  }

  dispose(): void {
    this.disposed = true;

    try {
      if (this.timer !== undefined) {
        this.time.clear(this.timer);
      }
    } finally {
      this.timer = undefined;
      this.entries = [];
      this.listeners.clear();
      this.globalPause.clear();
    }
  }
}
