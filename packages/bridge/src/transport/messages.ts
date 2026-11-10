import { z } from 'zod';
import { ASSISTANT_READER_VERSION, domRequestSchema } from '../dom/types.js';
import { pageStateSchema } from './page-state.js';

export const PAGE_CHANNEL = 'mitter-page/4';
export const PAGE_READER = ASSISTANT_READER_VERSION;

export const pageMessageHeaderSchema = z
  .object({
    channel: z.literal(PAGE_CHANNEL).describe('The version of the page-message protocol.'),
    id: z.string().max(100).describe('The request ID used to match an answer to its caller.'),
  })
  .describe('The shared header of a page bridge message.');

export const pageRequestSchema = pageMessageHeaderSchema
  .extend({
    kind: z.literal('request').describe('Ask the page adapter to perform an operation.'),
    action: domRequestSchema.describe('The validated page operation to perform.'),
  })
  .describe('An authenticated request to the page adapter.');

export const pageResetSchema = pageMessageHeaderSchema
  .extend({
    kind: z.literal('reset').describe('Retire the page bridge and clear its local memory.'),
    confirmation: z.literal('CLEAR').describe('Explicit confirmation that reset was requested.'),
  })
  .describe('A confirmed reset of page-local bridge state.');

export const pageHelloRequestSchema = pageMessageHeaderSchema
  .extend({
    kind: z.literal('hello').describe('Check whether the installed page bridge is compatible.'),
  })
  .describe('A read-only compatibility check.');

export const pageHelloSchema = z
  .object({
    version: z.literal(PAGE_CHANNEL).describe('The installed page-message protocol.'),
    reader: z.literal(PAGE_READER).describe('The installed DOM reader version.'),
    instanceId: z
      .string()
      .min(1)
      .max(100)
      .describe('The installed endpoint instance answering this request.'),
    url: z.string().describe('The current page origin and path.'),
    readyState: z
      .enum(['loading', 'interactive', 'complete'])
      .describe('The standard document loading state.'),
  })
  .describe('The installed page bridge identity and loading state.');

export type PageHello = z.infer<typeof pageHelloSchema>;

export const pageOperationErrorSchema = z
  .object({
    code: z.string().optional().describe('The page failure code, when supplied.'),
    message: z.string().optional().describe('A short explanation of the failure.'),
  })
  .describe('Safe failure fields from a page operation or its error reply.');

// Routing is checked before the operation payload so stale-reader and invalid-state
// failures keep their distinct recovery codes. This projection never validates a value.
export const pageReplyHeaderSchema = pageMessageHeaderSchema
  .extend({
    instanceId: z.string().min(1).max(100).describe('The endpoint instance that produced this answer.'),
    ok: z.boolean().describe('Whether the page operation succeeded.'),
    error: pageOperationErrorSchema
      .optional()
      .describe('Failure details when the operation did not succeed.'),
  })
  .describe('The response routing fields, not an operation result.');

export const pageResetResultSchema = z
  .object({ cleared: z.literal(true).describe('The endpoint and its document-local memory were cleared.') })
  .describe('Successful completion of a page-local reset.');

export const pageReplySchema = z
  .discriminatedUnion('ok', [
    pageReplyHeaderSchema.extend({
      ok: z.literal(true).describe('The page operation succeeded.'),
      value: z
        .union([pageHelloSchema, pageStateSchema, pageResetResultSchema])
        .describe(
          'The hello, page observation, or reset result; receivers must also check the requested operation.',
        ),
    }),
    pageReplyHeaderSchema.extend({ ok: z.literal(false).describe('The page operation failed.') }),
  ])
  .describe('An answer containing known page-operation data or safe failure details.');

export type PageReply = z.infer<typeof pageReplySchema>;
