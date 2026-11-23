import { z } from 'zod';
import { proposalActionSchema, checkSchema } from '../../protocol/src/schemas/actions.js';
import { workerSchema } from '../../protocol/src/schemas/domain.js';
import {
  envelopeSchema,
  proposalEnvelopeSchema,
  requestSchema,
  responseSchema,
} from '../../protocol/src/schemas/envelopes.js';
import { imageAttachmentSchema } from '../../protocol/src/schemas/image-attachments.js';
import { followupRequestSchema } from '../../protocol/src/schemas/requests.js';
import { rewriteReplySchema, rewriteRequestSchema } from '../../protocol/src/schemas/rewrite.js';
import { commandProfileInputSchema, workerCreateParamsSchema } from '../../protocol/src/rpc/requests.js';
import { previewStartResultSchema } from '../../protocol/src/rpc/preview.js';
import { pageReplySchema, pageRequestSchema } from '../../bridge/src/transport/messages.js';
import type { DocsSchema } from './content-types.js';

const automaticReply = proposalEnvelopeSchema.safeExtend({
  replyTo: proposalEnvelopeSchema.shape.replyTo.unwrap(),
});

const references = {
  reply: { title: 'Automatic ChatGPT reply', schema: automaticReply },
  proposal: { title: 'Proposal envelope', schema: proposalEnvelopeSchema },
  action: { title: 'Proposed action', schema: proposalActionSchema },
  envelope: { title: 'Executable handoff', schema: envelopeSchema },
  check: { title: 'Completion check', schema: checkSchema },
  worker: { title: 'Task record', schema: workerSchema },
  followup: { title: 'Follow-up request', schema: followupRequestSchema },
  image: { title: 'Image reference', schema: imageAttachmentSchema },
  commandProfile: { title: 'Test command profile input', schema: commandProfileInputSchema },
  preview: { title: 'Preview start result', schema: previewStartResultSchema },
  request: { title: 'Local RPC request', schema: requestSchema },
  response: { title: 'Local RPC response', schema: responseSchema },
  workerCreate: { title: 'New task request', schema: workerCreateParamsSchema },
  rewriteRequest: { title: 'Draft rewrite request', schema: rewriteRequestSchema },
  rewriteReply: { title: 'ChatGPT rewrite reply', schema: rewriteReplySchema },
  pageRequest: { title: 'Chat page bridge request', schema: pageRequestSchema },
  pageReply: { title: 'Chat page bridge response', schema: pageReplySchema },
} satisfies Record<DocsSchema, { title: string; schema: z.ZodType }>;

export function schemaTitle(id: DocsSchema): string {
  return references[id].title;
}

export function schemaText(id: DocsSchema): string {
  return JSON.stringify(
    z.toJSONSchema(references[id].schema, {
      io: 'input',
      reused: 'ref',
      unrepresentable: 'any',
    }),
    null,
    2,
  );
}
