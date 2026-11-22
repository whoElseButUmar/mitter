import { z } from 'zod';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENTS = 4;
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export const imageAttachmentSchema = z
  .strictObject({
    id: z.uuid().describe('Stable local image identifier within this browser profile.'),
    name: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (name) =>
          name === name.trim() && name !== '.' && name !== '..' && !/[\\/\u0000-\u001f\u007f]/u.test(name),
        'Use an image filename without path separators or control characters.',
      )
      .describe('Display filename with no folder path.'),
    type: z.enum(IMAGE_MIME_TYPES).describe('Supported image media type.'),
    size: z.int().min(1).max(MAX_IMAGE_BYTES).describe('Original image size in whole bytes, up to 5 MiB.'),
  })
  .describe('Local image reference. The original bytes are stored separately in the browser profile.');

const imageListSchema = z.array(imageAttachmentSchema);

function hasUniqueImageIds(images: z.infer<typeof imageListSchema>): boolean {
  return new Set(images.map(({ id }) => id)).size === images.length;
}

export const imageAttachmentsSchema = imageListSchema
  .max(MAX_IMAGE_ATTACHMENTS, 'Attach up to four images to one request.')
  .refine(hasUniqueImageIds, {
    error: 'An image can only be attached once to the same request.',
  })
  .describe('Ordered image references with unique IDs for one task or follow-up.');

export const chatImageAttachmentsSchema = imageListSchema
  .max(MAX_IMAGE_ATTACHMENTS * 2)
  .refine(hasUniqueImageIds, { error: 'A chat message cannot repeat an image attachment.' })
  .describe(
    'Images in one chat message, including the original task and follow-up when first sent together.',
  );

export type ImageAttachment = z.infer<typeof imageAttachmentSchema>;
