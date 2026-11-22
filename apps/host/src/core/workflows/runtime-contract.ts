import type { z } from 'zod';
import { browserJourneySchema } from '../quality/browser-contract.js';

export const workflowStepsSchema = browserJourneySchema.shape.steps
  .refine((steps) => steps.some((step) => step.type !== 'expect'), 'Record an action first.')
  .refine((steps) => steps.at(-1)?.type === 'expect', 'Choose a final result to check.')
  .describe('User-recorded interactions ending with the selected observable result.');

export type WorkflowSteps = z.infer<typeof workflowStepsSchema>;
