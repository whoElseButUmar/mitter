import { z } from 'zod';
import { requestSchema } from '../../../../packages/protocol/src/index.js';

export const identifierSchema = requestSchema.shape.id.describe(
  'A bounded request, task, project, or session identifier.',
);

export const parametersSchema = z
  .record(z.string(), z.unknown())
  .describe('Operation parameters, validated by the receiving capability.');

export const timestampSchema = z
  .number()
  .finite()
  .nonnegative()
  .describe('Milliseconds since the Unix epoch.');

export function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const [issue] = error.issues;

    if (issue) {
      const field = issue.path.map(String).join('.');

      if (field) {
        return field + ': ' + issue.message;
      }

      return issue.message;
    }
  }

  let message: unknown = error;

  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'object' && error !== null && 'message' in error) {
    message = error.message;
  }

  if (typeof message === 'string' && message.trim()) {
    return message.trim();
  }

  return 'Miter could not confirm the result. Check the current state before repeating the action.';
}

export function invalidRPCResult(method: string, diagnostic: z.ZodError): Error {
  return new Error(
    'Miter could not read the response to ' +
      method +
      '. ' +
      errorMessage(diagnostic) +
      ' The action was not retried. Check its current state before repeating it.',
    { cause: diagnostic },
  );
}

export function documentURL(url: string): string {
  const suffix = url.search(/[?#]/);

  if (suffix < 0) {
    return url;
  }

  return url.slice(0, suffix);
}
