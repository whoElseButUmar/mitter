import { z } from 'zod';
import { identifierSchema, integerSchema, textSchema } from './primitives.js';
import { imageAttachmentsSchema } from './image-attachments.js';

export const selectionRangeSchema = z
  .strictObject({
    hash: textSchema('source hash', 64)
      .refine((value) => /^[a-f0-9]{64}$/.test(value), {
        error: 'Select code from a fully loaded source file.',
      })
      .describe('Exact lowercase SHA-256 of a fully loaded source file.'),
    start: integerSchema('selection start', 0, 120_000).describe('Start offset in UTF-16 code units.'),
    end: integerSchema('selection end', 1, 120_000).describe('Exclusive end offset in UTF-16 code units.'),
    text: textSchema('selected code', 16_000, true),
  })
  .refine((value) => value.end > value.start && value.text.length === value.end - value.start, {
    error: 'The selection range does not match its text. Select the code again.',
  })
  .describe('Exact selected source text, hash and UTF-16 range.');

export const codeSelectionSchema = selectionRangeSchema
  .safeExtend({
    path: textSchema('selected file', 1000),
  })
  .describe('Exact selected source text and its UTF-16 range.');

export const followupStateSchema = z
  .enum(['queued', 'active', 'review', 'completed', 'cancelled', 'blocked', 'superseded'])
  .describe('Follow-up lifecycle state.');

export const followupSchema = z
  .strictObject({
    id: z.string().describe('Follow-up identifier.'),
    workerId: z.string().describe('Owning worker identifier.'),
    instruction: z.string().describe('User-owned follow-up instruction.'),
    selection: codeSelectionSchema.optional().describe('Optional exact source selection.'),
    imageAttachments: imageAttachmentsSchema.optional().describe('Images selected for this follow-up.'),
    status: followupStateSchema,
    createdAt: z
      .int()
      .nonnegative()
      .describe('Creation time in nonnegative whole milliseconds since the Unix epoch.'),
    activatedAt: z
      .int()
      .nonnegative()
      .optional()
      .describe('Activation time in nonnegative whole milliseconds since the Unix epoch, when available.'),
    finishedAt: z
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Terminal-state time in nonnegative whole milliseconds since the Unix epoch, when available.',
      ),
    error: z.string().optional().describe('Optional lifecycle error.'),
    baseRunId: z.string().describe('Run identifier from which the follow-up was requested.'),
    autoStart: z.boolean().describe('Whether the host should start the follow-up automatically.'),
  })
  .describe('Persisted follow-up record.');

export const followupSummarySchema = z
  .strictObject({
    id: z.string().describe('Follow-up identifier.'),
    instruction: z.string().describe('Display instruction, clipped by summarizeFollowup.'),
    status: followupStateSchema,
    createdAt: z
      .int()
      .nonnegative()
      .describe('Creation time in nonnegative whole milliseconds since the Unix epoch.'),
    error: z.string().optional().describe('Optional lifecycle error.'),
    path: z.string().optional().describe('Selected file path, when available.'),
  })
  .describe('Display-only follow-up summary; a leaf schema shared by worker snapshots.');

export const followupRequestSchema = z
  .strictObject({
    id: identifierSchema('request ID'),
    instruction: textSchema('follow-up', 4000)
      .transform((value) => value.trim())
      .describe('Validated user instruction; this boundary explicitly trims it.'),
    selection: codeSelectionSchema.optional().describe('Optional exact source selection.'),
    imageAttachments: imageAttachmentsSchema.optional().describe('Images selected for this follow-up.'),
    autoStart: z
      .boolean({ error: 'Invalid autoStart. Use true or false.' })
      .default(true)
      .describe(
        'Whether to start this follow-up automatically; omission defaults to true and explicit false keeps it queued.',
      ),
  })
  .describe('Strict user follow-up request, not a model-editable worker record.');

export type CodeSelection = z.infer<typeof codeSelectionSchema>;
export type FollowupState = z.infer<typeof followupStateSchema>;
export type Followup = z.infer<typeof followupSchema>;
export type FollowupSummary = z.infer<typeof followupSummarySchema>;
export type FollowupRequest = z.infer<typeof followupRequestSchema>;
