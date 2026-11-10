import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAsset, assetText, assetDataURL, localDependency, markdownDocument } from '../src/preview.js';
import {
  filePreviewURL,
  parseFileTarget,
  validateFileTarget,
  fileWindowOptions,
} from '../src/file-target.js';
import { lineDiff, LineDiffSchema } from '../src/line-diff.js';
import { ChangeReviewSchema, HealthReportSchema } from '../src/forms/report-schemas.js';

function chunk(bytes, overrides = {}) {
  return {
    path: 'source.txt',
    mime: 'text/plain',
    size: bytes.length,
    offset: 0,
    stamp: 'a'.repeat(64),
    data: Buffer.from(bytes).toString('base64'),
    eof: true,
    ...overrides,
  };
}

test('asset streaming preserves exact bytes, BOM, CRLF, UTF-16 text, and base64 source', async () => {
  const source = '\ufeffa\r\n😀\0<script>not markup</script>\n';
  const bytes = new TextEncoder().encode(source);
  const calls = [];
  const asset = await loadAsset(
    async (method, params) => {
      calls.push({ method, params });
      if (params.offset === 0) {
        return chunk(bytes.subarray(0, 5), { size: bytes.length, eof: false });
      }
      return chunk(bytes.subarray(5), { size: bytes.length, offset: 5 });
    },
    'worker',
    'source.txt',
  );
  assert.deepEqual(asset.bytes, bytes);
  assert.equal(assetText(asset), source);
  assert.equal(assetDataURL(asset), 'data:text/plain;base64,' + Buffer.from(bytes).toString('base64'));
  assert.equal(calls[1].params.stamp, 'a'.repeat(64));
  assert.equal(calls[0].params.length, 192000);
  assert.throws(() => assetText({ ...asset, bytes: Uint8Array.of(255) }), /encoded data/);
});

test('malformed preview targets are rejected before any RPC or source allocation', async () => {
  const calls = [];
  const rpc = async (...args) => {
    calls.push(args);
    return null;
  };

  for (const [workerId, path] of [
    ['../task', 'source.txt'],
    ['worker', '../secret'],
    ['worker', '/secret'],
    ['worker', null],
  ]) {
    await assert.rejects(loadAsset(rpc, workerId, path));
  }

  assert.deepEqual(calls, []);
});

test('asset loading rejects malformed, changed, stalled, incomplete, and oversized streams', async () => {
  const bytes = Uint8Array.of(1, 2);
  await assert.rejects(loadAsset(async () => ({ ...chunk(bytes), size: '2' }), 'w', 'source.txt'));
  await assert.rejects(
    loadAsset(async () => chunk(bytes, { offset: 1 }), 'w', 'source.txt'),
    /file changed/,
  );
  await assert.rejects(
    loadAsset(async () => chunk(bytes, { size: 25 * 1024 * 1024 }), 'w', 'source.txt'),
    /preview limit/,
  );
  await assert.rejects(
    loadAsset(async () => chunk(bytes, { size: 3 }), 'w', 'source.txt'),
    /Incomplete/,
  );
  await assert.rejects(
    loadAsset(async () => chunk(new Uint8Array(), { size: 1, eof: false }), 'w', 'source.txt'),
    /stream ended/,
  );
  await assert.rejects(
    loadAsset(async () => chunk(bytes, { size: 1 }), 'w', 'source.txt'),
    /Incomplete/,
  );
  await assert.rejects(
    loadAsset(
      async (_method, params) => {
        if (params.offset === 0) {
          return chunk(Uint8Array.of(1), { size: 2, eof: false });
        }
        return chunk(Uint8Array.of(2), {
          size: 2,
          offset: 1,
          stamp: 'b'.repeat(64),
        });
      },
      'w',
      'source.txt',
    ),
    /file changed/,
  );
});

