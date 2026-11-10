import assert from 'node:assert/strict';
import test from 'node:test';
import { redact, RedactedOutput } from '../src/core/redaction.js';
import { encodeObservation } from '../src/core/model-observations.js';
import { longRedactionCases, referenceRedact } from './redaction-fixtures.mjs';

function streamed(input, cuts, maxLine = 64) {
  const emitted = [];
  const output = new RedactedOutput((text) => emitted.push(text), maxLine);
  const bytes = Buffer.from(input);
  let start = 0;

  for (const end of cuts) {
    output.push(bytes.subarray(start, end));
    start = end;
  }
  output.push(bytes.subarray(start));
  output.end();
  output.end();
  output.push(Buffer.from('must not appear after end'));

  return emitted.join('');
}

test('credential URL masking preserves scheme, username, password and delimiter boundaries', () => {
  const examples = [
    ['https://user:pass@example.test/path', 'https://user:[REDACTED]@example.test/path'],
    ['123HTTPS://User.Name:%40p+9@example.test', '123HTTPS://User.Name:[REDACTED]@example.test'],
    ['pre_https://u:pass@h', 'pre_https://u:[REDACTED]@h'],
    ['+.-A://u:p:a=b@h', '+.-A://u:[REDACTED]@h'],
    ['πhttps://u:p@h', 'πhttps://u:[REDACTED]@h'],
    ['9://u:pass@h', '9://u:pass@h'],
    ['https://u:@h', 'https://u:@h'],
    ['https://u:pass/part@h', 'https://u:pass/part@h'],
    ['https://u:pass#part@h', 'https://u:pass#part@h'],
    ["https://u:pass'part@h", "https://u:pass'part@h"],
    ['https://u:pass"part@h', 'https://u:pass"part@h'],
    ['https://u:pass part@h', 'https://u:pass part@h'],
    ['https://üser:pass@h', 'https://üser:pass@h'],
    ['https://u:p@@h', 'https://u:[REDACTED]@@h'],
    ['https://u:p@http://other:q@h', 'https://u:[REDACTED]@http://other:[REDACTED]@h'],
    ['https://u:ftp://other:p@h', 'https://u:ftp://other:[REDACTED]@h'],
  ];

  for (const [input, expected] of examples) {
    assert.equal(referenceRedact(input), expected, input);
    assert.equal(redact(input), expected, input);
  }
});

test('URL combinations remain byte-identical to the original ordered redaction rules', () => {
  const schemes = [
    'https',
    'HTTPS',
    'a+b.c-9',
    '123abc',
    '0123.+ab',
    '+.-A',
    'foo_bar',
    '9',
    '123+.-',
    '',
    'åhttp',
    'auth',
  ];
  const usernames = ['user', 'A._%-9', '', 'a:b', 'us+er', 'us/er', 'ümlaut', 'a=b', 'token'];
  const passwords = [
    'pwd',
    'p:a=b',
    'a?b;c',
    '[]{}()+%',
    'p@q',
    'p q',
    'p\tq',
    'p/q',
    'p#q',
    'p"q',
    "p'q",
    'p<q',
    'p>q',
    '',
  ];

  for (const scheme of schemes) {
    for (const username of usernames) {
      for (const password of passwords) {
        const input = 'before ' + scheme + '://' + username + ':' + password + '@host/path after';
        assert.equal(redact(input), referenceRedact(input), input);
      }
    }
  }
});

test('deterministic mixed punctuation and embedded URL candidates preserve the original output', () => {
  const fragments = [
    'a',
    'Z',
    '0',
    '9',
    '+',
    '-',
    '.',
    '_',
    '%',
    ':',
    '://',
    '/',
    '@',
    ' ',
    '\t',
    '\n',
    '"',
    "'",
    '<',
    '>',
    '#',
    '[REDACTED]',
    'user',
    'auth',
    'password',
    'token',
    'Bearer ',
  ];
  let seed = 0x5eed1234;

  for (let sample = 0; sample < 1000; sample++) {
    let input = '';

    for (let fragment = 0; fragment < 20; fragment++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      input += fragments[seed % fragments.length];
    }
    assert.equal(redact(input), referenceRedact(input), 'sample ' + sample + ': ' + input);
  }
});

