import { StringDecoder } from 'node:string_decoder';

/** Best-effort credential masking, not a secrecy guarantee. Output is still
 * private project data; review it before sharing. Keep the input unmodified in
 * the actual project: this helper is for logs and reports only. */

export function redact(input: string): string {
  const redacted = input
    .replace(
      /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]* )?PRIVATE KEY-----|$)/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g,
      '[REDACTED]',
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(
      /((?:["']?)(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|authorization|auth|credential[s]?)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"']+)/gi,
      '$1[REDACTED]',
    );

  return redactUrlPasswords(redacted);
}

function redactUrlPasswords(input: string): string {
  const credentials = /[a-z0-9._%-]+:([^\s\/@'"<>#]+)(?=@)/iy;
  const pieces: string[] = [];
  let copiedUntil = 0;

  // The old unanchored greedy scheme retried every letter of a failed run.
  // Keep its embedded-scheme matches, but scan each maximal run only once.
  for (const scheme of input.matchAll(/[a-z0-9+.-]+/gi)) {
    const delimiter = scheme.index + scheme[0].length;

    if (scheme.index < copiedUntil || !input.startsWith('://', delimiter) || !/[a-z]/i.test(scheme[0])) {
      continue;
    }

    credentials.lastIndex = delimiter + 3;
    const match = credentials.exec(input);
    const password = match?.[1];

    if (password === undefined) {
      continue;
    }

    const passwordEnd = credentials.lastIndex;
    const passwordStart = passwordEnd - password.length;
    pieces.push(input.slice(copiedUntil, passwordStart), '[REDACTED]');
    copiedUntil = passwordEnd;
  }

  pieces.push(input.slice(copiedUntil));
  return pieces.join('');
}

/** Pipes may split at ANY byte, including inside a credential or Unicode code
 * point. Never redact individual chunks. Buffer complete logical lines with a
 * strict bound, dropping an overlong line in full rather than leaking its tail.
 * An unterminated short line appears when the command exits (not on each chunk).
 */

export class RedactedOutput {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private discarding = false;
  private privateKey = false;
  private ended = false;

  constructor(
    private emit: (text: string) => void,
    private maxLine = 16384,
  ) {
    if (!Number.isSafeInteger(maxLine) || maxLine < 64) {
      throw new Error('Invalid output line limit.');
    }
  }

  push(chunk: Buffer): void {
    if (!this.ended) {
      this.consume(this.decoder.write(chunk));
    }
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.consume(this.decoder.end());

    if (this.pending && !this.discarding) {
      this.line(this.pending);
    }
    this.pending = '';
  }

  private line(text: string): void {
    const begin = /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/.test(text);
    const end = /-----END (?:[A-Z ]* )?PRIVATE KEY-----/.test(text);

    if (this.privateKey || begin) {
      if (!this.privateKey) {
        this.emit('[REDACTED PRIVATE KEY]\n');
      }
      this.privateKey = !end;
      return;
    }
    this.emit(redact(text));
  }

  private consume(text: string): void {
    let start = 0;

    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      let end = newline;

      if (newline < 0) {
        end = text.length;
      }

      const segment = text.slice(start, end);

      if (!this.discarding) {
        if (this.pending.length + segment.length > this.maxLine) {
          // Never emit part of an overlong credential-bearing line.
          this.privateKey ||= /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/.test(
            this.pending + segment.slice(0, 128),
          );
          this.pending = '';
          this.discarding = true;
          this.emit('[Long output line omitted]\n');
        } else {
          this.pending += segment;
        }
      }

      if (newline < 0) {
        break;
      }

      if (!this.discarding) {
        this.line(this.pending + '\n');
      }
      this.pending = '';
      this.discarding = false;
      start = newline + 1;
    }
  }
}
