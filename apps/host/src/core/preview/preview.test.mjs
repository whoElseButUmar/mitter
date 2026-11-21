import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { snapshotApp } from './snapshot.ts';
import { serveSnapshot } from './server.ts';
import { PreviewSessions } from './sessions.ts';
import {
  previewStartResultSchema,
  parseRpcParams,
  coreRpcRegistry,
} from '../../../../../packages/protocol/src/rpc.ts';

const boundary = { runId: 'run_1', epoch: 0 };
const html =
  '<!doctype html><link rel="stylesheet" href="styles.css"><script type="module" src="app.mjs"></script><h1>Local app</h1>';
const app = "import {\n validate\n} from './domain.mjs';\nexport { validate };";

async function fixture(context, files = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mitter-preview-')));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries({
    'index.html': html,
    'styles.css': 'h1 { color: black; }',
    'app.mjs': app,
    'domain.mjs': 'export function validate(value) { return Boolean(value); }',
    'credentials.json': '{"never":"serve"}',
    'unused.js': 'throw new Error("not linked");',
    ...files,
  })) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

export function readPreview(url, options = {}) {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: '127.0.0.1',
        port: address.port,
        method: options.method ?? 'GET',
        path: options.path ?? address.pathname,
        headers: { Host: address.host, ...options.headers },
        agent: false,
        timeout: 2000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    call.on('timeout', () => call.destroy(new Error('Preview request timed out.')));
    call.on('error', reject);
    call.end(options.body);
  });
}

test('snapshot follows linked local resources and module imports without exposing unrelated project files', async (context) => {
  const root = await fixture(context, {
    'styles.css': '@import "layout.css"; @font-face { src:url("assets/font.woff2"); }',
    'layout.css': 'h1 { color: black; }',
    'assets/font.woff2': 'font bytes',
    'app.mjs': "const docs = 'https://example.com/reference';\n" + app + "\nimport('./lazy.mjs');",
    'lazy.mjs': 'export const lazy = true;',
  });
  const snapshot = await snapshotApp(root, new AbortController().signal);
  assert.deepEqual([...snapshot.assets.keys()].sort(), [
    'app.mjs',
    'assets/font.woff2',
    'domain.mjs',
    'index.html',
    'layout.css',
    'lazy.mjs',
    'styles.css',
  ]);
  assert.equal(snapshot.assets.get('index.html').bytes.toString(), html);
  assert.ok(snapshot.bytes > 0);
});

test('snapshot rejects private paths, backend imports, computed imports and unsupported network apps', async (context) => {
  const root = await fixture(context);
  for (const source of [
    "import './credentials.json';",
    "import './.env.js';",
    "import '../outside.js';",
    "import './config.js';",
    "import './domain.test.mjs';",
    "import './node_modules/package/index.js';",
    "import 'react';",
    "import 'node:fs';",
    "import('https://example.com/app.js');",
    'import(selectedModule);',
    "fetch('/api/records');",
    "require('./domain.mjs');",
  ]) {
    await fs.writeFile(path.join(root, 'app.mjs'), source);
    await assert.rejects(snapshotApp(root, new AbortController().signal), undefined, source);
  }
  await fs.writeFile(path.join(root, 'index.html'), '<script src="https://example.com/app.js"></script>');
  await assert.rejects(snapshotApp(root, new AbortController().signal), /relative local assets/);
  await fs.writeFile(path.join(root, 'index.html'), '<base href="https://example.com/">');
  await assert.rejects(snapshotApp(root, new AbortController().signal), /base URLs/);
});

test('missing entry and linked assets explain how to recover without exposing a raw filesystem error', async (context) => {
  const root = await fixture(context);
  await fs.unlink(path.join(root, 'domain.mjs'));
  await assert.rejects(
    snapshotApp(root, new AbortController().signal),
    /missing file: domain.mjs.*Restore or build/,
  );
  await fs.unlink(path.join(root, 'index.html'));
  await assert.rejects(snapshotApp(root, new AbortController().signal), /No index.html.*built static app/);
});

