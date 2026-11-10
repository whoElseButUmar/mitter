import { z } from 'zod';
import { fileHashSchema, rpcCounterSchema, sha256Schema } from './primitives.js';

export const diffLineSchema = z
  .strictObject({
    kind: z.enum(['same', 'add', 'remove', 'omitted']).describe('Display-only line classification.'),
    text: z.string().describe('The literal source line or omission notice, bounded for display only.'),
    oldLine: z.number().int().positive().optional().describe('The one-based line in the original source.'),
    newLine: z.number().int().positive().optional().describe('The one-based line in the replacement source.'),
  })
  .describe('One bounded row of a recorded source review; it is not an executable patch.');

export const lineDiffSchema = z
  .strictObject({
    lines: z.array(diffLineSchema).describe('Display rows; they cannot reconstruct the complete source.'),
    additions: rpcCounterSchema.describe('Total added lines before display truncation.'),
    deletions: rpcCounterSchema.describe('Total removed lines before display truncation.'),
    truncated: z.boolean().describe('Whether a display length or character limit was reached.'),
    simplified: z.boolean().describe('Whether a large diff used a bounded remove/add comparison.'),
  })
  .describe('A bounded source comparison used only for review, never to apply changes.');

export const fileReviewSchema = z
  .strictObject({
    path: z.string().describe('The journaled project-relative file path.'),
    beforeHash: fileHashSchema.describe(
      'The verified original source digest, or missing for a created file.',
    ),
    afterHash: sha256Schema.describe('The verified latest journaled source digest.'),
    currentHash: fileHashSchema.describe('The current disk digest used as the restore precondition.'),
    conflict: z.boolean().describe('Whether current disk source differs from the journaled replacement.'),
    status: z.string().describe('The lifecycle status of the latest retained edit.'),
    kind: z.enum(['created', 'modified']).describe('Whether this run created or modified the file.'),
    diff: lineDiffSchema.describe('A display-only comparison of the verified journaled source versions.'),
    canRestore: z.boolean().describe('Whether the edit is applied and its current disk hash still matches.'),
    warning: z.string().optional().describe('Why restoration is disabled, when a conflict exists.'),
  })
  .describe('The full worker.change result, including journal hashes, status and live restore eligibility.');

export const changedFileSchema = z
  .strictObject({
    path: z.string().describe('The project-relative path retained in the edit journal.'),
    status: z.string().describe('The journal lifecycle status of this file edit.'),
    bytes: rpcCounterSchema.describe('The recorded replacement size in UTF-8 bytes, not character count.'),
  })
  .describe('Full file-edit metadata without source bodies.');

export const changedFilesSchema = z
  .array(changedFileSchema)
  .describe('The latest retained edit metadata for each path in the current task run.');

export const fileTextSchema = z
  .strictObject({
    content: z.string().describe('Exact decoded UTF-8 source, retaining BOM, CRLF and all whitespace.'),
    hash: sha256Schema.describe('The SHA-256 of the complete exact UTF-8 source, not a display projection.'),
  })
  .describe('The complete project.read or worker.read source and its exact content digest.');

export const browseResultSchema = z
  .strictObject({
    root: z.string().describe('The host-owned absolute execution root, including a worktree when used.'),
    files: z
      .array(z.string().describe('One confined project-relative ordinary-file path.'))
      .describe('The bounded recursively listed file paths.'),
  })
  .describe('The execution root and confined file listing returned by worker.browse.');

export const assetChunkSchema = z
  .strictObject({
    path: z.string().describe('The confined project-relative preview path.'),
    mime: z.string().describe('The preview MIME type selected from the file extension.'),
    size: rpcCounterSchema.describe('The complete ordinary-file size in bytes.'),
    offset: rpcCounterSchema.describe('The starting byte offset of this chunk.'),
    stamp: sha256Schema.describe('The file identity and timestamp digest shared by every preview chunk.'),
    data: z.string().describe('The literal base64-encoded chunk bytes; never trimmed or decoded here.'),
    eof: z.boolean().describe('Whether this chunk reaches the end of the stamped file.'),
  })
  .describe('A base64 preview chunk bound to one ordinary-file identity stamp.');

export const syntaxCheckSchema = z
  .strictObject({
    path: z.string().describe('The confined project-relative JavaScript path checked.'),
    hash: sha256Schema.describe('The digest of the exact source copied for parse-only checking.'),
    ok: z.boolean().describe('Whether parsing succeeded without timeout or cancellation.'),
    code: z.number().int().nullable().describe('The parser exit code, or null when none was observed.'),
    details: z.string().describe('Bounded redacted parser diagnostics with the temporary path replaced.'),
    scope: z.string().describe('The reminder that parsing is neither execution nor behavioral verification.'),
  })
  .describe('A JavaScript parse-only result; it makes no behavioral verification claim.');

export const workspaceRollbackSchema = z
  .strictObject({
    restored: rpcCounterSchema.describe('The number of journal entries restored by this operation.'),
    warning: z.string().describe('The reminder that command and external-system effects are not reversed.'),
  })
  .describe('A file-only rollback or single-file restore receipt, not reversal of command side effects.');

export const openedResultSchema = z
  .strictObject({
    opened: z.literal(true).describe('The explicit user-requested desktop open operation completed.'),
  })
  .describe('Acknowledgement of opening a project folder or file in its desktop application.');

export type DiffLine = z.infer<typeof diffLineSchema>;
export type LineDiff = z.infer<typeof lineDiffSchema>;
export type FileReview = z.infer<typeof fileReviewSchema>;
export type ChangedFile = z.infer<typeof changedFileSchema>;
export type FileText = z.infer<typeof fileTextSchema>;
export type BrowseResult = z.infer<typeof browseResultSchema>;
export type AssetChunk = z.infer<typeof assetChunkSchema>;
export type SyntaxCheck = z.infer<typeof syntaxCheckSchema>;
export type WorkspaceRollback = z.infer<typeof workspaceRollbackSchema>;
export type OpenedResult = z.infer<typeof openedResultSchema>;
