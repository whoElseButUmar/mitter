import { VERSION } from '../constants.js';
import { id, object, only, parseSchema } from '../helpers.js';
import { readReplyJSON } from '../reply-json.js';
import {
  envelopeIdentitySchema,
  envelopeSchema,
  requestSchema,
  type Envelope,
  type Request,
} from '../schemas/envelopes.js';
import { atAction, ReplyValidationError } from '../validation.js';
import { parseAction } from './actions.js';

/** The callback is a live operation, not serialized schema data. Its return type
 * comes directly from the callback; it does not assert an unconstrained result. */
export function parseEnvelopeWith<ActionResult>(
  input: string,
  parse: (value: unknown) => ActionResult,
): Omit<Envelope, 'actions'> & { actions: ActionResult[] } {
  const envelope = object(readReplyJSON(input), 'handoff');
  const allowedKeys = Object.keys(envelopeSchema.shape);

  if (Object.keys(envelope).some((key) => !allowedKeys.includes(key))) {
    throw new ReplyValidationError({
      stage: 'schema',
      code: 'ENVELOPE_FIELDS',
      message: 'The reply contains unsupported top-level fields.',
    });
  }

  // Keep the original validation order: version/count, identity, actions, replyTo.
  parseSchema(envelopeSchema.shape.protocol, envelope.protocol);

  if (!Array.isArray(envelope.actions) || envelope.actions.length < 1 || envelope.actions.length > 16) {
    throw new Error('A handoff must contain 1–16 actions.');
  }

  const identity = parseSchema(envelopeIdentitySchema, {
    protocol: VERSION,
    id: envelope.id,
    workerId: envelope.workerId,
    projectId: envelope.projectId,
    summary: envelope.summary,
  });

  const actions = envelope.actions.map((action: unknown, index: number) => {
    try {
      return parse(action);
    } catch (error) {
      return atAction(error, index);
    }
  });

  const result: Omit<Envelope, 'actions'> & { actions: ActionResult[] } = {
    ...identity,
    actions,
  };

  if (envelope.replyTo !== undefined) {
    result.replyTo = id(envelope.replyTo, 'replyTo');
  }

  return result;
}

export function parseEnvelope(input: string): Envelope {
  return parseEnvelopeWith(input, parseAction);
}

export function parseRequest(value: unknown): Request {
  const request = object(value, 'request');
  only(request, Object.keys(requestSchema.shape));

  return parseSchema(requestSchema, request);
}