test('asset responses stay bound to the requested path on every chunk', async () => {
  await assert.rejects(
    loadAsset(async () => chunk(Uint8Array.of(1), { path: 'other.txt' }), 'w', 'requested.txt'),
    /file changed/,
  );

  let calls = 0;
  await assert.rejects(
    loadAsset(
      async (_method, params) => {
        calls += 1;
        let returnedPath = 'requested.txt';
        let eof = false;

        if (params.offset === 1) {
          returnedPath = 'other.txt';
          eof = true;
        }

        return chunk(Uint8Array.of(1), {
          path: returnedPath,
          size: 2,
          offset: params.offset,
          eof,
        });
      },
      'w',
      'requested.txt',
    ),
    /file changed/,
  );
  assert.equal(calls, 2);
});

test('asset metadata cannot shrink, grow, change MIME, or replace its validated stamp', async () => {
  for (const changes of [
    { firstSize: 10, size: 2 },
    { firstSize: 2, size: 3 },
    { firstSize: 2, mime: 'application/octet-stream' },
    { firstSize: 2, stamp: 'b'.repeat(64) },
  ]) {
    const calls = [];

    await assert.rejects(
      loadAsset(
        async (_method, params) => {
          calls.push(params);

          if (params.offset === 0) {
            return chunk(Uint8Array.of(1), {
              size: changes.firstSize,
              stamp: 'a'.repeat(64),
              eof: false,
            });
          }

          return chunk(Uint8Array.of(2), {
            offset: 1,
            size: changes.size ?? 2,
            mime: changes.mime ?? 'text/plain',
            stamp: changes.stamp ?? 'a'.repeat(64),
            eof: true,
          });
        },
        'w',
        'source.txt',
      ),
      /file changed/,
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].stamp, 'a'.repeat(64));
  }
});

test('malformed initial stamps stop streaming before a continuation read', async () => {
  for (const stamp of ['', 'stamp', null, 'a'.repeat(63), 'g'.repeat(64)]) {
    let calls = 0;
    await assert.rejects(
      loadAsset(
        async () => {
          calls += 1;
          return chunk(Uint8Array.of(1), { size: 2, eof: false, stamp });
        },
        'w',
        'source.txt',
      ),
    );
    assert.equal(calls, 1);
  }
});

test('asset chunk size and EOF must agree with the requested range and declared total', async () => {
  for (const response of [
    chunk(Uint8Array.of(1), { size: 2, eof: true }),
    chunk(Uint8Array.of(1), { size: 1, eof: false }),
    chunk(new Uint8Array(), { size: 0, eof: false }),
    chunk(new Uint8Array(192001)),
    chunk(Uint8Array.of(1), { data: 'AQ==\n' }),
    chunk(Uint8Array.of(1), { data: 'AQ' }),
  ]) {
    let calls = 0;
    await assert.rejects(
      loadAsset(
        async () => {
          calls += 1;
          return response;
        },
        'w',
        'source.txt',
      ),
    );
    assert.equal(calls, 1);
  }
});

test('valid binary assets accept bounded short reads and an empty file without altering bytes', async () => {
  const bytes = Uint8Array.from({ length: 192257 }, (_, index) => index % 256);
  const calls = [];
  const asset = await loadAsset(
    async (method, params) => {
      calls.push({ method, params });
      let length = Math.min(params.length, bytes.length - params.offset);

      if (params.offset === 192000) {
        length = 17;
      }

      const end = params.offset + length;
      return chunk(bytes.subarray(params.offset, end), {
        path: 'binary.bin',
        mime: 'application/octet-stream',
        size: bytes.length,
        offset: params.offset,
        stamp: 'a'.repeat(64),
        eof: end === bytes.length,
      });
    },
    'w',
    'binary.bin',
  );

  assert.deepEqual(asset.bytes, bytes);
  assert.equal(asset.path, 'binary.bin');
  assert.equal(asset.mime, 'application/octet-stream');
  assert.equal(asset.size, bytes.length);
  assert.equal(asset.stamp, 'a'.repeat(64));
  assert.deepEqual(
    calls.map((call) => call.params.offset),
    [0, 192000, 192017],
  );
  assert.ok(calls.every((call) => call.method === 'worker.asset' && call.params.length === 192000));
  assert.equal(calls[1].params.stamp, asset.stamp);

  const empty = await loadAsset(async () => chunk(new Uint8Array()), 'w', 'source.txt');
  assert.equal(empty.size, 0);
  assert.deepEqual(empty.bytes, new Uint8Array());
});

