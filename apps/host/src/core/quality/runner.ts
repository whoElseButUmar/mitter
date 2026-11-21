import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { redact } from '../redaction.js';
import { inspectReadiness } from './readiness.js';
import { execute, verifiedNodeSandbox, removeScratch, type ProcessResult } from './sandbox.js';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const TEST_TIMEOUT_MS = 10_000;

const snapshotFileSchema = z
  .strictObject({
    path: z.string().min(1).max(1000).describe('Literal project-relative source path, without traversal.'),
    content: z
      .string()
      .max(MAX_SOURCE_BYTES)
      .describe('Copied source text, also limited by total UTF-8 bytes.'),
  })
  .describe('One supplied source file; no original project path is opened by this runner.');

const snapshotSchema = z
  .strictObject({
    files: z.array(snapshotFileSchema).min(1).max(256).describe('At most 256 copied source files.'),
    tests: z.array(z.string().min(1).max(1000)).min(1).max(64).describe('Explicit relative .test.mjs files.'),
  })
  .describe('A bounded source snapshot and its explicitly declared test entrypoints.');

export const qualityTestResultSchema = z
  .strictObject({
    ok: z
      .boolean()
      .describe('Whether the isolated run reported nonzero passing tests and no failures or skips.'),
    detail: z.string().max(16_000).describe('Bounded evidence or the reason execution could not pass.'),
    testCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Passing test count reported by the bounded TAP stream.'),
  })
  .describe('Execution evidence, not a guarantee that generated tests cover the requested behavior.');

export type QualityTestResult = z.infer<typeof qualityTestResultSchema>;

type QualityTestRequest = {
  files: readonly { path: string; content: string }[];
  tests: readonly string[];
  dataDir: string;
  signal: AbortSignal;
};

function refusal(detail: string): QualityTestResult {
  return qualityTestResultSchema.parse({ ok: false, detail, testCount: 0 });
}

function validatePath(relative: string): void {
  if (
    path.isAbsolute(relative) ||
    /^[a-z]:/i.test(relative) ||
    /[\\\u0000-\u001f\u007f]/.test(relative) ||
    relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Quality-test snapshots require literal relative paths without traversal.');
  }
}

function validateSnapshot(request: QualityTestRequest) {
  const parsed = snapshotSchema.safeParse({ files: request.files, tests: request.tests });
  if (!parsed.success) {
    throw new Error('Quality tests require 1–256 source files and 1–64 explicit .test.mjs files.', {
      cause: parsed.error,
    });
  }
  const snapshot = parsed.data;
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of snapshot.files) {
    validatePath(file.path);
    const key = file.path.normalize('NFC').toLowerCase();
    if (paths.has(key)) {
      throw new Error('Quality-test snapshots cannot contain duplicate or case-equivalent paths.');
    }
    paths.add(key);
    bytes += Buffer.byteLength(file.content, 'utf8');
  }
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error('Quality-test source exceeds the 4 MiB UTF-8 limit. No partial snapshot was tested.');
  }
  const tests = new Set<string>();
  for (const test of snapshot.tests) {
    validatePath(test);
    if (!test.endsWith('.test.mjs') || /[?*\[\]{}!]/.test(test)) {
      throw new Error('Quality tests must name literal .test.mjs files, without glob patterns.');
    }
    if (tests.has(test) || !snapshot.files.some((file) => file.path === test)) {
      throw new Error('Quality tests must name distinct files present in the supplied snapshot.');
    }
    tests.add(test);
  }
  return snapshot;
}

function passingTests(stdout: string, declaredTests: readonly string[]): number {
  if (!stdout.startsWith('TAP version 13\n') || /^\s*(?:not ok\b|Bail out!)/m.test(stdout)) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...stdout.matchAll(new RegExp('^# ' + key + ' (\\d+)$', 'gm'))];
    const value = Number(matches[0]?.[1]);
    if (matches.length !== 1 || !Number.isSafeInteger(value)) {
      return 0;
    }
    counts.set(key, value);
  }
  const tests = counts.get('tests') ?? 0;
  // In isolation=none mode Node counts an empty imported file as a successful
  // file subtest. Those fallback entries are not evidence of named tests.
  const fileEntries = [...stdout.matchAll(/^ok \d+ - (.+)$/gm)].filter((match) =>
    declaredTests.some((filename) => match[1] === filename || match[1] === './' + filename),
  ).length;
  const namedTests = tests - fileEntries;
  if (
    namedTests < 1 ||
    counts.get('pass') !== tests ||
    ['fail', 'cancelled', 'skipped', 'todo'].some((key) => counts.get(key) !== 0) ||
    [...stdout.matchAll(/^1\.\.([1-9]\d*)$/gm)].length !== 1
  ) {
    return 0;
  }
  return namedTests;
}

function evidence(result: ProcessResult, scratch: string): string {
  return redact([result.stopped, result.stdout, result.stderr].filter(Boolean).join('\n'))
    .split(scratch)
    .join('<test-scratch>')
    .slice(0, 12_000);
}

export async function runQualityTests(request: QualityTestRequest): Promise<QualityTestResult> {
  request.signal.throwIfAborted();
  const snapshot = validateSnapshot(request);
  const readiness = await inspectReadiness();
  request.signal.throwIfAborted();
  if (readiness.checks.domain.status !== 'ready') {
    return refusal(readiness.checks.domain.detail);
  }
  await fs.mkdir(request.dataDir, { recursive: true, mode: 0o700 });
  const parent = await fs.realpath(request.dataDir);
  const scratch = await fs.mkdtemp(path.join(parent, 'quality-'));
  try {
    const source = path.join(scratch, 'source');
    const data = path.join(scratch, 'data');
    await fs.mkdir(source, { mode: 0o700 });
    await fs.mkdir(data, { mode: 0o700 });
    for (const file of snapshot.files) {
      request.signal.throwIfAborted();
      const filename = path.join(source, file.path);
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await fs.writeFile(filename, file.content, { flag: 'wx', mode: 0o600 });
    }
    let sandbox: string[];
    try {
      sandbox = await verifiedNodeSandbox(scratch, source, data, request.signal);
    } catch (error) {
      request.signal.throwIfAborted();
      if (error instanceof Error) {
        return refusal(redact(error.message));
      }
      throw error;
    }
    const result = await execute(
      [
        ...sandbox,
        '--test',
        '--test-isolation=none',
        '--test-reporter=tap',
        '--',
        ...snapshot.tests.map((test) => './' + test),
      ],
      source,
      data,
      request.signal,
      TEST_TIMEOUT_MS,
    );
    request.signal.throwIfAborted();
    let testCount = 0;
    if (result.code === 0 && !result.stopped) {
      testCount = passingTests(result.stdout, snapshot.tests);
    }
    const ok = result.code === 0 && !result.stopped && testCount > 0;
    let detail =
      'Isolated tests did not report a complete, nonzero named test suite without failures or skips.';
    if (ok) {
      detail =
        `${testCount} tests passed in a read-only source copy with private temporary data. ` +
        'Network, child processes, addons and workers were denied. TAP is reported test evidence, ' +
        'not proof of coverage or browser/live HTTP behavior.';
    }
    return qualityTestResultSchema.parse({
      ok,
      testCount,
      detail: detail + '\n' + evidence(result, scratch),
    });
  } finally {
    await removeScratch(scratch);
  }
}
