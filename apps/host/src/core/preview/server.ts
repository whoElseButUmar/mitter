import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { MAX_BODY_BYTES, openBackend, type AppBackend, type BackendOptions } from './backend.js';
import type { PreviewSnapshot } from './snapshot.js';
import { publicAssetPath } from './snapshot.js';

// Each app runs in its own top-level loopback origin. Keep its opener, frames
// and network access isolated while allowing modules and origin-bound storage.
const policy = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export type PreviewServer = {
  url: string;
  lastRequest: () => number;
  close: () => Promise<void>;
  exited?: Promise<void>;
  resetBackend?: () => Promise<void>;
};

function requestPath(request: IncomingMessage, capability: string): string | undefined {
  const raw = request.url;
  const prefix = '/' + capability + '/';
  if (!raw || raw.length > 4096 || !raw.startsWith(prefix) || /[\\#\x00-\x1f]/.test(raw)) {
    return undefined;
  }
  const relative = raw.slice(prefix.length).split('?')[0];
  if (!relative) {
    return 'index.html';
  }
  if (/%(?:2f|5c)/i.test(relative)) {
    return undefined;
  }
  try {
    return publicAssetPath(decodeURIComponent(relative));
  } catch {
    return undefined;
  }
}

function headers(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', policy);
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Origin-Agent-Cluster', '?1');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
  );
}

function backendPath(request: IncomingMessage, capability: string): string | undefined {
  const raw = request.url ?? '';
  if (raw.length > 4096 || /[\\#\x00-\x1f]/.test(raw)) {
    return undefined;
  }
  let path = raw;
  if (raw.startsWith('/' + capability + '/api/')) {
    path = raw.slice(capability.length + 1);
  } else if (!(
    raw.startsWith('/api/') && request.headers.cookie?.split(/;\s*/).includes('miter_preview=' + capability)
  )) {
    return undefined;
  }
  const pathname = path.split('?')[0] ?? '';
  try {
    if (
      /%(?:2f|5c)/i.test(pathname) ||
      decodeURIComponent(pathname)
        .split('/')
        .slice(2)
        .some((part) => !part || part === '.' || part === '..' || /[\\?#\x00-\x1f]/.test(part))
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return path;
}

async function serveBackend(
  request: IncomingMessage,
  response: ServerResponse,
  backend: AppBackend,
  origin: string,
  path: string,
  reject: (code: number) => void,
) {
  const method = request.method ?? '';
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    response.setHeader('Allow', 'GET, HEAD, POST, PUT, PATCH, DELETE');
    reject(405);
    return;
  }
  let body = '';
  if (method === 'GET' || method === 'HEAD') {
    if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) {
      reject(400);
      return;
    }
  } else {
    if (request.headers.origin !== origin) {
      reject(403);
      return;
    }
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      reject(415);
      return;
    }
    if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      reject(413);
      return;
    }
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const part = Buffer.from(chunk);
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        reject(413);
        return;
      }
      parts.push(part);
    }
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
      if (body || method !== 'DELETE') {
        JSON.parse(body);
      }
    } catch {
      reject(400);
      return;
    }
  }
  const result = await backend.request(method, origin + path, body);
  response.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
  if (method === 'HEAD') {
    response.end();
  } else {
    response.end(result.body);
  }
}

export async function serveSnapshot(
  snapshot: PreviewSnapshot,
  hostname: string,
  capability: string,
  options?: BackendOptions,
  onRequest?: (method: string, resource: string, status: number) => void,
): Promise<PreviewServer> {
  let backend: AppBackend | undefined;
  if (snapshot.backend) {
    if (!options) {
      throw new Error('The declared backend needs an application data directory.');
    }
    backend = await openBackend(snapshot.backend, options);
  }
  let authority = '';
  let origin = '';
  let lastRequest = Date.now();
  let unavailable = false;
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    headers(response);
    const reject = (code: number) => {
      response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      if (request.headers['sec-fetch-dest'] === 'document') {
        response.end(
          'This preview address is unavailable. In Miter, choose Run on the task, then Open app in its terminal session.',
        );
      } else {
        response.end('Preview request unavailable.');
      }
    };
    if (unavailable) {
      reject(503);
      return;
    }
    const hosts = request.headersDistinct.host;
    if (
      hosts?.length !== 1 ||
      hosts[0] !== authority ||
      (request.headers.origin !== undefined && request.headers.origin !== origin)
    ) {
      reject(403);
      return;
    }
    if (
      request.headers['sec-fetch-site'] === 'cross-site' &&
      request.headers['sec-fetch-dest'] !== 'document'
    ) {
      reject(403);
      return;
    }
    const api = backendPath(request, capability);
    if (backend && api) {
      if (request.headers['sec-fetch-site'] === 'cross-site') {
        reject(403);
        return;
      }
      lastRequest = Date.now();
      if (onRequest) {
        response.once('finish', () => onRequest(request.method ?? 'GET', '/api', response.statusCode));
      }
      void serveBackend(request, response, backend, origin, api, reject).catch(() => reject(500));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      reject(405);
      return;
    }
    if (
      request.headers['transfer-encoding'] !== undefined ||
      (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
    ) {
      reject(403);
      return;
    }
    // Chrome may request its default icon even when the app has no favicon.
    // Nothing from the project is served outside the capability path.
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (snapshot.entry && snapshot.entry !== 'index.html' && request.url === '/' + capability + '/') {
      const entryPath = snapshot.entry.split('/').map(encodeURIComponent).join('/');
      response.writeHead(302, { Location: '/' + capability + '/' + entryPath });
      response.end();
      return;
    }
    const relative = requestPath(request, capability);
    const asset = relative && snapshot.assets.get(relative);
    if (!asset) {
      reject(404);
      return;
    }
    lastRequest = Date.now();
    if (onRequest) {
      response.once('finish', () => onRequest(request.method ?? 'GET', '/' + relative, response.statusCode));
    }
    if (backend && asset.mime.startsWith('text/html')) {
      response.setHeader(
        'Set-Cookie',
        'miter_preview=' + capability + '; HttpOnly; SameSite=Strict; Path=/api/',
      );
    }
    response.writeHead(200, { 'Content-Type': asset.mime, 'Content-Length': asset.bytes.length });
    if (request.method === 'HEAD') {
      response.end();
    } else {
      response.end(asset.bytes);
    }
  });
  server.maxConnections = 32;
  server.maxHeadersCount = 50;
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.setTimeout(10_000, (socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('error', () => {
    unavailable = true;
    server.closeAllConnections();
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      server.off('listening', listening);
      reject(error);
    };
    const listening = () => {
      server.off('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', listening);
    server.listen(0, '127.0.0.1');
  }).catch(async (error) => {
    await backend?.close();
    throw error;
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    await backend?.close();
    throw new Error('The static preview did not bind a loopback TCP port.');
  }
  authority = hostname + ':' + address.port;
  origin = 'http://' + authority;
  let closing: Promise<void> | undefined;
  let launchFile = 'index.html';
  if (snapshot.entry && snapshot.entry !== 'index.html') {
    launchFile = '';
  }
  const preview: PreviewServer = {
    url: origin + '/' + capability + '/' + launchFile,
    lastRequest: () => lastRequest,
    exited: new Promise<void>((resolve) => {
      server.once('error', () => resolve());
      server.once('close', () => resolve());
    }),
    close() {
      if (!closing) {
        closing = new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
          server.closeAllConnections();
        }).finally(() => backend?.close());
      }
      return closing;
    },
  };
  if (backend?.resetBackend) {
    preview.resetBackend = backend.resetBackend;
  }
  return preview;
}