test('binary assets at the exact 24 MiB cap still load with bounded chunks', async () => {
  const limit = 24 * 1024 * 1024;
  const bytes = Uint8Array.from({ length: 192000 }, (_, index) => index % 256);
  let calls = 0;
  const asset = await loadAsset(
    async (_method, params) => {
      calls += 1;
      const length = Math.min(params.length, limit - params.offset);
      assert.ok(length > 0 && length <= 192000);

      return chunk(bytes.subarray(0, length), {
        size: limit,
        mime: 'application/octet-stream',
        offset: params.offset,
        eof: params.offset + length === limit,
      });
    },
    'w',
    'source.txt',
  );

  assert.equal(calls, Math.ceil(limit / 192000));
  assert.equal(asset.size, limit);
  assert.equal(asset.bytes.length, limit);
  assert.deepEqual(asset.bytes.subarray(0, bytes.length), bytes);
  assert.deepEqual(asset.bytes.subarray(limit - 256), bytes.subarray(bytes.length - 256));
});

test('abort during a later chunk takes precedence over malformed metadata and stops streaming', async () => {
  const controller = new AbortController();
  const pending = Promise.withResolvers();
  const requested = Promise.withResolvers();
  let calls = 0;
  const loading = loadAsset(
    async (_method, params) => {
      calls += 1;

      if (params.offset === 0) {
        return chunk(Uint8Array.of(255), { size: 2, eof: false });
      }

      requested.resolve();
      return pending.promise;
    },
    'w',
    'source.txt',
    controller.signal,
  );

  await requested.promise;
  controller.abort();
  pending.resolve({ path: 'other.txt', size: 'malformed' });
  await assert.rejects(loading, { name: 'AbortError' });
  assert.equal(calls, 2);
});

test('abort is checked both before RPC and after its asynchronous result', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    loadAsset(
      async () => {
        calls += 1;
      },
      'w',
      'source.txt',
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
  const pending = Promise.withResolvers();
  const second = new AbortController();
  const loading = loadAsset(() => pending.promise, 'w', 'source.txt', second.signal);
  second.abort();
  pending.resolve(chunk(Uint8Array.of(1)));
  await assert.rejects(loading, { name: 'AbortError' });
});

test('local references remain project-contained and markdown escapes all source markup', () => {
  assert.equal(localDependency('pages/index.html', '../asset.png?size=1#x'), 'asset.png');
  assert.equal(localDependency('pages/index.html', '/assets/a%20b.png'), 'assets/a b.png');
  for (const reference of [
    '../../escape',
    'https://example.com/a',
    '//example.com/a',
    '#local',
    'data:text/plain,source',
    '%',
    'a%5Cb',
    'a%00b',
  ]) {
    assert.equal(localDependency('pages/index.html', reference), undefined);
  }
  const document = markdownDocument('# Heading\r\n- **Bold**\r\n```\r\n<script>&\r\n```\r\n<img src=x>');
  assert.match(document, /<h1>Heading<\/h1>/);
  assert.match(document, /<ul><li><strong>Bold<\/strong><\/li><\/ul>/);
  assert.match(document, /<pre><code>&lt;script&gt;&amp;\n<\/code><\/pre>/);
  assert.match(document, /&lt;img src=x&gt;/);
  assert.ok(!document.includes('<img src=x>'));
});

