import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(moduleUrl) {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function hasErrorCode(error, code) {
  return error !== null && typeof error === 'object' && error.code === code;
}

export function parseContract(schema, value, message) {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new Error(message, { cause: parsed.error });
  }

  return parsed.data;
}

/** Keep syntax and schema diagnostics as causes, not raw JSON in CLI error messages. */
export function parseJsonContract(schema, serialized, message) {
  try {
    const value = JSON.parse(serialized);

    return schema.parse(value);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}
