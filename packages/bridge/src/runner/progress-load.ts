import { z } from 'zod';
import { savedTaskProgressSchema, taskProgressSchema } from '../progress.js';
import { nonNegativeIntegerSchema } from '../schemas/primitives.js';

export const bridgeProgressLoadSchema = z
  .object({
    progress: taskProgressSchema.nullable().describe('Saved task progress, or null when no record exists.'),
    importedCount: nonNegativeIntegerSchema.describe('Number of batches already accepted by the host.'),
  })
  .describe('Saved task progress and the number of batches already accepted by the local host.');

export type BridgeProgressLoad = z.infer<typeof bridgeProgressLoadSchema>;

export const savedBridgeProgressLoadSchema = bridgeProgressLoadSchema
  .extend({
    progress: savedTaskProgressSchema
      .nullable()
      .describe('Legacy saved progress, or explicit null when none exists.'),
  })
  .describe('The saved-progress load boundary, including the established legacy migrations.');
