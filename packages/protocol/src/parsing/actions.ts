import { z } from 'zod';
import { only, object, parseSchema } from '../helpers.js';
import { actionSchema, checkSchema, type Action, type Check } from '../schemas/actions.js';
import { editBaseError } from '../validation.js';

/** Preserve unknown-field priority and insertion-order diagnostics before Zod
 * validates fields. Schema shapes are the only allowed-key lists. */
function parseActionFields<Schema extends z.ZodObject>(schema: Schema, value: Record<string, unknown>) {
  only(value, Object.keys(schema.shape));

  const result = schema.safeParse(value);

  if (!result.success) {
    const [issue] = result.error.issues;

    if (issue?.path[0] === 'expectedHash') {
      throw editBaseError('expectedHash');
    }

    if (issue) {
      throw new Error(issue.message);
    }

    throw new Error('The action does not match the tool schema.');
  }

  return result.data;
}

export function parseAction(value: unknown): Action {
  const action = object(value, 'action');

  for (const schema of actionSchema.options) {
    if (schema.shape.type.value !== action.type) {
      continue;
    }

    const parsed = parseActionFields(schema, action);

    // Optional undefined inputs were historically omitted, never materialized.
    if (parsed.type === 'read') {
      if (parsed.offset === undefined) {
        delete parsed.offset;
      }

      if (parsed.limit === undefined) {
        delete parsed.limit;
      }
    } else if (parsed.type === 'team_message' && parsed.to === undefined) {
      delete parsed.to;
    }

    return parsed;
  }

  throw new Error('Unknown action type. No action was executed.');
}

export function parseCheck(value: unknown): Check {
  const check = object(value, 'check');

  for (const schema of checkSchema.options) {
    if (schema.shape.type.value === check.type) {
      only(check, Object.keys(schema.shape));
      return parseSchema(schema, check);
    }
  }

  throw new Error('Invalid goal check.');
}

export function parseChecks(value: unknown): Check[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error('Provide an array of at most 20 checks.');
  }

  return value.map(parseCheck);
}
