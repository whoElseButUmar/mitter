import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendObservation,
  encodeObservation,
  escapeChatJSON,
  renderObservations,
} from '../src/core/model-observations.js';
import { buildReport } from '../src/core/service/reports.js';

test('gym source entities and nested peer reports survive the ChatGPT user-message renderer', () => {
  const source =
    'const escaped = { "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\'": "&#39;" };';
  const value = { content: source, summary: JSON.stringify({ nested: JSON.stringify({ content: source }) }) };
  const stored = encodeObservation(value);
  const rendered = renderObservations([stored]);
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  // Both transformations occurred in the same live ChatGPT user bubble.
  const echo = (record) =>
    record
      .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity])
      .replace(/\\+(?=")/g, (run) => run + run);
  assert.notEqual(echo(stored), stored);
  assert.equal(echo(rendered), rendered);
  assert.equal(escapeChatJSON(JSON.stringify(value)), rendered);
  assert.doesNotMatch(rendered, /&(?:amp|lt|gt|quot|#39);|\\+"/);
  assert.deepEqual(JSON.parse(rendered), value);
  assert.equal(encodeObservation(value), stored);
});

test('rendered observations prevent URL autolinks while preserving parsed keys and values', () => {
  const value = {
    'https://example.test/audit': {
      url: 'https://example.test/a?x=1&y=2#detail',
      nested: ['http://localhost:4173/page', '//example.test/assets', '/', true, null, 0],
      text: 'café/界/😀/\u2028/\u2029',
      escaped: String.raw`\/\u002f\\path/`,
    },
  };
  const stored = encodeObservation(value);
  const observations = [stored];
  const rendered = renderObservations(observations);

  assert.ok(stored.includes('https://'));
  assert.equal(rendered.includes('/'), false);
  assert.ok(rendered.includes(String.raw`https:\u002f\u002fexample.test`));
  assert.deepEqual(JSON.parse(rendered), JSON.parse(stored));
  assert.deepEqual(observations, [stored]);
  assert.equal(encodeObservation(value), stored);
});

test('rendering preserves decoded source bytes including nested JSON, escapes and slash parity', () => {
  const source = [
    String.raw`const endpoint = "https://example.test/api";`,
    String.raw`const pattern = /https?:\/\/example\.test\/path/g;`,
    String.raw`const literal = "\\u002f";`,
    String.raw`const escaped = "\/";`,
    'const embedded = ' + JSON.stringify(JSON.stringify({ url: 'https://example.test/a/b' })) + ';',
    '// café/界/😀',
    '/* preserve every slash and newline */',
    '',
  ].join('\n');
  const value = {
    action: { type: 'read', path: 'src/app.mjs' },
    result: { content: source, hash: 'a'.repeat(64), readComplete: true },
    slashRuns: Array.from({ length: 8 }, (_unused, count) => '\\'.repeat(count) + '/'),
  };
  const stored = encodeObservation(value);
  const rendered = renderObservations([stored]);
  const parsed = JSON.parse(rendered);

  assert.deepEqual(parsed, value);
  assert.equal(parsed.result.content, source);
  assert.deepEqual(Buffer.from(parsed.result.content, 'utf8'), Buffer.from(source, 'utf8'));
  assert.equal(encodeObservation(value), stored);
  assert.equal(value.result.content, source);
});

test('already JSON-escaped slashes and redacted string values retain their existing meaning', () => {
  const raw = String.raw`{"url":"https:\/\/example.test\/a","literal":"\\u002f","slash":"\/"}`;
  assert.deepEqual(JSON.parse(renderObservations([raw])), JSON.parse(raw));

  const value = { url: 'https://user:privateValue@example.test/path', note: 'api_key=privateValue' };
  const stored = encodeObservation(value);
  const rendered = renderObservations([stored]);
  assert.deepEqual(JSON.parse(rendered), JSON.parse(stored));
  assert.equal(rendered.includes('privateValue'), false);
  assert.equal(value.url, 'https://user:privateValue@example.test/path');
});

test('the rendered budget counts Unicode slash escapes before compacting a whole record', () => {
  const value = {
    action: { type: 'read', path: 'src/app.mjs' },
    result: { content: '/'.repeat(200), hash: 'a'.repeat(64) },
  };
  const observations = appendObservation([], JSON.stringify(value));
  const original = [...observations];
  assert.ok(observations[0].length < 500);
  assert.equal(JSON.parse(observations[0]).result.content, value.result.content);

  const rendered = renderObservations(observations, 500);
  const compacted = JSON.parse(rendered);
  assert.ok(rendered.length <= 500);
  assert.equal(rendered.includes('/'), false);
  assert.equal(compacted.action.path, 'src/app.mjs');
  assert.equal(compacted.result.contentOmitted, true);
  assert.equal(compacted.result.contentCharacters, 200);
  assert.equal(compacted.result.hash, value.result.hash);
  assert.deepEqual(observations, original);
});

test('legacy notes and omitted records remain complete JSON without raw URL delimiters', () => {
  const legacy = 'Failed at https://example.test/a/b';
  const renderedLegacy = renderObservations([legacy]);
  assert.equal(renderedLegacy.includes('/'), false);
  assert.equal(JSON.parse(renderedLegacy).legacyNote, legacy);
  assert.equal(JSON.parse(renderedLegacy).incomplete, true);

  const records = [
    encodeObservation({ result: { url: 'https://example.test/' + '/'.repeat(100) } }),
    encodeObservation({ result: { url: 'http://localhost/' } }),
  ];
  const rendered = renderObservations(records, 180);
  const values = rendered.split('\n\n').map((record) => JSON.parse(record));
  assert.deepEqual(values[0], { olderObservationsOmitted: 1 });
  assert.deepEqual(values[1], JSON.parse(records[1]));
  assert.equal(rendered.includes('/'), false);
});

test('a full report keeps JSON fields and quality observations parseable without changing stored evidence', () => {
  const diagnostic =
    'The document at `/.well-known/item.json` is invalid. ' +
    '[Read the specification](https://example.test/docs/audit).';
  const quality = {
    quality: {
      ok: false,
      findings: [
        {
          url: 'https://example.test/docs/audit',
          message: diagnostic,
          selector: '#form\\:name',
        },
      ],
      source: { path: 'src/form.mjs', content: 'const url = `https://example.test/${name}`;' },
    },
  };
  const observation = encodeObservation(quality);
  const worker = {
    id: 'worker_1',
    name: 'Task',
    goal: 'Build the app.',
    state: 'review',
    checks: [{ type: 'exists', path: 'src/form.mjs' }],
    completion: { summary: 'See https://example.test/summary', verification: 'not-run' },
    error: diagnostic,
    observations: [observation],
  };
  const marker = 'UNTRUSTED OBSERVATIONS:';
  const report = buildReport(worker, { name: 'Project' }, marker, []);
  const checksLine = report.split('\n').find((line) => line.startsWith('Checks: '));
  const completionLine = report.split('\n').find((line) => line.startsWith('Completion: '));
  const errorLine = report.split('\n').find((line) => line.startsWith('Error: '));
  assert.ok(checksLine);
  assert.ok(completionLine);
  assert.ok(errorLine);
  assert.deepEqual(JSON.parse(checksLine.slice('Checks: '.length)), worker.checks);
  assert.deepEqual(JSON.parse(completionLine.slice('Completion: '.length)), worker.completion);
  assert.equal(JSON.parse(errorLine.slice('Error: '.length)), diagnostic);
  const observationText = report.split(marker + '\n')[1]?.split('\n\nFiles journaled in this run:')[0];
  assert.ok(observationText);
  assert.deepEqual(JSON.parse(observationText), quality);
  for (const text of [errorLine, checksLine, completionLine, observationText]) {
    // ChatGPT turned a link into “[label]\\([url](url))” and added backslashes
    // before inline-code ticks in the nested Lighthouse results for Return Tray.
    assert.doesNotMatch(text, /`|\/|\]\(/);
  }
  assert.deepEqual(worker.observations, [observation]);
});
