import { z } from 'zod';

/** These bounds count UTF-16 code units, not transport bytes. */
export function textSchema(label: string, maximum = 4000, allowEmpty = false) {
  const message = `Invalid ${label} (maximum ${maximum} characters).`;

  return z
    .string({ error: message })
    .refine(
      (value) => {
        if (value.length > maximum || value.includes('\0')) {
          return false;
        }

        if (!allowEmpty && !value.trim()) {
          return false;
        }

        return true;
      },
      { error: message },
    )
    .describe(`${label}; at most ${maximum} UTF-16 code units, without NUL.`);
}

export function integerSchema(label: string, minimum: number, maximum: number) {
  const message = `${label} must be an integer between ${minimum} and ${maximum}.`;

  return z
    .number({ error: message })
    .refine(
      (value) => {
        return Number.isInteger(value) && value >= minimum && value <= maximum;
      },
      { error: message },
    )
    .describe(`${label}; integer from ${minimum} through ${maximum}.`);
}

export function identifierSchema(label = 'identifier') {
  return textSchema(label, 100)
    .refine((value) => /^[a-zA-Z0-9_-]+$/.test(value), { error: `Invalid ${label}.` })
    .describe(`${label}; 1–100 ASCII letters, digits, underscores or hyphens.`);
}

/** This preserves the original object helper's acceptance of non-array objects,
 * including class instances. It neither clones nor accepts null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function recordSchema(label = 'object') {
  const message = `Expected ${label}.`;

  return z
    .unknown()
    .transform((value, context) => {
      if (!isRecord(value)) {
        context.addIssue({ code: 'custom', message });
        return z.NEVER;
      }

      return value;
    })
    .describe(`${label}; a non-null, non-array object retaining its original properties.`);
}
