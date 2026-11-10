import { z } from 'zod';
import { assetChunkSchema } from '../../../protocol/src/rpc.js';

export const PREVIEW_LIMIT = 24 * 1024 * 1024;
export const PREVIEW_CHUNK_SIZE = 192000;

export const PreviewAssetSchema = z
  .object({
    path: z.string().describe('Project-relative source file path.'),
    mime: z.string().describe('Host-provided MIME type.'),
    size: z.number().int().nonnegative().describe('Exact asset byte length.'),
    bytes: z.instanceof(Uint8Array).describe('Unmodified source bytes assembled from the host stream.'),
    stamp: z.string().describe('Host file identity used to detect changes during streaming.'),
  })
  .describe('Complete local asset for a bounded read-only preview.');

export const PreviewChunkSchema = assetChunkSchema
  .extend({
    data: assetChunkSchema.shape.data
      .max(Math.ceil(PREVIEW_CHUNK_SIZE / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((data) => data.length % 4 === 0)
      .describe('Bounded host-encoded base64 chunk bytes, checked before decoding.'),
  })
  .describe('Untrusted worker.asset response; checked before assembling source bytes.');

export const PreviewDocumentSchema = z
  .object({
    html: z.string().describe('Assembled HTML for the opaque preview sandbox, not the workspace DOM.'),
    warnings: z.array(z.string()).describe('Limitations and unavailable local resources.'),
  })
  .describe('Isolated local document preview.');

export {
  PreviewMessageSchema,
  PreviewReadySchema,
  type PreviewMessage,
  type PreviewReady,
} from './sandbox-messages.js';

export type PreviewAsset = z.infer<typeof PreviewAssetSchema>;
export type PreviewDocument = z.infer<typeof PreviewDocumentSchema>;
export type PreviewRPC = (method: string, params: Record<string, unknown>) => Promise<unknown>;
