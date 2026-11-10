// Frozen pre-optimization behavior is the differential oracle, not an alternate production path.
export function referenceRedact(input) {
  return input
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
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/[a-z0-9._%-]+:)([^\s\/@'"<>#]+)(?=@)/gi, '$1[REDACTED]');
}

const mixedPrefix = 'x'.repeat(50000) + '\n';
const mixedSuffix = 'y'.repeat(40000);
const malformedUrl = 'x'.repeat(50000) + '://user:pass/blocked@example.test';

export const longRedactionCases = [
  {
    name: 'token-free run',
    input: 'x'.repeat(100000),
    expected: 'x'.repeat(100000),
  },
  {
    name: 'sensitive mixed input',
    input:
      mixedPrefix +
      'HTTPS://User.Name:%40Sensitive+9@example.test/path\n' +
      'api_key="quotedSecretValue"\n' +
      'Bearer bearerValue0123456789+/==\n' +
      '-----BEGIN RSA PRIVATE KEY-----\nprivateKeyLine\n-----END RSA PRIVATE KEY-----\n' +
      mixedSuffix,
    expected:
      mixedPrefix +
      'HTTPS://User.Name:[REDACTED]@example.test/path\n' +
      'api_key=[REDACTED]\n' +
      'Bearer [REDACTED]\n' +
      '[REDACTED PRIVATE KEY]\n' +
      mixedSuffix,
  },
  {
    name: 'long malformed credential URL',
    input: malformedUrl,
    expected: malformedUrl,
  },
];
