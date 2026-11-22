/** Model wire input is not an executable plan. Only the native host can resolve
 * a recorded read reference into an executable exact-hash precondition. */
import { object, only, parseSchema } from './helpers.js';
import { parseAction } from './parsing/actions.js';
import { parseEnvelopeWith } from './parsing/envelopes.js';
import { exceedsHandoffBytes } from './reply-json.js';
import {
  bundledWriteSchema,
  expectedHashSchema,
  generateImageActionSchema,
  readReferenceSchema,
  referencedWriteSchema,
  referencedReplaceSchema,
  type ProposalAction,
} from './schemas/actions.js';
import type { ProposalEnvelope } from './schemas/envelopes.js';
import { ReplyValidationError, editBaseError } from './validation.js';

export {
  readReferenceSchema,
  referencedEditSchema,
  proposalActionSchema,
  type ReferencedEdit,
  type GenerateImageAction,
  type ProposalAction,
} from './schemas/actions.js';
export { proposalEnvelopeSchema, type ProposalEnvelope } from './schemas/envelopes.js';

export function isReadReference(value: unknown): value is string {
  return readReferenceSchema.safeParse(value).success;
}

export function parseProposalAction(value: unknown): ProposalAction {
  const action = object(value, 'action');

  if (action.type === 'generateImage') {
    return parseSchema(generateImageActionSchema, action);
  }

  if (action.type !== 'write' && action.type !== 'replace') {
    return parseAction(action);
  }

  if (action.base !== undefined && action.expectedHash !== undefined) {
    throw new ReplyValidationError({
      stage: 'schema',
      code: 'BASE_CONFLICT',
      field: 'base',
      message: 'An edit must use either base or expectedHash, never both.',
    });
  }

  if (action.base === undefined && action.expectedHash === undefined) {
    throw new ReplyValidationError({
      stage: 'schema',
      code: 'BASE_REQUIRED',
      field: 'base',
      message:
        'An edit needs a recorded read base or an exact expectedHash. ' +
        'No default/current version is assumed.',
    });
  }

  if (
    action.base !== undefined &&
    ((!isReadReference(action.base) && action.base !== 'missing') ||
      (action.type === 'replace' && action.base === 'missing'))
  ) {
    throw editBaseError('base');
  }

  if (action.type === 'write' && Object.hasOwn(action, 'asset')) {
    if (Object.hasOwn(action, 'content')) {
      throw new Error('A write must supply either a bundled asset or file content.');
    }
    if (action.expectedHash !== undefined && !expectedHashSchema.safeParse(action.expectedHash).success) {
      throw editBaseError('expectedHash');
    }
    return parseSchema(bundledWriteSchema, action);
  }

  if (action.base === undefined) {
    return parseAction(action);
  }

  if (action.type === 'write') {
    only(action, Object.keys(referencedWriteSchema.shape));
    return parseSchema(referencedWriteSchema, action);
  }

  only(action, Object.keys(referencedReplaceSchema.shape));
  return parseSchema(referencedReplaceSchema, action);
}

export function checkProposalSize(proposal: { actions: ProposalAction[]; summary: string }): void {
  if (exceedsHandoffBytes(JSON.stringify(proposal))) {
    throw new ReplyValidationError({
      stage: 'schema',
      code: 'PROPOSAL_TOO_LARGE',
      message: 'The expanded reply exceeds 400,000 UTF-8 bytes. Split the writes across smaller batches.',
    });
  }
}

export function parseProposalEnvelope(input: string): ProposalEnvelope {
  const envelope = parseEnvelopeWith(input, parseProposalAction);

  for (const [index, action] of envelope.actions.entries()) {
    if (action.type === 'generateImage' && envelope.actions.length !== 1) {
      throw new ReplyValidationError({
        stage: 'schema',
        code: 'IMAGE_GENERATION_BATCH',
        actionIndex: index,
        field: 'type',
        message: 'Return generateImage on its own, then wait for the generated image before saving it.',
      });
    }
    if (action.type === 'finish' && index < envelope.actions.length - 1) {
      throw new ReplyValidationError({
        stage: 'schema',
        code: 'FINISH_ORDER',
        actionIndex: index,
        field: 'type',
        message: 'finish must be the final action in a batch.',
      });
    }
  }

  checkProposalSize(envelope);
  return envelope;
}
