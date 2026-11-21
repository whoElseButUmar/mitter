import { z } from 'zod';

export const bundledTaskSkillIdSchema = z
  .enum(['caveman', 'no-ai-slop', 'ponytail', 'app-design', 'engineering-quality'])
  .describe('Stable name of an offline skill included with Miter.');

export type BundledTaskSkillId = z.infer<typeof bundledTaskSkillIdSchema>;

export const bundledTaskAssetSchema = z
  .enum(['foundation.css', 'components.mjs'])
  .describe('An exact, offline app-design reference asset bundled with Miter.');

export type BundledTaskAsset = z.infer<typeof bundledTaskAssetSchema>;

export const bundledTaskSkillResourceSchema = z
  .strictObject({
    id: bundledTaskSkillIdSchema,
    name: z.string().min(1).describe('Readable name of the requested built-in skill.'),
    version: z.literal(1).describe('Revision of the Miter task adaptation.'),
    instructions: z
      .string()
      .min(1)
      .max(12_000)
      .describe('Task-compatible skill instructions, bounded in UTF-16 characters.'),
    assets: z
      .array(
        z
          .strictObject({
            path: bundledTaskAssetSchema.describe('Reference asset name; never a project write target.'),
            content: z
              .string()
              .max(22_000)
              .describe('Literal reference source, bounded in UTF-16 characters.'),
          })
          .describe('One packaged reference asset returned without file or network access.'),
      )
      .max(1)
      .describe('One requested app-design reference; other skills have no assets.'),
  })
  .describe('Read-only built-in skill data; no install, execution, or file-edit authority.');

export type BundledTaskSkillResource = z.infer<typeof bundledTaskSkillResourceSchema>;
