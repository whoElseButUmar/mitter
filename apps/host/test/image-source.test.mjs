import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { downloadPublicImage, validateProjectImage } from '../src/core/workspace/image-source.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);

function response(statusCode, headers = {}, chunks = []) {
  return Object.assign(Readable.from(chunks), { statusCode, headers });
}

function serve(context, ...responses) {
  return context.mock.method(https, 'get', (options, deliver) => {
    const next = responses.shift();
    assert.ok(next, `Unexpected request to ${options.hostname}`);
    queueMicrotask(() => deliver(next));
    return new EventEmitter();
  });
}

test('validates bounded raster bytes against the destination extension', () => {
  const gif = Buffer.from('R0lGODlhAQABAAAAACwAAAAAAQABAAA=', 'base64');
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
  const webp = Buffer.from('524946460c000000574542505650384c00000000', 'hex');
  validateProjectImage(png, 'assets/logo.PNG');
  validateProjectImage(Buffer.concat([gif, Buffer.from([0x3b])]), 'assets/motion.gif');
  validateProjectImage(jpeg, 'assets/photo.jpg');
  validateProjectImage(webp, 'assets/art.webp');
  assert.throws(() => validateProjectImage(png, 'assets/logo.jpg'), /does not match/);
  assert.throws(() => validateProjectImage(png, 'assets/logo.svg'), /filename/);
  assert.throws(() => validateProjectImage(png.subarray(0, 30), 'assets/logo.png'), /does not match/);
  assert.throws(() => validateProjectImage(Buffer.from('<svg></svg>'), 'art.png'), /does not match/);
  assert.throws(() => validateProjectImage(Buffer.alloc(5 * 1024 * 1024 + 1), 'art.png'), /5 MiB/);
});

test('downloads through revalidated redirects with no cookies, referrer, or second DNS lookup', async (context) => {
  const dns = context.mock.method(Resolver.prototype, 'resolve4', async (domain) => {
    if (domain === 'assets.example.com.') {
      return ['93.184.215.14'];
    }
    assert.equal(domain, 'cdn.example.com.');
    return ['93.184.215.15'];
  });
  const first = response(302, { location: 'https://cdn.example.com/logo.png?size=small' });
  const second = response(200, { 'content-type': 'image/png' }, [png.subarray(0, 8), png.subarray(8)]);
  const get = serve(context, first, second);
  const result = await downloadPublicImage('https://assets.example.com/logo', new AbortController().signal);
  assert.deepEqual(result, png);
  assert.equal(dns.mock.callCount(), 2);
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, true);
  const [firstCall, secondCall] = get.mock.calls.map(({ arguments: [options] }) => options);
  assert.equal(firstCall.hostname, '93.184.215.14');
  assert.equal(secondCall.hostname, '93.184.215.15');
  assert.equal(secondCall.servername, 'cdn.example.com');
  assert.equal(secondCall.headers.Host, 'cdn.example.com');
  assert.equal(secondCall.path, '/logo.png?size=small');
  assert.equal(secondCall.rejectUnauthorized, true);
  assert.equal(secondCall.agent, false);
  assert.deepEqual(Object.keys(secondCall.headers).sort(), [
    'Accept',
    'Accept-Encoding',
    'Host',
    'User-Agent',
  ]);
});

test('refuses nonpublic URLs before any connection and checks every DNS answer', async (context) => {
  const dns = context.mock.method(Resolver.prototype, 'resolve4', async () => [
    '93.184.215.14',
    '192.168.1.1',
  ]);
  const get = serve(context);
  const { signal } = new AbortController();
  for (const url of [
    'http://assets.example.com/image.png',
    'https://localhost/image.png',
    'https://127.0.0.1/image.png',
    'https://[::1]/image.png',
    'https://printer.local/image.png',
    'https://assets.example.com:8443/image.png',
    'https://user:password@assets.example.com/image.png',
  ]) {
    await assert.rejects(downloadPublicImage(url, signal), /public HTTPS/);
  }
  assert.equal(dns.mock.callCount(), 0);
  await assert.rejects(
    downloadPublicImage('https://assets.example.com/image.png', signal),
    /private or reserved/,
  );
  assert.equal(dns.mock.callCount(), 1);
  assert.equal(get.mock.callCount(), 0);
});

test('rejects redirects to private DNS answers, unexpected image data, and oversized streams', async (context) => {
  context.mock.method(Resolver.prototype, 'resolve4', async (domain) => {
    if (domain === 'private.example.com.') {
      return ['169.254.169.254'];
    }
    return ['93.184.215.14'];
  });
  const oversized = response(200, { 'content-type': 'image/png' }, [Buffer.alloc(5 * 1024 * 1024), png]);
  const get = serve(
    context,
    response(302, { location: 'https://private.example.com/logo.png' }),
    response(200, { 'content-type': 'text/html' }, [Buffer.from('<html>')]),
    response(200, { 'content-type': 'image/png' }, [Buffer.from('<svg></svg>')]),
    oversized,
  );
  const { signal } = new AbortController();
  const url = 'https://assets.example.com/logo.png';
  await assert.rejects(downloadPublicImage(url, signal), /private or reserved/);
  assert.equal(get.mock.callCount(), 1);
  await assert.rejects(downloadPublicImage(url, signal), /did not return an image/);
  await assert.rejects(downloadPublicImage(url, signal), /raster image/);
  await assert.rejects(downloadPublicImage(url, signal), /5 MiB/);
  assert.equal(oversized.destroyed, true);
});

test('aborts before DNS or network work when the task has stopped', async (context) => {
  const dns = context.mock.method(Resolver.prototype, 'resolve4', async () => []);
  const get = serve(context);
  await assert.rejects(downloadPublicImage('https://assets.example.com/logo.png', AbortSignal.abort()), {
    name: 'AbortError',
  });
  assert.equal(dns.mock.callCount(), 0);
  assert.equal(get.mock.callCount(), 0);
});
