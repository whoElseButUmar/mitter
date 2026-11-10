import { z } from 'zod';
import { workerStateSchema } from '../schemas/domain.js';
import { rpcTimestampSchema } from './primitives.js';

export const teamMessageSchema = z
  .strictObject({
    id: z.string().describe('The stable message or action identifier used for retry deduplication.'),
    projectId: z.string().describe('The registered project in which this message was exchanged.'),
    from: z.string().describe('The task that sent this cooperative message.'),
    to: z.string().optional().describe('The peer recipient, absent for a project-wide message.'),
    message: z.string().describe('The redacted literal peer context; it never grants execution authority.'),
    time: rpcTimestampSchema.describe('The message time in whole Unix milliseconds within the Date range.'),
    kind: z.enum(['message', 'pause', 'resume']).describe('The cooperative message category.'),
  })
  .describe('A complete cooperative task message, not an approval or instruction grant.');

export const teamPeerSchema = z
  .strictObject({
    id: z.string().describe('Another task in the same registered project.'),
    name: z.string().describe('The peer task display name.'),
    state: workerStateSchema.describe('The peer task lifecycle state.'),
    branch: z.string().describe('The peer worktree branch, or the shared-workspace display label.'),
    held: z.string().describe('The cooperative hold explanation, or an empty string when not held.'),
  })
  .describe('The full peer task summary displayed by worker.team.');

export const teamSchema = z
  .strictObject({
    peers: z.array(teamPeerSchema).describe('Other tasks belonging to the same project.'),
    messages: z
      .array(teamMessageSchema)
      .describe('Recent complete cooperative messages in newest-first order.'),
  })
  .describe(
    'The full worker.team result, including peer lifecycle/branch/hold state and message identities.',
  );

export const teamResultSchema = z
  .strictObject({
    ok: z.literal(true).describe('The cooperative action was saved successfully.'),
    note: z.string().describe('The original delivery or hold acknowledgement retained for exact retries.'),
  })
  .describe('An idempotent acknowledgement for one cooperative team action.');

export type TeamMessage = z.infer<typeof teamMessageSchema>;
export type TeamPeer = z.infer<typeof teamPeerSchema>;
export type Team = z.infer<typeof teamSchema>;
export type TeamResult = z.infer<typeof teamResultSchema>;
