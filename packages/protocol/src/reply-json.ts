/** Transport syntax only. Quoted JSON strings are never decoded, repaired,
 * trimmed or normalized: source, paths, searches and hashes retain their bytes. */
import { isRecord } from './schemas/primitives.js';

export const MAX_HANDOFF_BYTES = 400_000;

export function utf8Bytes(input: string): number {
  return new TextEncoder().encode(input).length;
}

export function exceedsHandoffBytes(input: string): boolean {
  return utf8Bytes(input) > MAX_HANDOFF_BYTES;
}

/** Rich-text whitespace recovery is allowed only outside strings, never inside
 * tokens. Quotes, commas, values, double-encoded entities and prose stay invalid. */
export function normalizeReplySyntax(source: string): string {
  const output: string[] = [];
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source.charAt(index);

    if (quoted) {
      output.push(character);

      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }

      continue;
    }

    if (character === '"') {
      quoted = true;
      output.push(character);
      continue;
    }

    if (character === ' ' || character === ' ' || character === '﻿') {
      output.push(' ');
      continue;
    }

    if (character === '&') {
      const entity = /^(?:&nbsp;|&#(?:32|160);|&#x(?:20|a0);)/i.exec(source.slice(index, index + 8));

      if (entity) {
        output.push(' ');
        index += entity[0].length - 1;
        continue;
      }
    }

    if (
      character === '\\' &&
      (source[index + 1] === '\n' || (source[index + 1] === '\r' && source[index + 2] === '\n'))
    ) {
      output.push('\n');

      if (source[index + 1] === '\r') {
        index += 2;
      } else {
        index += 1;
      }

      continue;
    }

    output.push(character);
  }

  return output.join('');
}

/** Observation only: an open JSON container may still be streaming. This never
 * repairs input or grants import authority; the full parser still gates import. */
export function isIncompleteReplyJSON(input: string): boolean {
  if (typeof input !== 'string' || exceedsHandoffBytes(input)) {
    return false;
  }

  let raw = input.trim();

  if (raw.startsWith('```')) {
    const start = /^```(?:json)?[ \t]*\r?\n/.exec(raw);

    if (!start) {
      return false;
    }

    raw = raw.slice(start[0].length).replace(/\r?\n```$/, '');
  }

  raw = normalizeReplySyntax(raw).trim();

  if (!raw.startsWith('{')) {
    return false;
  }

  const stack: string[] = [];
  let quoted = false;
  let escaped = false;

  for (const character of raw) {
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }

      continue;
    }

    if (character === '"') {
      quoted = true;
      continue;
    }

    if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      let expectedOpening = '[';

      if (character === '}') {
        expectedOpening = '{';
      }

      if (stack.pop() !== expectedOpening) {
        return false;
      }

      if (stack.length === 0) {
        return false;
      }
    }
  }

  return stack.length > 0;
}

/** Exactly one entire JSON value or fenced block; no substring/prose search.
 * Envelope object/schema validation is a separate step shared by all importers. */
export function readReplyJSON(input: string): unknown {
  if (typeof input !== 'string') {
    throw new Error('The reply must be text. No actions were imported.');
  }

  if (exceedsHandoffBytes(input)) {
    throw new Error('Handoff is too large. Split it into smaller batches.');
  }

  let raw = input.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(raw);
  const fencedBody = fence?.[1];

  if (fencedBody !== undefined) {
    raw = fencedBody;
  }

  try {
    const result: unknown = JSON.parse(normalizeReplySyntax(raw));
    return result;
  } catch (error) {
    let position: string | undefined;

    if (error instanceof Error) {
      position = /position (\d+)/.exec(error.message)?.[1];
    }

    let message = 'The reply is not a single valid JSON object';

    if (position) {
      message += ' (character ' + position + ')';
    }

    message += '. No actions were imported.';

    throw Object.assign(new Error(message), { code: 'INVALID_HANDOFF_JSON' });
  }
}

/** Plain-text transport may carry only observational actions. This check is not
 * an action validator or an authorization decision; full schema checks follow. */
export function isReadOnlyReply(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const actions = value.actions;

  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 16) {
    return false;
  }

  return actions.every((action: unknown) => {
    return (
      isRecord(action) &&
      typeof action.type === 'string' &&
      ['read', 'list', 'search', 'diff'].includes(action.type)
    );
  });
}
