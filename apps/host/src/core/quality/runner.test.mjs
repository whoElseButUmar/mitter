import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import '../../../../../packages/bridge/src/runner/test-source-loader.mjs';

const { runQualityTests, qualityTestResultSchema } = await import('./runner.ts');
const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 26;

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mitter-quality-test-'));
  const dataDir = path.join(root, 'host-data');
  await fs.mkdir(dataDir);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, dataDir, signal: new AbortController().signal };
}

function request(options, content, files = []) {
  return {
    ...options,
    files: [{ path: 'checks.test.mjs', content }, ...files],
    tests: ['checks.test.mjs'],
  };
}

test('snapshot validation rejects unsafe paths, undeclared tests and excess bytes before creating scratch', async (context) => {
  const options = await fixture(context);
  for (const invalid of [
    { files: [{ path: '../outside.test.mjs', content: '' }], tests: ['../outside.test.mjs'] },
    { files: [{ path: '/absolute.test.mjs', content: '' }], tests: ['/absolute.test.mjs'] },
    { files: [{ path: 'C:/absolute.test.mjs', content: '' }], tests: ['C:/absolute.test.mjs'] },
    { files: [{ path: 'nested\\file.test.mjs', content: '' }], tests: ['nested\\file.test.mjs'] },
    { files: [{ path: 'a/./checks.test.mjs', content: '' }], tests: ['a/./checks.test.mjs'] },
    { files: [{ path: 'checks.test.mjs', content: '' }], tests: ['missing.test.mjs'] },
    { files: [{ path: 'checks.test.mjs', content: '' }], tests: ['checks.test.mjs', 'checks.test.mjs'] },
    { files: [{ path: '*.test.mjs', content: '' }], tests: ['*.test.mjs'] },
    { files: [{ path: 'checks.mjs', content: '' }], tests: ['checks.mjs'] },
    { files: [{ path: 'checks.test.mjs', content: '' }], tests: [] },
    {
      files: [
        { path: 'checks.test.mjs', content: '' },
        { path: 'CHECKS.test.mjs', content: '' },
      ],
      tests: ['checks.test.mjs'],
    },
    { files: [{ path: 'checks.test.mjs', content: '界'.repeat(1_400_000) }], tests: ['checks.test.mjs'] },
  ]) {
    await assert.rejects(runQualityTests({ ...options, ...invalid }));
    assert.deepEqual(await fs.readdir(options.dataDir), []);
  }
});

test(
  'unsupported platforms or runtimes fail closed without running supplied code',
  { skip: supported },
  async (context) => {
    const options = await fixture(context);
    const result = await runQualityTests(request(options, "throw new Error('must not execute');"));
    assert.equal(result.ok, false);
    assert.equal(result.testCount, 0);
    assert.match(result.detail, /require macOS sandbox-exec and Node.js 26/);
    assert.deepEqual(await fs.readdir(options.dataDir), []);
  },
);

test(
  'isolated tests receive exact source copies, private data and no inherited credentials or Node options',
  { skip: !supported },
  async (context) => {
    const options = await fixture(context);
    const inherited = new Map();
    for (const key of ['MITER_QUALITY_SECRET', 'NODE_OPTIONS']) {
      inherited.set(key, process.env[key]);
    }
    process.env.MITER_QUALITY_SECRET = 'never inherit this';
    process.env.NODE_OPTIONS = '--require=/unreviewed/injected.cjs';
    context.after(() => {
      for (const [key, value] of inherited) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
    const source = 'export const literal = "  exact \\n &nbsp; 😀";\n';
    const result = await runQualityTests(
      request(
        options,
        `
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { literal } from './source.mjs';
test('literal source and isolated data', () => {
  assert.equal(fs.readFileSync(new URL('./source.mjs', import.meta.url), 'utf8'), ${JSON.stringify(source)});
  assert.equal(literal, '  exact \\n &nbsp; 😀');
  assert.equal(process.env.MITER_QUALITY_SECRET, undefined);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.equal(process.env.MITER_TEST_DATA, os.tmpdir());
  assert.equal(process.env.HOME, os.tmpdir());
  assert.notEqual(process.cwd(), os.tmpdir());
  const file = path.join(os.tmpdir(), 'result.json');
  fs.writeFileSync(file, '{"ok":true}');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true });
});
`,
        [{ path: 'source.mjs', content: source }],
      ),
    );
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.testCount, 1);
    assert.deepEqual(qualityTestResultSchema.parse(result), result);
    assert.deepEqual(await fs.readdir(options.dataDir), []);
    assert.equal(getEventListeners(options.signal, 'abort').length, 0);
  },
);

test(
  'generated code cannot read or write outside scratch, rewrite source, use network, children, addons or workers',
  { skip: !supported },
  async (context) => {
    const options = await fixture(context);
    const privateFile = path.join(options.root, 'private.txt');
    const attemptedWrite = path.join(options.root, 'outside.txt');
    await fs.writeFile(privateFile, 'Host-only sentinel.');
    const result = await runQualityTests(
      request(
        options,
        `
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
test('restricted APIs', () => {
  const denied = error => error.code === 'ERR_ACCESS_DENIED';
  assert.throws(() => fs.readFileSync(${JSON.stringify(privateFile)}), denied);
  assert.throws(() => fs.writeFileSync(${JSON.stringify(attemptedWrite)}, 'bad'), denied);
  assert.throws(() => fs.writeFileSync(new URL('./checks.test.mjs', import.meta.url), 'bad'), denied);
  assert.throws(() => spawnSync(process.execPath, ['--version']), denied);
  assert.throws(() => new Worker('process.exit(0)', { eval: true }), denied);
  assert.throws(() => process.dlopen({ exports: {} }, process.execPath));
  assert.throws(() => net.createServer().listen(0), denied);
});
`,
      ),
    );
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.testCount, 1);
    assert.equal(await fs.readFile(privateFile, 'utf8'), 'Host-only sentinel.');
    await assert.rejects(fs.access(attemptedWrite), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(options.dataDir), []);
  },
);