test('file links preserve public parameters and reject ambiguous or traversing targets', () => {
  const target = { workerId: 'task_1', path: 'folder/a b#c.txt' };
  const url = filePreviewURL('https://example.test/viewer?old=1#ignored', target);
  assert.deepEqual(parseFileTarget(url), target);
  assert.equal(new URL(url).hash, '');
  assert.equal(new URL(url).searchParams.has('old'), false);
  for (const path of ['', '/absolute', '../escape', 'a/../b', 'a//b', 'C:drive', 'a\\b', 'a\0b']) {
    assert.throws(() => validateFileTarget({ workerId: 'valid', path }), /project-relative/);
  }
  assert.throws(() => validateFileTarget({ workerId: 'bad space', path: 'valid' }), /Invalid file task/);
  assert.throws(() => parseFileTarget('https://example.test/?task=a&task=b&file=x'), /incomplete/);
  assert.deepEqual(fileWindowOptions(url), {
    url,
    type: 'popup',
    focused: true,
    width: 1080,
    height: 760,
    setSelfAsOpener: false,
  });
});

test('line diff preserves source characters, line numbers, tie ordering, and final-newline notices', () => {
  assert.deepEqual(lineDiff('same\n', 'same\n').lines, []);
  const diff = lineDiff('first\r\nold\nlast\n', 'first\r\nnew\nlast');
  assert.deepEqual(diff.lines, [
    { kind: 'same', text: 'first\r', oldLine: 1, newLine: 1 },
    { kind: 'remove', text: 'old', oldLine: 2 },
    { kind: 'add', text: 'new', newLine: 2 },
    { kind: 'same', text: 'last', oldLine: 3, newLine: 3 },
    { kind: 'omitted', text: 'No final newline in the new version' },
  ]);
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
  assert.ok(LineDiffSchema.safeParse(diff).success);
  assert.equal(lineDiff('', 'x\n').lines.at(-1).text, 'Final newline added');
});

test('large diffs remain bounded and mark simplification and truncation', () => {
  const before = Array.from({ length: 501 }, (_, index) => 'old ' + index).join('\n');
  const after = Array.from({ length: 501 }, (_, index) => 'new ' + index).join('\n');
  const diff = lineDiff(before, after);
  assert.equal(diff.simplified, true);
  assert.equal(diff.truncated, true);
  assert.equal(diff.lines.length, 800);
  assert.equal(diff.additions, 501);
  assert.equal(diff.deletions, 501);
  const long = lineDiff('', 'x'.repeat(5000));
  assert.equal(long.lines[0].text.length, 4000);
  assert.equal(long.truncated, true);
});

test('report schemas require complete canonical review and health contracts', () => {
  assert.equal(
    ChangeReviewSchema.safeParse({
      path: 'x',
      kind: 'created',
      diff: {},
      canRestore: true,
    }).success,
    false,
  );
  const report = {
    version: '1',
    protocol: 'mitter/1',
    node: '26',
    platform: 'darwin',
    architecture: 'arm64',
    workflow: 'workflow',
    database: { ok: true, schema: 42, bytes: 8192 },
    tasks: { total: 2, active: 0, finished: 1, stopped: 1 },
    dataDirectory: '/private',
    attention: [],
    backups: [
      {
        format: 'miter-state-backup/1',
        id: 'state-20261011T123456789Z-11111111-1111-4111-8111-111111111111',
        createdAt: 1000,
        schemaVersion: 42,
        bytes: 123,
        reason: 'manual',
        appVersion: '1',
        sha256: 'a'.repeat(64),
      },
    ],
    limits: { savedProjects: 24, savedTasks: 100, previewBytes: 1000 },
    notice: 'private',
  };
  assert.deepEqual(HealthReportSchema.parse(report), report);
  assert.equal(HealthReportSchema.safeParse({ ...report, attention: [null] }).success, false);
  assert.equal(
    HealthReportSchema.safeParse({ ...report, attention: [{ id: 'task', name: 'Task', state: 'invented' }] })
      .success,
    false,
  );
  assert.equal(
    HealthReportSchema.safeParse({
      ...report,
      attention: [{ id: 'task', name: 'Task', state: 'paused', reason: 'Review', retained: 'details' }],
    }).success,
    false,
  );
  assert.equal(HealthReportSchema.safeParse({ ...report, retained: 'details' }).success, false);
  assert.equal(
    HealthReportSchema.safeParse({
      ...report,
      tasks: { total: '2', active: 0 },
    }).success,
    false,
  );
});
