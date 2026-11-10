import { z } from 'zod';
import { nonNegativeIntegerSchema } from './schemas/primitives.js';

export const debugEntrySchema = z
  .object({
    id: nonNegativeIntegerSchema.describe('A growing number that puts log entries in order.'),
    time: z.number().describe('When the event happened, in milliseconds since the Unix epoch.'),
    kind: z.string().describe('The kind of event recorded in the log.'),
    message: z.string().max(4000).describe('The event details with recognized secrets removed.'),
  })
  .describe('One event recorded for troubleshooting.');
export type DebugEntry = z.infer<typeof debugEntrySchema>;

export function redactDebug(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[redacted]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token)\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1[redacted]');
}

export class Diagnostics {
  private sequence = 0;
  private entries: DebugEntry[] = [];

  constructor(
    private onChange: (entries: DebugEntry[]) => void = () => {},
    private limit = 500,
  ) {}

  add(kind: string, message: string, time = Date.now()) {
    this.entries.push({
      id: ++this.sequence,
      time,
      kind,
      message: redactDebug(message).slice(0, 4000),
    });
    this.entries = this.entries.slice(-this.limit);
    this.onChange(this.read());
  }

  read() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  clear() {
    this.entries = [];
    this.onChange([]);
  }
}
