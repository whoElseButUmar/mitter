# Local application previews

Choose **Run** on the completed task to start its app in the project terminal. Choose **Open app** in that session to open its web interface in Chrome. The host serves
`index.html` and its linked local styles, JavaScript, images and fonts on a private loopback
origin. A project can also declare a Node backend that serves JSON requests and saves data
across preview sessions. The browser checks use the same request handler with disposable data.

## Framework projects

For a standalone Vite or Next.js project, choose **New task** and enter “Install dependencies with pnpm, start the dev server, and open the app preview.” Miter handles this launch locally. It reads the framework from `package.json`, runs its bundled pnpm, waits for the project's HTTP listener, and opens the app in Chrome. A coding task that changes a supported framework app opens its preview after the quality checks pass.

Use a standard `vite` or `next dev` script and dependencies from the public npm registry. Miter owns the port. It runs the app in a private copy with a separate home directory. Install hooks, credentials, external backend connections and shell pipelines are outside this runtime. An existing pnpm lockfile controls dependency resolution. When a project has no pnpm lockfile, Miter keeps the resolved versions in its private cache. Your project's source and existing dependency folders stay intact.

The terminal lists the project’s managed runs alongside its shells. **Run** reselects a running task. Restart its session to pick up source changes, or stop it to release the listener. The helper attempts one recovery after an unexpected server exit. Closing Miter or leaving the preview idle for 30 minutes stops the server. Files the framework writes in its temporary copy last for that session.

A framework preview copies up to 2,000 included source and public asset files, 32 MiB per file and 128 MiB total. It includes the public discovery manifest at `public/.well-known/ard.json`. The file count excludes all other hidden paths, installed dependencies, build output, vendor and cache directories, and private configuration. Dependency installation has its own private store. The static preview limits below apply to linked static assets.

## Add a backend

Put `miter.backend.json` in the project root. List the handler and the project-local Node
modules it imports. Node built-ins are available. Each source file can contain up to 120 KB.
The host copies at most 32 files.

```json
{
  "entry": "backend.mjs",
  "files": ["ledger.cjs"]
}
```

Export a Web Request handler from the entry module. It receives the method, URL, query and
JSON body. Use the supplied `dataDir` for durable state. A read-only example follows.

```js
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function handle(request, { dataDir }) {
  if (request.method === 'GET' && new URL(request.url).pathname === '/api/loans') {
    try {
      return Response.json(JSON.parse(await readFile(join(dataDir, 'loans.json'), 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return Response.json([]);
      throw error;
    }
  }
  return Response.json({ error: 'Route not found.' }, { status: 404 });
}
```

Call `fetch('./api/loans')` from the client. Use `application/json` for POST, PUT, PATCH and
DELETE. A handler can return normal HTTP success or error statuses, a JSON body, or an empty
response. Paginate responses and cap uploads at 48 KiB per request. Writes should validate input
and atomically replace data files or use transactions. Requests are serialized per project store.
Every request starts a fresh Node process, so module variables are local to that request.

On macOS with Node 26+, Miter verifies the operating-system sandbox before loading the handler.
The child can read copied source, read and write its project data, and use Node built-ins
within the sandbox. Network, children, workers and native addons are unavailable. The process
runs with a stripped environment, a five-second deadline and bounded output. To run the same
handler outside Miter, the project can provide a Node HTTP adapter and choose its own data
directory. Public hosting, authentication and deployment belong to that adapter.

## Browser and session boundaries

Each preview gets a random localhost hostname, ephemeral port and capability path. HTML and
its linked assets are immutable for that session. Bare package imports and computed module
imports need a frontend build. The snapshot supports up to 256 browser assets, 8 MiB per
asset and 24 MiB overall. It excludes dotfiles, dependency folders, project data, configuration,
tests and server sources. Backend modules are also private when they have neutral filenames.

The HTTP listener binds to `127.0.0.1` and checks Host and Origin. The capability protects
relative API routes. Root-relative `/api/…` also works after the entry page issues a host-only
HttpOnly, SameSite=Strict cookie. Mutations require the preview’s exact origin. Browser CSP
permits same-origin fetch and blocks external subresource requests, workers, frames and form
submissions. The browser owns ordinary navigation. Browser storage belongs to each preview
origin. Server data belongs to the project under the host’s private data directory.

Opening a preview replaces the task’s previous session. The host retains four sessions and
prepares at most two at once. Sessions expire after 30 minutes without a request or when
Miter closes. Closing a session removes its copied runtime files and retains project data.
Automatic browser journeys start with a fresh backend store and discard it when finished.

Run the focused checks with:

```sh
node --import ./packages/bridge/src/runner/test-source-loader.mjs --test apps/host/src/core/preview/*.test.mjs apps/host/src/core/service/preview.test.mjs
```