test(
  'empty, failed, skipped and prematurely exited suites cannot pass',
  { skip: !supported },
  async (context) => {
    const options = await fixture(context);
    for (const content of [
      '',
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('failure', () => assert.equal(1, 2));",
      "import test from 'node:test'; test.skip('skipped', () => {});",
      "import test from 'node:test'; test.todo('unfinished');",
      'process.exit(0);',
    ]) {
      const result = await runQualityTests(request(options, content));
      assert.equal(result.ok, false, result.detail);
      assert.equal(result.testCount, 0);
      assert.deepEqual(await fs.readdir(options.dataDir), []);
    }
  },
);

test(
  'nested named tests count correctly while empty file fallbacks add no passing tests',
  { skip: !supported },
  async (context) => {
    const options = await fixture(context);
    const input = request(
      options,
      `
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
describe('named suite', () => {
  test('first case', () => assert.equal(2 + 2, 4));
  test('second case', () => assert.notEqual(2, 4));
});
`,
      [{ path: 'empty.test.mjs', content: '' }],
    );
    input.tests.push('empty.test.mjs');
    const result = await runQualityTests(input);
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.testCount, 2);
    assert.deepEqual(await fs.readdir(options.dataDir), []);
  },
);

test('output flooding is stopped at a bounded combined byte count', { skip: !supported }, async (context) => {
  const options = await fixture(context);
  const result = await runQualityTests(
    request(options, "import fs from 'node:fs'; while (true) { fs.writeSync(1, '界'.repeat(10_000)); }"),
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /64 KiB combined UTF-8 byte limit/);
  assert.ok(result.detail.length <= 16_000);
  assert.deepEqual(await fs.readdir(options.dataDir), []);
});

test(
  'cancellation kills CPU-bound generated code, rejects to its owner and cleans up',
  { skip: !supported },
  async (context) => {
    const options = await fixture(context);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Owner stopped.')), 300);
    try {
      await assert.rejects(
        runQualityTests(request({ ...options, signal: controller.signal }, 'while (true) {}')),
        /Owner stopped/,
      );
    } finally {
      clearTimeout(timer);
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.deepEqual(await fs.readdir(options.dataDir), []);
  },
);

test(
  'a test exceeding the fixed deadline fails and releases its scratch directory',
  { skip: !supported },
  async (context) => {
    const options = await fixture(context);
    const started = Date.now();
    const result = await runQualityTests(request(options, 'while (true) {}'));
    assert.equal(result.ok, false);
    assert.match(result.detail, /exceeded its time limit/);
    assert.ok(Date.now() - started < 15_000);
    assert.equal(getEventListeners(options.signal, 'abort').length, 0);
    assert.deepEqual(await fs.readdir(options.dataDir), []);
  },
);

test(
  'cleanup removes inaccessible generated directories and external symlinks remain forbidden',
  { skip: !supported },
  async (context) => {
    const options = await fixture(context);
    const privateFile = path.join(options.root, 'private.txt');
    await fs.writeFile(privateFile, 'Keep this outside file.');
    const result = await runQualityTests(
      request(
        options,
        `
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
test('scratch cleanup boundary', () => {
  const directory = path.join(process.env.MITER_TEST_DATA, 'closed');
  fs.mkdirSync(directory, { mode: 0 });
  assert.throws(() => fs.symlinkSync(${JSON.stringify(privateFile)}, path.join(process.env.MITER_TEST_DATA, 'outside-link')), { code: 'ERR_ACCESS_DENIED' });
  assert.equal(fs.lstatSync(directory).isDirectory(), true);
});
`,
      ),
    );
    assert.equal(result.ok, true, result.detail);
    assert.equal(await fs.readFile(privateFile, 'utf8'), 'Keep this outside file.');
    assert.deepEqual(await fs.readdir(options.dataDir), []);
  },
);
