import {
  createServer,
  request as upstreamRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from 'node:http';
import path from 'node:path';
import { FrameworkRuntime } from './framework-runtime.js';
import type { Duplex } from 'node:stream';
import type { DevServer } from '../dev-server/index.js';
import type { PreviewServer } from './server.js';

const cookieName = 'miter_preview';
const policy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// The capability belongs to the outer server. The framework can use its own
// session cookies, but cannot see, overwrite or broaden the preview cookie.
function requestHeaders(request: IncomingMessage): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const key of [
    'accept',
    'accept-encoding',
    'accept-language',
    'content-type',
    'range',
    'if-none-match',
    'if-modified-since',
    'rsc',
    'next-router-state-tree',
    'next-router-prefetch',
    'next-url',
    'next-action',
    'user-agent',
  ]) {
    const value = request.headers[key];
    if (value !== undefined) {
      headers[key] = value;
    }
  }
  const cookies = request.headers.cookie?.split(/;\s*/).filter((item) => !item.startsWith(cookieName + '='));
  if (cookies?.length) {
    headers.cookie = cookies.join('; ');
  }
  return headers;
}

function privateAssetAllowed(raw: string, root: string): boolean {
  try {
    const name = decodeURIComponent(raw.split('?')[0] ?? '');
    if (!name.startsWith('/@fs/')) {
      return true;
    }
    const filename = path.resolve('/', name.slice('/@fs/'.length));
    return filename.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

function validPath(path: string): boolean {
  return /^\/(?!\/)/.test(path) && path.length <= 16384 && !/[\\#\x00-\x1f]/.test(path);
}

type FrameworkAudit = {
  freshRuntime: () => Promise<DevServer>;
  onBackendResponse: (method: string, path: string, status: number, body: string) => void;
};

// Observe bounded JSON at the real API boundary. Browser-local state and cached
// responses cannot produce evidence here. Forwarding continues for larger payloads.
function observeApi(
  upstream: IncomingMessage,
  method: string,
  path: string,
  record: FrameworkAudit['onBackendResponse'],
) {
  const status = upstream.statusCode ?? 502;
  if (status < 200 || status >= 300) {
    return;
  }
  if (status === 204) {
    upstream.once('end', () => record(method, path, status, ''));
    return;
  }
  if (
    upstream.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
    (upstream.headers['content-encoding'] && upstream.headers['content-encoding'] !== 'identity')
  ) {
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  upstream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 1024 * 1024) {
      chunks.push(chunk);
    }
  });
  upstream.once('end', () => {
    if (bytes <= 1024 * 1024) {
      record(method, path, status, Buffer.concat(chunks).toString('utf8'));
    }
  });
}

/** Own the framework child and publish it only through this task's browser capability. */
export async function serveDevPreview(
  runtime: DevServer,
  hostname: string,
  capability: string,
  restart?: (signal: AbortSignal) => Promise<DevServer>,
  audit?: FrameworkAudit,
): Promise<PreviewServer> {
  if (!/^miter-[a-f0-9]{32}\.localhost$/.test(hostname) || !/^[a-f0-9]{32}$/.test(capability)) {
    await runtime.close();
    throw new Error('Miter could not verify the local preview address.');
  }
  let owned: FrameworkRuntime;
  try {
    owned = new FrameworkRuntime(runtime, restart);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const entry = '/' + capability + '/index.html';
  const cookie = cookieName + '=' + capability;
  let authority = '';
  let origin = '';
  let lastRequest = Date.now();
  const owns = (request: IncomingMessage) =>
    request.headersDistinct.host?.length === 1 &&
    request.headers.host === authority &&
    (!request.headers.origin || request.headers.origin === origin);
  const authorized = (request: IncomingMessage) => request.headers.cookie?.split(/;\s*/).includes(cookie);
  const upgrades = new Set<Duplex>();
  const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', policy);
    response.setHeader('Cache-Control', 'no-store');
    const reject = (code: number) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Miter could not serve this preview request.');
    };
    const path = request.url ?? '';
    if (!owns(request) || !validPath(path)) {
      reject(403);
      return;
    }
    const method = request.method;
    if (path === entry && (method === 'GET' || method === 'HEAD')) {
      response.writeHead(303, {
        'Set-Cookie': cookie + '; HttpOnly; SameSite=Strict; Path=/',
        Location: '/',
      });
      response.end();
      lastRequest = Date.now();
      return;
    }
    if (
      !authorized(request) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (!['GET', 'HEAD'].includes(method ?? '') && request.headers.origin !== origin)
    ) {
      reject(403);
      return;
    }
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method ?? '')) {
      reject(405);
      return;
    }
    const target = owned.target;
    if (!target) {
      reject(503);
      return;
    }
    if (!privateAssetAllowed(path, target.sourceRoot)) {
      reject(403);
      return;
    }
    lastRequest = Date.now();
    const headers = requestHeaders(request);
    const auditApi = audit && path.startsWith('/api/');
    if (auditApi) {
      headers['accept-encoding'] = 'identity';
    }
    if (request.headers.origin) {
      headers.origin = target.origin;
    }
    const call = upstreamRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method,
        agent: false,
        headers,
      },
      (upstream) => {
        if (auditApi && method) {
          observeApi(upstream, method, path, (verb, route, status, body) => {
            if (owned.target === target) {
              audit.onBackendResponse(verb, route, status, body);
            }
          });
        }
        const headers: OutgoingHttpHeaders = {};
        for (const name of [
          'content-type',
          'content-encoding',
          'content-length',
          'content-range',
          'accept-ranges',
          'etag',
          'last-modified',
          'vary',
        ]) {
          const value = upstream.headers[name];
          if (value !== undefined) {
            headers[name] = value;
          }
        }
        const cookies = upstream.headers['set-cookie']?.filter(
          (value) => !value.toLowerCase().startsWith(cookieName + '=') && !/;\s*domain\s*=/i.test(value),
        );
        if (cookies?.length) {
          headers['set-cookie'] = cookies;
        }
        if (upstream.headers.location) {
          const location = URL.parse(upstream.headers.location, target.origin);
          if (!location || location.origin !== target.origin) {
            upstream.resume();
            reject(502);
            return;
          }
          headers.location = location.pathname + location.search + location.hash;
        }
        response.writeHead(upstream.statusCode ?? 502, headers);
        upstream.on('error', () => response.destroy());
        upstream.pipe(response);
      },
    );
    call.on('error', () => reject(502));
    response.once('close', () => call.destroy());
    request.pipe(call);
  });
  server.on('upgrade', (request, socket, head) => {
    const path = request.url ?? '';
    const target = owned.target;
    if (
      !target ||
      request.method !== 'GET' ||
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      !owns(request) ||
      !authorized(request) ||
      request.headers.origin !== origin ||
      !validPath(path)
    ) {
      socket.destroy();
      return;
    }
    const headers = requestHeaders(request);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    headers.origin = target.origin;
    for (const name of [
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-protocol',
      'sec-websocket-extensions',
    ]) {
      const value = request.headers[name];
      if (value !== undefined) {
        headers[name] = value;
      }
    }
    lastRequest = Date.now();
    upgrades.add(socket);
    const call = upstreamRequest({
      hostname: target.hostname,
      port: target.port,
      path,
      method: 'GET',
      headers,
      agent: false,
    });
    socket.once('close', () => {
      upgrades.delete(socket);
      call.destroy();
    });
    socket.on('error', () => socket.destroy());
    call.on('error', () => socket.destroy());
    call.once('response', (response) => {
      response.resume();
      socket.destroy();
    });
    call.once('upgrade', (reply, peer, extra) => {
      if (socket.destroyed) {
        peer.destroy();
        return;
      }
      const handshake = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket'];
      for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
        const value = reply.headers[name];
        if (typeof value === 'string') {
          handshake.push(name + ': ' + value);
        }
      }
      socket.write(handshake.join('\r\n') + '\r\n\r\n');
      if (head.length) {
        peer.write(head);
      }
      if (extra.length) {
        socket.write(extra);
      }
      peer.on('error', () => socket.destroy());
      peer.once('close', () => socket.destroy());
      socket.once('close', () => peer.destroy());
      socket.pipe(peer).pipe(socket);
    });
    call.end();
  });
  server.maxConnections = 64;
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Miter could not open a local preview port.');
    }
    authority = hostname + ':' + address.port;
    origin = 'http://' + authority;
  } catch (error) {
    server.close();
    await owned.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  const preview: PreviewServer = {
    url: origin + entry,
    lastRequest: () => lastRequest,
    close() {
      if (!closing) {
        closing = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
          server.closeAllConnections();
          for (const socket of upgrades) {
            socket.destroy();
          }
        }).finally(() => owned.close());
      }
      return closing;
    },
  };
  if (audit) {
    let pristine = true;
    preview.resetBackend = async () => {
      if (pristine) {
        pristine = false;
        return;
      }
      // A fresh process and store also clear module caches and open SQLite handles.
      await owned.close();
      const next = await audit.freshRuntime();
      try {
        if (closing) {
          throw new Error('Framework audit closed during reset.');
        }
        owned = new FrameworkRuntime(next);
      } catch (error) {
        await next.close();
        throw error;
      }
    };
  } else {
    preview.exited = owned.exited;
  }
  return preview;
}
