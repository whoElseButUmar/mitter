import { z } from 'zod';
import { identifierSchema } from './schemas/primitives.js';
import { readReplyJSON } from '../../protocol/src/reply-json.js';
import { parseProposalEnvelope, proposalEnvelopeSchema } from '../../protocol/src/proposal.js';
import type { ProposalEnvelope } from '../../protocol/src/proposal.js';

/** Hash the validated payload without normalizing characters in source strings.
 * Property ordering outside file contents is immaterial; every content byte is.
 */
export async function replyDigest(envelope: ProposalEnvelope): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function boundReply(raw: string, workerId: string, projectId: string): ProposalEnvelope {
  const reply = parseProposalEnvelope(raw);
  if (reply.workerId !== workerId || reply.projectId !== projectId) {
    throw new Error('This reply belongs to a different task or project. Nothing was imported.');
  }
  return reply;
}

export const replyHeadersSchema = proposalEnvelopeSchema
  .pick({ id: true, workerId: true, projectId: true, replyTo: true })
  .strip()
  .describe('The fields that link a reply to its task and outgoing message.');
export type ReplyHeaders = z.infer<typeof replyHeadersSchema>;

const replyEnvelopeHeadersSchema = replyHeadersSchema
  .extend({ protocol: proposalEnvelopeSchema.shape.protocol })
  .describe('The reply format and fields used to match it to a task.');

/** Correlation headers only. Invalid action schemas remain visible so the
 * runner can request a correction; no execution uses this relaxed reader. */
export function replyHeaders(raw: string, workerId: string, projectId: string): ReplyHeaders {
  const rawHeaders: unknown = readReplyJSON(raw);
  const parsedHeaders = replyEnvelopeHeadersSchema.safeParse(rawHeaders);
  if (
    !parsedHeaders.success ||
    parsedHeaders.data.workerId !== workerId ||
    parsedHeaders.data.projectId !== projectId
  ) {
    throw new Error('Reply headers do not match this task.', { cause: parsedHeaders.error });
  }

  const headers = parsedHeaders.data;
  const result: ReplyHeaders = { id: headers.id, workerId, projectId };
  if (headers.replyTo !== undefined) {
    result.replyTo = headers.replyTo;
  }

  return result;
}

export const replyPreviewSchema = z
  .object({
    ticket: z.string().min(1).describe('The nonempty one-use ticket needed to apply this reply.'),
    workerId: identifierSchema.describe('The task this reply belongs to.'),
    taskName: z.string().describe('The task name shown before applying the reply.'),
    summary: z.string().describe('A short explanation of what the reply proposes.'),
    source: z
      .enum(['chat', 'clipboard'])
      .describe('Whether the reply was read from the chat or copied by the user.'),
    actions: z.array(z.string()).describe('Plain-language descriptions of the proposed actions.'),
    expiresAt: z.number().describe('When the approval ticket expires, in milliseconds since the Unix epoch.'),
  })
  .describe('The proposed reply shown to the user before approval.');
export type ReplyPreview = z.infer<typeof replyPreviewSchema>;

export function actionSummary(envelope: ProposalEnvelope): string[] {
  return envelope.actions.map((action) => {
    switch (action.type) {
      case 'write':
        return 'Write ' + action.path + ' (' + new TextEncoder().encode(action.content).length + ' bytes)';
      case 'replace':
        return 'Edit ' + action.path;
      case 'read':
        return 'Read ' + action.path;
      case 'list':
        return 'List ' + action.path;
      case 'search':
        return 'Search project';
      case 'command':
        return 'Request command: ' + action.profileId + ' (approval rules apply)';
      case 'finish':
        return 'Request goal verification';
      case 'ask':
        return 'Ask for your decision';
      case 'team_message':
        return 'Send team context';
      case 'team_pause':
        return 'Request a cooperative task pause';
      case 'team_resume':
        return 'Release a cooperative pause';
      case 'diff':
        return 'Read file differences';
    }
  });
}

/** A layout/transport dead end should offer a different action, not another
 * identical Resume attempt. Other pauses (drafts, approvals, limits) retain
 * their own next action. The Tools fallback is always explicitly selectable. */
export function preferReplyRecovery(errorCode?: string): boolean {
  return [
    'TRANSCRIPT_UNSUPPORTED',
    'TRANSCRIPT_LIMIT',
    'USER_ECHO_UNREADABLE',
    'REPLY_DISAPPEARED',
    'REPLY_RECOVERY_EXHAUSTED',
    'REPLY_LINK_MISSING',
    'REPLY_FORMAT',
    'REPLY_SCHEMA',
    'REPLY_NOT_ADVANCING',
    'REPLY_UNREADABLE',
    'MESSAGE_COLLAPSED',
    'FIRST_SEND_UNCONFIRMED',
    'USER_TURN_UNCONFIRMED',
    'SAVED_SEND_MISMATCH',
  ].includes(errorCode || '');
}
