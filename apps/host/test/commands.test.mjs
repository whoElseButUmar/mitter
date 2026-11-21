import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseProfile, runCommand } from '../src/core/commands.js';
import { RedactedOutput } from '../src/core/redaction.js';
import { appendObservation, renderObservations, encodeObservation } from '../src/core/model-observations.js';
import { temporaryDirectory } from './fixtures.mjs';

function profile(program, args = []) {
  return {
    id: 'checked',
    label: 'Fixture',
    program,
    args,
    timeoutMs: 5000,
  };
}
test('command input schema retains refusal rules and rejects ' + 'unknown/malformed request fields', () => {
  for (const program of ['sh', 'sudo', 'env', 'curl']) {
    assert.throws(() => parseProfile(profile(program)), /refused/);
  }
  assert.throws(() => parseProfile(profile('node', ['--import=unreviewed'])), /Inline code/);
  assert.throws(() => parseProfile(profile('git', ['push'])), /Git operations/);
  assert.throws(() => parseProfile(profile('find', ['-exec'])), /limited to reading/);
  assert.throws(() =>
    parseProfile({
      ...profile('node'),
      approval: true,
    }),
  );
  assert.throws(() =>
    parseProfile({
      ...profile('node'),
      args: [1],
    }),
  );
  assert.equal(
    parseProfile({
      id: 'checked',
      label: 'Fixture',
      program: 'node',
      args: ['reviewed.mjs'],
    }).timeoutMs,
    120000,
  );
  assert.equal(
    parseProfile({
      ...profile('node'),
      timeoutMs: null,
    }).timeoutMs,
    120000,
  );
});
test(
  'approved command driver uses a private environment and preserves ' + 'redacted bounded output',
  async (t) => {
    const root = await temporaryDirectory(t);
    const scratch = path.join(root, 'scratch');
    const original = process.env.MITTER_TEST_SECRET;
    process.env.MITTER_TEST_SECRET = 'must-not-inherit';
    t.after(() => {
      if (original === undefined) {
        delete process.env.MITTER_TEST_SECRET;
      } else {
        process.env.MITTER_TEST_SECRET = original;
      }
    });
    const result = await runCommand(
      profile(process.execPath, [
        '--input-type=module',
        '-e',
        "console.log(process.env.MITTER_TEST_SECRET ?? 'absent'); " +
          "console.log(process.env.HOME); console.log('api_key=supersecretvalue')" +
          ';',
      ]),
      root,
      scratch,
      new AbortController().signal,
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout.includes('absent'), true);
    assert.equal(result.stdout.includes(scratch), true);
    assert.equal(result.stdout.includes('supersecretvalue'), false);
    assert.equal(result.stdout.includes('[REDACTED]'), true);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(runCommand(profile(process.execPath), root, scratch, abort.signal));
  },
);
test('redaction handles split credentials/Unicode and observations remain ' + 'complete JSON', () => {
  const output = [];
  const redaction = new RedactedOutput((text) => output.push(text), 64);
  const bytes = Buffer.from('😀 api_key=supersecretvalue\n');
  redaction.push(bytes.subarray(0, 2));
  redaction.push(bytes.subarray(2, 14));
  redaction.push(bytes.subarray(14));
  redaction.push(Buffer.from('x'.repeat(100) + '\n'));
  redaction.end();
  assert.equal(output.join('').includes('supersecretvalue'), false);
  assert.equal(output.join('').includes('😀'), true);
  assert.equal(output.join('').includes('[Long output line omitted]'), true);
  const entries = appendObservation(
    [],
    JSON.stringify({
      action: {
        type: 'read',
        path: 'file.txt',
      },
      result: {
        content: 'x'.repeat(100000),
        hash: 'a'.repeat(64),
      },
    }),
  );
  const compact = JSON.parse(entries[0]);
  assert.equal(compact.result.contentOmitted, true);
  assert.equal(compact.result.hash, 'a'.repeat(64));
  const rendered = renderObservations(entries, 1000);
  assert.equal(JSON.parse(rendered).result.contentOmitted, true);
  assert.throws(() => encodeObservation(undefined), /JSON values/);
});

test('browser-launched commands find the host Node runtime with an empty PATH', async (t) => {
  const root = await temporaryDirectory(t);
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  t.after(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });
  await fs.writeFile(
    path.join(root, 'runtime.cjs'),
    "const { spawnSync } = require('node:child_process');\n" +
      "const nested = spawnSync('node', ['--version'], { encoding: 'utf8' });\n" +
      'console.log(JSON.stringify({ runtime: process.execPath, nested: nested.stdout.trim(), code: nested.status }));\n',
  );

  const result = await runCommand(
    parseProfile(profile('node', ['runtime.cjs'])),
    root,
    path.join(root, 'scratch'),
    new AbortController().signal,
  );

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    runtime: process.execPath,
    nested: process.version,
    code: 0,
  });
});

test('a missing executable returns a final launch failure with useful recovery guidance', async (t) => {
  const root = await temporaryDirectory(t);
  const result = await runCommand(
    profile(path.join(root, 'missing-program')),
    root,
    path.join(root, 'scratch'),
    new AbortController().signal,
  );

  assert.equal(result.code, null);
  assert.equal(result.stdout, '');
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.match(result.stderr, /executable path, execute permission, and project folder/);
  assert.match(result.stderr, /No process was started/);
});
