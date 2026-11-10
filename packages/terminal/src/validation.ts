import { z } from 'zod';

export const DataObjectSchema = z
  .record(z.string(), z.unknown())
  .describe('An object with named fields. Each field is checked before it is used.');
