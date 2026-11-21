import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { serveDevPreview } from './dev-proxy.ts';

function get(url, pathname, headers = {}, method = 'GET') {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const call = request(
      {
        hostname: '127.0.0.1',
        port: target.port,
        method,
        path: pathname,
        headers: { Host: target.host, ...headers },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    call.on('error', reject);
    call.end();
  });
}

test('framework preview opens an owned capability and serves normal routes, nested assets and API requests', async (context) => {
  const child = createServer((req, res) => {
    res.setHeader('Set-Cookie', [
      'session=ok; Path=/',
      'miter_preview=bad; Path=/',
      'wide=x; Domain=localhost',
    ]);
    res.setHeader('Content-Type', 'text/plain');
    res.end(JSON.stringify({ path: req.url, method: req.method, cookie: req.headers.cookie }));
  });
  await new Promise((resolve) => child.listen(0, '127.0.0.1', resolve));
  const closed = Promise.withResolvers();
  const dev = {
    url: 'http://127.0.0.1:' + child.address().port + '/',
    framework: 'vite',
    files: 2,
    sourceRoot: '/private/miter-test/app',
    bytes: 40,
    exited: closed.promise,
    async close() {
      await new Promise((resolve) => child.close(resolve));
      closed.resolve();
    },
  };
  const capability = 'b'.repeat(32);
  const server = await serveDevPreview(dev, 'miter-' + 'a'.repeat(32) + '.localhost', capability);
  context.after(() => server.close());
  const u = new URL(server.url);
  const entry = await get(u, u.pathname);
  assert.equal(entry.status, 303);
  assert.equal(entry.headers.location, '/');
  const cookie = entry.headers['set-cookie'][0].split(';')[0];
  assert.match(entry.headers['set-cookie'][0], /HttpOnly/);
  assert.equal((await get(u, '/src/index.tsx')).status, 403);
  assert.equal((await get(u, '/src/index.tsx', { cookie, origin: 'https://example.invalid' })).status, 403);
  assert.equal((await get(u, '/api/example', { cookie }, 'POST')).status, 403);
  const asset = await get(u, '/src/index.tsx?t=123', { cookie: cookie + '; session=ok' });
  assert.equal(asset.status, 200);
  assert.deepEqual(JSON.parse(asset.body), {
    path: '/src/index.tsx?t=123',
    method: 'GET',
    cookie: 'session=ok',
  });
  assert.deepEqual(asset.headers['set-cookie'], ['session=ok; Path=/']);
  const post = await get(u, '/api/example', { cookie, origin: u.origin }, 'POST');
  assert.equal(post.status, 200);
  assert.equal(JSON.parse(post.body).method, 'POST');
});

test('a crashed dev server recovers once at its original preview URL and cleans up a second failure', async (context) => {
  let restarts = 0;
  async function child(label) {
    const server = createServer((_req, res) => res.end(label));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const exited = new Promise((resolve) => server.once('close', resolve));
    return {
      sourceRoot: '/private/miter-fixture',
      url: 'http://127.0.0.1:' + server.address().port + '/',
      exited,
      close: async () => {
        if (server.listening) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      },
    };
  }
  const first = await child('first');
  const replacement = await child('replacement');
  context.after(() => replacement.close());
  const preview = await serveDevPreview(
    first,
    'miter-' + 'f'.repeat(32) + '.localhost',
    'b'.repeat(32),
    async () => {
      restarts++;
      return replacement;
    },
  );
  context.after(() => preview.close());
  const u = new URL(preview.url);
  const opened = await get(u, u.pathname);
  const cookie = opened.headers['set-cookie'][0].split(';')[0];
  assert.equal((await get(u, '/', { cookie })).body, 'first');
  assert.equal((await get(u, '/@fs/etc/unowned.txt', { cookie })).status, 403);
  assert.equal(
    (await get(u, '/@fs/private/miter-fixture/node_modules/vite/module.js', { cookie })).status,
    200,
  );
  await first.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await get(u, '/', { cookie })).body, 'replacement');
  await replacement.close();
  await preview.exited;
  assert.equal(restarts, 1);
  assert.equal((await get(u, '/', { cookie })).status, 503);
});