test('snapshot rejects symlinks, hard links, excessive source and cancellation', async (context) => {
  const root = await fixture(context);
  await fs.rename(path.join(root, 'domain.mjs'), path.join(root, 'original.mjs'));
  await fs.symlink(path.join(root, 'original.mjs'), path.join(root, 'domain.mjs'));
  await assert.rejects(snapshotApp(root, new AbortController().signal), /Symbolic links/);
  await fs.unlink(path.join(root, 'domain.mjs'));
  await fs.link(path.join(root, 'original.mjs'), path.join(root, 'domain.mjs'));
  await assert.rejects(snapshotApp(root, new AbortController().signal), /Hard-linked/);
  await fs.unlink(path.join(root, 'domain.mjs'));
  await fs.writeFile(path.join(root, 'domain.mjs'), ' '.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(snapshotApp(root, new AbortController().signal), /8 MiB/);
  const controller = new AbortController();
  controller.abort(new Error('Stopped snapshot.'));
  await assert.rejects(snapshotApp(root, controller.signal), /Stopped snapshot/);
});

test('loopback preview serves immutable assets and rejects unauthorized hosts, origins, paths and methods', async (context) => {
  const root = await fixture(context);
  const snapshot = await snapshotApp(root, new AbortController().signal);
  const capability = 'a'.repeat(32);
  const server = await serveSnapshot(snapshot, 'miter-' + 'b'.repeat(32) + '.localhost', capability);
  context.after(() => server.close());
  await fs.writeFile(path.join(root, 'index.html'), 'changed after snapshot');
  const result = await readPreview(server.url);
  assert.equal(result.status, 200);
  assert.equal(result.body, html);
  assert.match(result.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(result.headers['content-security-policy'], /worker-src 'none'/);
  assert.match(result.headers['content-security-policy'], /sandbox [^;]*allow-forms/);
  assert.match(result.headers['content-security-policy'], /sandbox [^;]*allow-popups(?:;|$)/);
  assert.doesNotMatch(result.headers['content-security-policy'], /allow-popups-to-escape-sandbox/);
  assert.equal((await readPreview(server.url, { path: '/' + capability + '/?player=O' })).body, html);
  const missing = await readPreview(server.url, { path: '/', headers: { 'Sec-Fetch-Dest': 'document' } });
  assert.equal(missing.status, 404);
  assert.match(missing.body, /Open app/);
  assert.ok(!missing.body.includes(capability));
  assert.equal((await readPreview(server.url, { path: '/favicon.ico' })).status, 204);
  assert.match(result.headers['content-security-policy'], /form-action 'none'/);
  assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(result.headers['cross-origin-opener-policy'], 'same-origin');
  const navigationHeaders = { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' };
  for (const site of ['none', 'cross-site', 'same-origin']) {
    const navigation = await readPreview(server.url, {
      headers: { ...navigationHeaders, 'Sec-Fetch-Site': site },
    });
    assert.equal(navigation.status, 200);
    assert.equal(navigation.headers['content-security-policy'], result.headers['content-security-policy']);
    if (site === 'same-origin') {
      assert.equal(navigation.headers['cross-origin-opener-policy'], undefined);
    } else {
      assert.equal(navigation.headers['cross-origin-opener-policy'], 'same-origin');
    }
  }
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.equal((await readPreview(server.url, { method: 'HEAD' })).body, '');
  assert.equal((await readPreview(server.url, { method: 'POST' })).status, 405);
  assert.equal((await readPreview(server.url, { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal(
    (await readPreview(server.url, { headers: { Origin: 'https://attacker.example' } })).status,
    403,
  );
  assert.equal((await readPreview(server.url, { headers: { Origin: 'null' } })).status, 403);
  assert.equal(
    (
      await readPreview(server.url, {
        headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'script' },
      })
    ).status,
    403,
  );
  for (const requested of [
    '/',
    '/index.html',
    '/' + 'c'.repeat(32) + '/index.html',
    '/' + capability + '/../index.html',
    '/' + capability + '/%2e%2e/index.html',
    '/' + capability + '/%2findex.html',
    '/' + capability + '/%5cindex.html',
    '/' + capability + '/.env',
    '/' + capability + '/credentials.json',
    '/' + capability + '/unused.js',
    '/' + capability + '/%zz',
  ]) {
    assert.equal((await readPreview(server.url, { path: requested })).status, 404, requested);
  }
  assert.equal((await readPreview(server.url, { path: '/' + capability + '/app.mjs?v=1' })).status, 200);
  await server.close();
  await server.close();
  await assert.rejects(readPreview(server.url));
});

test('snapshot rejects excess linked file count and aggregate bytes without serving a partial app', async (context) => {
  const root = await fixture(context);
  await fs.writeFile(
    path.join(root, 'index.html'),
    Array.from({ length: 256 }, (_, index) => '<img src="image-' + index + '.png">').join('\n'),
  );
  await assert.rejects(snapshotApp(root, new AbortController().signal), /256 linked assets/);
  await fs.writeFile(
    path.join(root, 'index.html'),
    '<img src="one.png"><img src="two.png"><img src="three.png">',
  );
  const bytes = Buffer.alloc(8 * 1024 * 1024);
  for (const filename of ['one.png', 'two.png', 'three.png']) {
    await fs.writeFile(path.join(root, filename), bytes);
  }
  await assert.rejects(snapshotApp(root, new AbortController().signal), /24 MiB/);
});

test('sessions return constrained URLs and stale cleanup cannot close a replacement', async (context) => {
  const root = await fixture(context);
  const sessions = new PreviewSessions();
  context.after(() => sessions.close());
  const first = await sessions.start('worker_1', boundary, root, () => {});
  assert.deepEqual(previewStartResultSchema.parse(first), first);
  const second = await sessions.start('worker_1', boundary, root, () => {});
  assert.notEqual(new URL(first.url).origin, new URL(second.url).origin);
  assert.notEqual(first.previewId, second.previewId);
  assert.deepEqual(await sessions.stop('worker_1', first.previewId), { stopped: false });
  assert.deepEqual(await sessions.stop('another_worker', second.previewId), { stopped: false });
  await assert.rejects(
    sessions.stop('worker_1', second.previewId, { runId: 'new_run', epoch: 0 }),
    /different task run/,
  );
  assert.equal((await readPreview(second.url)).status, 200);
  await assert.rejects(readPreview(first.url));
  assert.deepEqual(await sessions.stop('worker_1', second.previewId, boundary), { stopped: true });
  assert.deepEqual(await sessions.stop('worker_1', second.previewId, boundary), { stopped: false });
  for (const url of [
    'https://example.com/',
    second.url + '?redirect=evil',
    second.url.replace('.localhost', '.example.com'),
    second.url.replace(/:[0-9]+\//, ':99999/'),
  ]) {
    assert.equal(previewStartResultSchema.safeParse({ ...second, url }).success, false);
  }
  assert.throws(() =>
    parseRpcParams(coreRpcRegistry, 'worker.previewStart', {
      workerId: 'worker_1',
      command: 'node server.js',
    }),
  );
});

test('preview capacity, idle expiry and shutdown own every pending and live session', async (context) => {
  const root = await fixture(context);
  const sessions = new PreviewSessions();
  context.after(() => sessions.close());
  const starts = [];
  for (let index = 0; index < 4; index++) {
    starts.push(await sessions.start('worker_' + index, boundary, root, () => {}));
  }
  await fs.writeFile(path.join(root, 'app.mjs'), "import './missing.mjs';");
  await assert.rejects(sessions.start('failed_preview', boundary, root, () => {}));
  assert.equal(
    (await readPreview(starts[0].url)).status,
    200,
    'A failed snapshot does not evict a working preview.',
  );
  await fs.writeFile(path.join(root, 'app.mjs'), app);
  const newest = await sessions.start('worker_extra', boundary, root, () => {});
  await assert.rejects(readPreview(starts[0].url));
  assert.equal((await readPreview(starts[1].url)).status, 200);
  assert.equal((await readPreview(newest.url)).status, 200);
  await sessions.expire(Date.now() + 1_800_001);
  const { runs } = sessions.runs.list('project_a', () => ({ projectId: 'project_a', name: 'Test' }));
  assert.equal(runs.find((row) => row.previewId === starts[0].previewId).state, 'stopped');
  assert.match(runs.find((row) => row.previewId === newest.previewId).output, /30 minutes of inactivity/);
  assert.ok(runs.every((row) => !row.url));
  for (const start of starts) {
    await assert.rejects(readPreview(start.url));
  }
  const pending = sessions.start('worker_pending', boundary, root, () => {});
  await assert.rejects(
    sessions.start('worker_pending', boundary, root, () => {}),
    /already opening/,
  );
  const otherPending = sessions.start('worker_other_pending', boundary, root, () => {});
  await assert.rejects(
    sessions.start('worker_too_many', boundary, root, () => {}),
    /Two previews/,
  );
  const closed = sessions.close();
  await Promise.all([assert.rejects(pending, /closing/), assert.rejects(otherPending, /closing/)]);
  await closed;
  await sessions.close();
  await assert.rejects(async () => sessions.start('new_worker', boundary, root, () => {}), /closing/);
});

test('a changed task owner cannot publish its late preview', async (context) => {
  const root = await fixture(context);
  const sessions = new PreviewSessions();
  context.after(() => sessions.close());
  let inspections = 0;
  await assert.rejects(
    sessions.start('worker_1', boundary, root, () => {
      inspections++;
      if (inspections === 3) {
        throw new Error('Task changed.');
      }
    }),
    /Task changed/,
  );
  const fresh = await sessions.start('worker_1', boundary, root, () => {});
  assert.equal((await readPreview(fresh.url)).status, 200);
});

test('declared HTTP backend persists serialized mutations across preview restarts and isolates audit data', async (context) => {
  const root = await fixture(context, {
    'miter.backend.json': JSON.stringify({ entry: 'backend.mjs', files: ['records.js'] }),
    'app.mjs': "export const load = () => fetch('./api/records');",
    'records.js': "module.exports = { filename: 'records.json' };",
    'backend.mjs': `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import records from './records.js';
      export async function handle(request, {dataDir}) {
        const url = new URL(request.url);
        if (url.pathname === '/api/payload') {
          const bytes = Number(url.searchParams.get('bytes'));
          return Response.json('x'.repeat(bytes - 2));
        }
        if (url.pathname !== '/api/records') return Response.json({error:'Missing'},{status:404});
        const target = path.join(dataDir,records.filename);
        let rows=[];
        try { rows=JSON.parse(await fs.readFile(target,'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (request.method === 'POST') {
          rows.push(await request.json());
          await fs.writeFile(target+'.tmp',JSON.stringify(rows));
          await fs.rename(target+'.tmp',target);
          return Response.json(rows.at(-1),{status:201});
        }
        return Response.json(rows);
      }
    `,
  });
  const snapshot = await snapshotApp(root, new AbortController().signal);
  assert.deepEqual([...snapshot.backend.files.keys()], ['backend.mjs', 'records.js']);
  assert.equal(snapshot.assets.has('records.js'), false);
  const hostname = 'miter-' + 'a'.repeat(32) + '.localhost';
  const id = 'c'.repeat(32);
  const store = path.join(root, 'host-private-store');
  const events = [];
  if (process.platform !== 'darwin') {
    await assert.rejects(serveSnapshot(snapshot, hostname, id, { dataDir: store }), /sandbox-exec/);
    return;
  }
  async function open(options) {
    const server = await serveSnapshot(snapshot, hostname, id, {
      dataDir: store,
      onBackendResponse: (...args) => events.push(args),
      ...options,
    });
    context.after(() => server.close());
    return server;
  }
  const first = await open({});
  const page = await readPreview(first.url);
  const sessionCookie = page.headers['set-cookie'][0].split(';')[0];
  const api = '/' + id + '/api/records';
  const headers = { Origin: new URL(first.url).origin, 'Content-Type': 'application/json' };
  const send = (options = {}) => readPreview(first.url, { path: api, ...options });
  assert.equal((await send({ path: '/api/records' })).status, 404);
  assert.equal((await send({ path: '/api/records', headers: { Cookie: sessionCookie } })).body, '[]');
  assert.equal((await send({ method: 'POST', body: '{}' })).status, 403);
  assert.equal((await send({ method: 'POST', headers: { Origin: headers.Origin }, body: '{}' })).status, 415);
  assert.equal((await send({ method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await send({ path: '/' + id + '/records.js' })).status, 404);
  assert.equal((await send({ path: api + '/../records' })).status, 404);
  assert.deepEqual(
    (
      await Promise.all(
        ['saw', 'drill'].map((tool) => send({ method: 'POST', headers, body: JSON.stringify({ tool }) })),
      )
    ).map((result) => result.status),
    [201, 201],
  );
  for (const [bytes, status] of [
    [48 * 1024, 200],
    [48 * 1024 + 1, 502],
  ]) {
    const payload = await send({ path: '/' + id + '/api/payload?bytes=' + bytes });
    assert.equal(payload.status, status);
    if (status === 200) {
      assert.equal(Buffer.byteLength(payload.body), bytes);
    } else {
      assert.match(payload.body, /48 KiB/);
    }
  }
  assert.equal(first.resetBackend, undefined);
  await first.close();
  const second = await open({});
  assert.deepEqual(
    JSON.parse((await readPreview(second.url, { path: api })).body)
      .map((row) => row.tool)
      .sort(),
    ['drill', 'saw'],
  );
  assert.equal(events.at(-1)[3], await fs.readFile(path.join(store, 'records.json'), 'utf8'));
  const audit = await open({ ephemeral: true });
  const auditRead = () => readPreview(audit.url, { path: api });
  assert.equal((await auditRead()).body, '[]');
  const add = await readPreview(audit.url, {
    path: api,
    method: 'POST',
    headers: { ...headers, Origin: new URL(audit.url).origin },
    body: '{"tool":"audit"}',
  });
  assert.equal(add.status, 201);
  await audit.resetBackend();
  assert.equal((await auditRead()).body, '[]');
  assert.equal(JSON.parse(await fs.readFile(path.join(store, 'records.json'), 'utf8')).length, 2);
});

test('backend snapshot rejects traversal, source aliases and accidental publication of private modules', async (context) => {
  const root = await fixture(context, { 'backend.mjs': 'export function handle() {}' });
  for (const manifest of [
    { entry: '../backend.mjs' },
    { entry: 'backend.mjs', files: ['Backend.mjs'] },
    { entry: 'credentials.json' },
    { entry: 'backend.mjs', files: ['domain.mjs'] },
  ]) {
    await fs.writeFile(path.join(root, 'miter.backend.json'), JSON.stringify(manifest));
    await assert.rejects(snapshotApp(root, new AbortController().signal));
  }
});
