import { z } from 'zod';

export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe('The lowercase SHA-256 of exact bytes; no whitespace or source normalization is permitted.');

export const fileHashSchema = z
  .union([sha256Schema, z.literal('missing').describe('No file exists at the reviewed path.')])
  .describe('The exact lowercase file SHA-256, or missing when no file exists.');

export const rpcCounterSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .describe('A nonnegative integer count representable exactly in JavaScript.');

export const rpcTimestampSchema = rpcCounterSchema
  .max(8640000000000000)
  .describe('Unix time in integer milliseconds within the JavaScript Date range.');
