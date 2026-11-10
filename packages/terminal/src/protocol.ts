import { DataObjectSchema } from './validation.js';
import { TerminalDimensionSchema, TerminalIdSchema, TerminalMethodSchema } from './protocol/schemas.js';

export {
  TerminalDimensionSchema,
  TerminalIdSchema,
  TerminalMethodSchema,
  TerminalInfoSchema,
  TerminalFrameSchema,
  TerminalReadSchema,
  TerminalWrittenSchema,
  TerminalResizedSchema,
  TerminalClosedSchema,
  TerminalReleasedSchema,
} from './protocol/schemas.js';

export type {
  TerminalInfo,
  TerminalFrame,
  TerminalRead,
  TerminalWritten,
  TerminalResized,
  TerminalClosed,
  TerminalReleased,
} from './protocol/schemas.js';

/** Human-operated terminal channel, separate from model actions and worker RPCs. */
export const TERMINAL_CHANNEL = 'miter-terminal/1';
export const TERMINAL_PORT = 'miter-terminal';
export const MAX_INPUT = 16_384;

export const TERMINAL_METHODS = new Set<string>(TerminalMethodSchema.options);

export function terminalObject(value: unknown): Record<string, unknown> {
  const result = DataObjectSchema.safeParse(value);

  if (!result.success) {
    throw new Error('Invalid terminal request.');
  }

  return result.data;
}

export function terminalFields(request: Record<string, unknown>, allowedFields: string[]): void {
  for (const field of Object.keys(request)) {
    if (!allowedFields.includes(field)) {
      throw new Error('Unexpected terminal request field.');
    }
  }
}

export function terminalId(value: unknown): string {
  const result = TerminalIdSchema.safeParse(value);

  if (!result.success) {
    throw new Error('Invalid terminal identifier.');
  }

  return result.data;
}

export function dimension(value: unknown, minimum: number, maximum: number): number {
  const schema = TerminalDimensionSchema.min(minimum).max(maximum);

  const result = schema.safeParse(value);

  if (!result.success) {
    throw new Error('Invalid terminal size.');
  }

  return result.data;
}
