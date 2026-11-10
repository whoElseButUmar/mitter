import { z } from 'zod';

export const taskBriefSchema = z
  .strictObject({
    title: z.string().describe('Deterministic suggested task title.'),
    kind: z.enum(['tic-tac-toe', 'color-memory', 'general']).describe('Locally recognized task category.'),
    approach: z
      .array(z.string().describe('Suggested implementation guidance.'))
      .describe('Approach guidance.'),
    quality: z.array(z.string().describe('Suggested quality guidance.')).describe('Quality guidance.'),
    defaults: z
      .array(z.string().describe('Reversible default subordinate to the goal.'))
      .describe('Defaults.'),
  })
  .describe('Local task-shaping template; not executable verification or permission.');

export type TaskBrief = z.infer<typeof taskBriefSchema>;
