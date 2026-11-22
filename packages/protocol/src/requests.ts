import { id, object, only, parseSchema, text } from './helpers.js';
import {
  codeSelectionSchema,
  selectionRangeSchema,
  followupRequestSchema,
  type CodeSelection,
  type Followup,
  type FollowupSummary,
  type FollowupRequest,
} from './schemas/requests.js';

export {
  codeSelectionSchema,
  followupStateSchema,
  followupSchema,
  followupSummarySchema,
  followupRequestSchema,
  type CodeSelection,
  type FollowupState,
  type Followup,
  type FollowupSummary,
  type FollowupRequest,
} from './schemas/requests.js';

/** Offsets are UTF-16 indices into the exact displayed source. Preserve the
 * original field/range error order before validating the resulting schema. */
export function parseSelection(value: unknown): CodeSelection {
  const selection = object(value, 'code selection');
  only(selection, Object.keys(codeSelectionSchema.shape));

  const range = parseSchema(selectionRangeSchema, {
    hash: selection.hash,
    start: selection.start,
    end: selection.end,
    text: selection.text,
  });

  return { path: text(selection.path, 'selected file', 1000), ...range };
}

export function parseFollowup(value: unknown): FollowupRequest {
  const request = object(value, 'follow-up');
  only(request, Object.keys(followupRequestSchema.shape));

  const result: FollowupRequest = {
    id: id(request.id, 'request ID'),
    instruction: parseSchema(followupRequestSchema.shape.instruction, request.instruction),
    autoStart: parseSchema(followupRequestSchema.shape.autoStart, request.autoStart),
  };

  if (request.selection !== undefined) {
    result.selection = parseSelection(request.selection);
  }

  const imageAttachments = parseSchema(
    followupRequestSchema.shape.imageAttachments,
    request.imageAttachments,
  );
  if (imageAttachments?.length) {
    result.imageAttachments = imageAttachments;
  }

  return result;
}

export function summarizeFollowup(followup: Followup): FollowupSummary {
  return {
    id: followup.id,
    instruction: followup.instruction.slice(0, 600),
    status: followup.status,
    createdAt: followup.createdAt,
    error: followup.error,
    path: followup.selection?.path,
  };
}
