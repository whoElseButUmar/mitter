import { z } from 'zod';

export const replyIssueSchema = z
  .strictObject({
    stage: z.enum(['schema', 'precondition']).describe('Validation phase; never execution authorization.'),
    code: z.string().describe('Stable machine-readable validation code.'),
    message: z.string().describe('Body-free feedback without rejected source or values.'),
    field: z.string().optional().describe('Affected field, when known.'),
    actionIndex: z.number().int().nonnegative().optional().describe('Zero-based action index, when known.'),
  })
  .describe('Structured, safe reply validation feedback.');

export type ReplyIssue = z.infer<typeof replyIssueSchema>;
