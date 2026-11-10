import { z } from 'zod/mini';

export const PREVIEW_HTML_LIMIT = 36000000;

export const PreviewMessageSchema = z
  .object({
    kind: z
      .literal('miter.preview')
      .check(z.describe('The parent is supplying one isolated local document preview.')),
    html: z.string().check(
      // Zod length checks count code points; the existing wire limit counts UTF-16 code units.
      z.refine((html) => html.length <= PREVIEW_HTML_LIMIT),
      z.describe(
        'Literal preview HTML, at most 36 million UTF-16 code units, without trimming or rewriting.',
      ),
    ),
  })
  .check(
    z.describe('A bounded document payload accepted only from the outer sandbox’s pinned parent window.'),
  );
export type PreviewMessage = z.infer<typeof PreviewMessageSchema>;

export const PreviewReadySchema = z
  .object({
    kind: z
      .literal('miter.preview.ready')
      .check(z.describe('The outer sandbox is ready to receive its document.')),
  })
  .check(z.describe('A readiness message accepted only from the parent’s current preview iframe window.'));
export type PreviewReady = z.infer<typeof PreviewReadySchema>;