test('token thresholds, credential fields, private keys and replacement ordering are unchanged', () => {
  const tokenFamilies = [
    ['sk-', 12, 'a'],
    ['ghp_', 16, 'a'],
    ['gho_', 16, 'a'],
    ['ghu_', 16, 'a'],
    ['ghs_', 16, 'a'],
    ['ghr_', 16, 'a'],
    ['github_pat_', 22, 'a'],
    ['glpat-', 20, 'a'],
    ['xoxb-', 10, 'a'],
    ['xoxa-', 10, 'a'],
    ['xoxp-', 10, 'a'],
    ['xoxr-', 10, 'a'],
    ['xoxs-', 10, 'a'],
    ['gsk_', 20, 'a'],
    ['AIza', 35, 'a'],
    ['AKIA', 16, 'A'],
    ['ASIA', 16, 'A'],
  ];

  for (const [prefix, minimum, character] of tokenFamilies) {
    const token = prefix + character.repeat(minimum);
    assert.equal(redact(token), '[REDACTED]', token);

    for (const input of [
      token.slice(0, -1),
      'prefix' + token,
      token + '_',
      token + '-suffix',
      'π' + token + 'π',
    ]) {
      assert.equal(redact(input), referenceRedact(input), input);
    }
  }

  const cases = [
    'eyJ' + 'a'.repeat(10) + '.' + 'b'.repeat(10) + '.' + 'c'.repeat(5),
    'password="quoted value with \\"escape\\""; public=visible',
    'passwd=bare; api-key=another, access_token=third',
    "client_secret:'single quoted value'\nrefresh-token: next",
    'Bearer abcDEF012._~+/-==, bEaReR\tsecondValue',
    'Authorization: Bearer sensitiveValue',
    'https://token:secretValue@host https://user:sk-' + 'a'.repeat(12) + '@host',
    '-----BEGIN RSA PRIVATE KEY-----\nprivate material\n-----END RSA PRIVATE KEY-----\npublic',
    '-----BEGIN PRIVATE KEY-----unterminated private material',
    '-----BEGIN PUBLIC KEY-----public material-----END PUBLIC KEY-----',
  ];

  for (const input of cases) {
    assert.equal(redact(input), referenceRedact(input), input);
  }
});

test('bounded long token-free, sensitive mixed and malformed URL inputs preserve exact output', () => {
  for (const { name, input, expected } of longRedactionCases) {
    assert.ok(input.length <= 120000, name);
    assert.equal(redact(input), expected, name);
  }
});

test('streamed masking preserves Unicode, private-key suppression and complete-line omission at every split', () => {
  const input =
    'before 😀\napi_key="secretValue"\n' +
    'x'.repeat(90) +
    'sensitiveTail@host\n' +
    '-----BEGIN RSA PRIVATE KEY-----\nprivate body\n-----END RSA PRIVATE KEY-----\nafter';
  const expected = 'before 😀\napi_key=[REDACTED]\n[Long output line omitted]\n[REDACTED PRIVATE KEY]\nafter';
  const bytes = Buffer.from(input);

  for (let split = 0; split <= bytes.length; split++) {
    assert.equal(streamed(input, [split]), expected, 'byte split ' + split);
  }
  assert.equal(
    streamed(
      input,
      Array.from({ length: bytes.length }, (_value, index) => index + 1),
    ),
    expected,
  );

  const overlongKey =
    '-----BEGIN RSA PRIVATE KEY-----' +
    'x'.repeat(100) +
    '\nprivate body\n-----END RSA PRIVATE KEY-----\nafter\n';
  assert.equal(streamed(overlongKey, []), '[Long output line omitted]\nafter\n');
});

test('serialized observations retain valid JSON, metadata and original string-value masking', () => {
  const value = {
    action: { type: 'read', path: 'source.txt' },
    result: {
      hash: 'a'.repeat(64),
      readComplete: false,
      content: 'https://user:secretValue@example.test/path\napi_key="quotedSecret"\n😀',
    },
    note: 'Authorization: Bearer sensitiveValue',
  };
  const expected = JSON.parse(
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'string') {
        return referenceRedact(entry);
      }
      return entry;
    }),
  );
  const parsed = JSON.parse(encodeObservation(value));

  assert.deepEqual(parsed, expected);
  assert.equal(parsed.result.hash, value.result.hash);
  assert.equal(parsed.result.readComplete, false);
  assert.equal(value.result.content.includes('secretValue'), true);
});
