import { z } from 'zod';
import { exchangeIdSchema, normalizeMessageText } from '../schemas/primitives.js';

/** The wrapper preserves the full outgoing message. Its exchange ID alone
 * never proves that the expected user message was sent. */
export const WIRE_INSTRUCTION =
  'Follow the task instructions in this text block. Return only the requested mitter/1 JSON reply.';

const exchangeIdPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const messageFrameSchema = z
  .object({
    exchangeId: exchangeIdSchema.describe('The exchange that contains this complete message.'),
    payload: z
      .string()
      .describe('The original task or report text, with its spaces and source characters intact.'),
  })
  .describe('A complete outgoing message decoded from its transport wrapper.');

export type MessageFrame = z.infer<typeof messageFrameSchema>;

export function wrapMessage(payload: string, exchangeId: string): string {
  if (!exchangeIdSchema.safeParse(exchangeId).success) {
    throw new Error('Invalid message exchange ID.');
  }

  let longestBacktickRun = 2;

  for (const match of payload.matchAll(/`+/g)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  }

  const fence = '`'.repeat(longestBacktickRun + 1);

  return `MITTER EXCHANGE ${exchangeId}\n${WIRE_INSTRUCTION}\n\n${fence}text\n${payload}\n${fence}\n\nEND MITTER EXCHANGE ${exchangeId}`;
}

export function unwrapMessage(text: string): MessageFrame | undefined {
  const value = text.replace(/\r\n/g, '\n').trim();
  const headerPattern = new RegExp(
    '^MITTER EXCHANGE (' +
      exchangeIdPattern +
      ')\\n' +
      escapePattern(WIRE_INSTRUCTION) +
      '\\n\\n(`{3,})text\\n',
    'i',
  );
  const header = headerPattern.exec(value);

  if (!header) {
    return;
  }

  const exchangeId = header[1];
  const fence = header[2];

  if (!exchangeId || !fence) {
    return;
  }

  const footer = `\n${fence}\n\nEND MITTER EXCHANGE ${exchangeId}`;

  if (!value.endsWith(footer)) {
    return;
  }

  const payload = value.slice(header[0].length, -footer.length);

  if (wrapMessage(payload, exchangeId) !== value) {
    return;
  }

  return { exchangeId, payload };
}

export function messagePayload(text: string): string {
  const frame = unwrapMessage(text);

  if (frame) {
    return frame.payload;
  }

  return text;
}

/** Only wrapper labels may be normalized. The payload remains unchanged. */
export function decodeRenderedMessage(before: string, payload: string, after: string): string | undefined {
  const prefix = before.replace(/\s+/g, ' ').trim();
  const suffix = after.replace(/\s+/g, ' ').trim();
  const headerPattern = new RegExp(
    '^MITTER EXCHANGE (' +
      exchangeIdPattern +
      ') ' +
      escapePattern(WIRE_INSTRUCTION) +
      '(?: (?:text|plaintext|plain text))?$',
    'i',
  );
  const header = headerPattern.exec(prefix);
  const exchangeId = header?.[1];

  if (!exchangeId || suffix !== `END MITTER EXCHANGE ${exchangeId}`) {
    return;
  }

  return wrapMessage(payload, exchangeId);
}

/** Styled DIVs can produce several complete serialization candidates. Only a
 * full saved receipt can select one; a wrapper match alone is not enough. */
export function decodeFlatRenderedMessages(text: string): string[] {
  if (text.length > 160000) {
    return [];
  }

  const value = text.replace(/\r\n/g, '\n').trim();

  if (unwrapMessage(value)) {
    return [value];
  }

  const instructionWords = WIRE_INSTRUCTION.split(' ');
  const instructionPattern = instructionWords.map(escapePattern).join('[ \t\n]+');
  const headerPattern = new RegExp(
    '^MITTER[ \t\n]+EXCHANGE[ \t\n]+(' + exchangeIdPattern + ')[ \t\n]+' + instructionPattern,
  );
  const header = headerPattern.exec(value);
  const exchangeId = header?.[1];

  if (!header || !exchangeId) {
    return [];
  }

  const footerPattern = new RegExp('END[ \t\n]+MITTER[ \t\n]+EXCHANGE[ \t\n]+' + exchangeId + '$');
  const footer = footerPattern.exec(value);

  if (!footer || footer.index < header[0].length) {
    return [];
  }

  const body = value.slice(header[0].length, footer.index).trim();

  if (!body) {
    return [];
  }

  const candidates = [wrapMessage(body, exchangeId)];
  const languageLabel = /^(?:text|plaintext|plain text)[ \t]*\n/.exec(body);

  // A language label may also be legitimate body text. Preserve both readings.
  if (languageLabel) {
    candidates.push(wrapMessage(body.slice(languageLabel[0].length), exchangeId));
  }

  return [...new Set(candidates)];
}

export function sameMessage(actual: string, expected: string): boolean {
  if (normalizeMessageText(actual) === normalizeMessageText(expected)) {
    return true;
  }

  const actualFrame = unwrapMessage(actual);
  const expectedFrame = unwrapMessage(expected);

  if (!actualFrame || !expectedFrame || actualFrame.exchangeId !== expectedFrame.exchangeId) {
    return false;
  }

  return normalizeMessageText(actualFrame.payload) === normalizeMessageText(expectedFrame.payload);
}
