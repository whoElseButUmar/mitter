// Copied as an ES module into a generated Vite project with a Node backend.
export const VITE_API_JS = `import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function apiMiddleware(handle) {
  const projectKey = createHash('sha256').update(process.cwd()).digest('hex');
  const dataDir = resolve(process.env.MITER_DATA_DIR || process.env.APP_DATA_DIR ||
    join(homedir(), '.local', 'share', 'vite-apps', projectKey));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  return async function serveApi(req, res, next) {
    const path = req.url || '/';
    if (path !== '/api' && !path.startsWith('/api/')) return next();
    function reject(status, message) {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: message }));
    }
    try {
      const method = req.method || 'GET';
      const origin = new URL((req.socket.encrypted ? 'https://' : 'http://') + req.headers.host).origin;
      const headers = new Headers();
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        headers.append(req.rawHeaders[index], req.rawHeaders[index + 1]);
      }
      let body;
      if (method !== 'GET' && method !== 'HEAD') {
        if (headers.get('origin') !== origin) return reject(403, 'Request origin does not match.');
        if (headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return reject(415, 'Send application/json.');
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          length += chunk.length;
          if (length > 48 * 1024) {
            req.resume();
            return reject(413, 'Request body is too large.');
          }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
      const result = await handle(new Request(new URL(path, origin), { method, headers, body }), { dataDir });
      const responseHeaders = Object.fromEntries(result.headers);
      res.writeHead(result.status, { 'cache-control': 'no-store', ...responseHeaders });
      res.end(method === 'HEAD' ? undefined : Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      console.error('API request failed', error);
      if (!res.headersSent) reject(500, 'Could not complete this request.');
      else res.end();
    }
  };
}

export function viteApi(handle, isPage = () => false) {
  function mount(server) {
    server.middlewares.use(apiMiddleware(handle));
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if ((req.method === 'GET' || req.method === 'HEAD') && isPage(url.pathname)) {
        req.url = '/index.html' + url.search;
      }
      next();
    });
  }
  return {
    name: 'app-api',
    config: () => ({ appType: 'mpa' }),
    configureServer: mount,
    configurePreviewServer: mount
  };
}
`;
