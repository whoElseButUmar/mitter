import type { Action } from '../../../../packages/protocol/src/index.js';
import { redact } from './redaction.js';
import { isRecord } from './types.js';

export const MAX_OBSERVATION = 48000;
const MAX_STORED = 128000;
/** Prompt rendering budget shared with the caller: whole records only, newest
 * first, older entries explicitly marked omitted. */

export const OBSERVATION_PROMPT_BUDGET = 24000;
/** Window for export/report renders (completion report), wider than the model
 * prompt budget because the reader is a human, not the model. */

export const OBSERVATION_REPORT_BUDGET = 72000;
/** Redact string VALUES, before serializing. Redacting the encoded JSON can
 * remove a closing quote; slicing the encoded JSON can remove path/hash keys. */

export const encodeObservation = (value: unknown): string => {
  const encoded = JSON.stringify(value, (_key: string, entry: unknown): unknown => {
    if (typeof entry === 'string') {
      return redact(entry);
    }

    return entry;
  });

  if (encoded === undefined) {
    throw new Error('Observations must be JSON values.');
  }

  return encoded;
};

/** Keep compact JSON readable through ChatGPT's rich-text renderer. Quote
 * escapes, URLs, inline code, Markdown links and entities can change in the
 * visible echo. JSON.parse restores their original text. */
export function escapeChatJSON(encoded: string): string {
  return encoded.replace(/\\["\\]|[/`]|\](?=\()|&(?=(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);)/gi, (token) => {
    return (
      '\\u' +
      token
        .charCodeAt(token.length - 1)
        .toString(16)
        .padStart(4, '0')
    );
  });
}

export function actionRecord(action: Action): unknown {
  if (action.type === 'write') {
    return {
      type: action.type,
      path: action.path,
      expectedHash: action.expectedHash,
      contentCharacters: action.content.length,
    };
  }

  if (action.type === 'replace') {
    return {
      type: action.type,
      path: action.path,
      expectedHash: action.expectedHash,
      beforeCharacters: action.before.length,
      afterCharacters: action.after.length,
    };
  }

  if (action.type === 'saveImage') {
    return { type: action.type, path: action.path, source: action.source.type };
  }

  return action;
}

function contentOmission(content: unknown) {
  if (typeof content === 'string') {
    return {
      contentOmitted: true,
      contentCharacters: content.length,
    };
  }

  return {};
}

function noteOmission(message: string) {
  if (message.length > 8000) {
    return {
      detailsOmitted: true,
    };
  }

  return {};
}

function compact(value: unknown): unknown {
  if (!isRecord(value)) {
    return {
      detailsOmitted: true,
    };
  }

  const observation = value;
  const result = observation.result;

  if (isRecord(result)) {
    const { content, ...metadata } = result;

    return {
      ...observation,
      result: {
        ...metadata,
        ...contentOmission(content),
        detailsOmitted: true,
      },
    };
  }

  return {
    action: observation.action ?? null,
    detailsOmitted: true,
    next: 'Repeat a focused read to retrieve current file content.',
  };
}

export function appendObservation(previous: string[], message: string): string[] {
  let value: unknown;

  try {
    value = JSON.parse(message);
  } catch {
    value = {
      note: redact(message).slice(0, 8000),
      ...noteOmission(message),
    };
  }

  let entry = encodeObservation(value);

  if (entry.length > MAX_OBSERVATION) {
    entry = encodeObservation(compact(value));
  }

  if (entry.length > MAX_OBSERVATION) {
    entry = encodeObservation({
      detailsOmitted: true,
      next: 'Request a smaller, focused result.',
    });
  }

  const entries = [...previous, entry].slice(-16);

  while (entries.reduce((sum, s) => sum + s.length, 0) > MAX_STORED && entries.length > 1) {
    entries.shift();
  }

  return entries;
}
/** Whole records only. Even legacy truncated observations are explicitly marked
 * as incomplete notes, never presented as complete machine-readable evidence. */

export function renderObservations(observations: string[], budget = OBSERVATION_REPORT_BUDGET): string {
  const rendered: string[] = [];
  let remaining = budget;
  let omitted = 0;

  for (let observationIndex = observations.length - 1; observationIndex >= 0; observationIndex--) {
    const raw = observations[observationIndex];

    if (raw === undefined) {
      continue;
    }

    let value: unknown;

    try {
      value = JSON.parse(raw);
    } catch {
      value = {
        legacyNote: redact(raw).slice(0, 3000),
        incomplete: true,
        next: 'Read current files; do not infer file versions from a partial legacy note.',
      };
    }

    // Account for the transport spelling before applying the whole-record budget.
    let record = escapeChatJSON(encodeObservation(value));

    if (record.length + 2 > remaining) {
      record = escapeChatJSON(encodeObservation(compact(value)));
    }

    if (record.length + 2 > remaining) {
      omitted++;
      continue;
    }
    rendered.unshift(record);
    remaining -= record.length + 2;
  }

  let prefix = '';

  if (omitted) {
    prefix =
      JSON.stringify({
        olderObservationsOmitted: omitted,
      }) + '\n\n';
  }

  return prefix + rendered.join('\n\n');
}
