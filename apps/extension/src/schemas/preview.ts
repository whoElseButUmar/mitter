import { z } from 'zod';
import { FileTargetSchema } from '../../../../packages/ui/src/file-target.js';
import {
  PREVIEW_LIMIT as previewLimit,
  PREVIEW_CHUNK_SIZE,
  PreviewChunkSchema,
} from '../../../../packages/ui/src/preview/schemas.js';
import { identifierSchema } from './primitives.js';

export const assetParametersSchema = FileTargetSchema.extend({
  offset: z.number().int().min(0).max(previewLimit).default(0).describe('The byte offset to read.'),
  length: z
    .number()
    .int()
    .min(1)
    .max(PREVIEW_CHUNK_SIZE)
    .default(PREVIEW_CHUNK_SIZE)
    .describe('The bounded chunk byte count.'),
  stamp: PreviewChunkSchema.shape.stamp.optional().describe('The exact file version for subsequent reads.'),
})
  .strict()
  .describe('A bounded read from the original task, with no mutation capability.');

export const assetRequestSchema = z
  .object({
    id: identifierSchema,
    method: z.literal('worker.asset').describe('The only standalone file viewer operation.'),
    params: assetParametersSchema,
  })
  .describe('A read-only file viewer request.');

export const assetChunkSchema = PreviewChunkSchema.extend({
  path: FileTargetSchema.shape.path.describe('The project-relative asset path.'),
  size: PreviewChunkSchema.shape.size.max(previewLimit).describe('The complete asset size in bytes.'),
  offset: PreviewChunkSchema.shape.offset.max(previewLimit).describe('The returned byte offset.'),
}).describe('A read-only file chunk with the standalone viewer’s path, size, and fingerprint restrictions.');

export type AssetChunk = z.infer<typeof assetChunkSchema>;

export function validateAssetChunk(
  result: unknown,
  params: z.infer<typeof assetParametersSchema>,
): AssetChunk {
  const chunk = assetChunkSchema.parse(result);
  const bytes = (chunk.data.length * 3) / 4 - (chunk.data.match(/=/g)?.length ?? 0);

  if (
    chunk.path !== params.path ||
    chunk.offset !== params.offset ||
    bytes > params.length ||
    chunk.offset + bytes > chunk.size ||
    chunk.eof !== (chunk.offset + bytes === chunk.size) ||
    (params.stamp !== undefined && chunk.stamp !== params.stamp)
  ) {
    throw new Error('The file response does not match the requested path, range, or exact version.');
  }

  return chunk;
}
