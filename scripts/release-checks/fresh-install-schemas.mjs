import path from 'node:path';
import { z } from 'zod';

const absolutePathSchema = z
  .string()
  .refine((filename) => {
    return path.isAbsolute(filename) && !filename.includes('\0');
  })
  .describe('An absolute local filesystem path without NUL characters.');
const workerArgumentsSchema = z
  .tuple([
    z.literal('--install-worker').describe('Run source preparation inside the bounded worker process.'),
    absolutePathSchema.describe('The source installation whose exact working-tree bytes are copied.'),
    absolutePathSchema.describe('The caller-owned temporary directory; ownership is checked before writes.'),
  ])
  .transform(([, source, directory]) => {
    return { mode: 'worker', source, directory };
  })
  .describe('The exact private worker argv passed by the bounded fresh-install runner.');
const timeoutArgumentSchema = z
  .string()
  .regex(/^--timeout-ms=\d+$/)
  .transform((argument) => {
    return Number(argument.slice('--timeout-ms='.length));
  })
  .pipe(
    z
      .number()
      .int()
      .min(1000)
      .max(900000)
      .describe('The complete fresh-install deadline in milliseconds, from 1000 to 900000.'),
  )
  .describe('An explicit fresh-install deadline supplied as --timeout-ms=MILLISECONDS.');
const verificationArgumentsSchema = z
  .array(timeoutArgumentSchema)
  .max(1)
  .transform((args) => {
    const timeoutMs = args[0] ?? 480000;

    return { mode: 'verify', timeoutMs };
  })
  .describe('At most one deadline option; absence uses the existing eight-minute deadline.');

export const freshInstallArgumentsSchema = z
  .union([workerArgumentsSchema, verificationArgumentsSchema])
  .describe('Fresh-install CLI configuration, parsed before creating or launching an isolated workflow.');
