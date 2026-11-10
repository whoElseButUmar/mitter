import { z } from 'zod';
import { identifierSchema, integerSchema, recordSchema, textSchema } from './schemas/primitives.js';

/** A schema-backed result, never an unchecked generic return assertion. */
export function parseSchema<Schema extends z.ZodType>(schema: Schema, value: unknown): z.infer<Schema> {
  const result = schema.safeParse(value);

  if (!result.success) {
    const [issue] = result.error.issues;

    if (issue) {
      throw new Error(issue.message, { cause: result.error });
    }

    throw new Error('The value does not match the schema.', { cause: result.error });
  }

  return result.data;
}

export function object(value: unknown, label = 'object'): Record<string, unknown> {
  return parseSchema(recordSchema(label), value);
}

export function text(value: unknown, label: string, max = 4000, allowEmpty = false): string {
  return parseSchema(textSchema(label, max, allowEmpty), value);
}

export function integer(value: unknown, label: string, min: number, max: number): number {
  return parseSchema(integerSchema(label, min, max), value);
}

export function only(value: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new Error(`Unexpected field: ${key}`);
    }
  }
}

export function id(value: unknown, label = 'identifier'): string {
  return parseSchema(identifierSchema(label), value);
}
