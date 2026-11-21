import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Locks } from '../locks.js';
import { inspectReadiness } from '../quality/readiness.js';
import { execute, removeScratch, verifiedNodeSandbox } from '../quality/sandbox.js';
import type { BackendSnapshot } from './snapshot.js';

const stores = new Locks();
export const MAX_BODY_BYTES = 48 * 1024;

export type BackendOptions = {
  dataDir: string;
  ephemeral?: boolean;
  onBackendResponse?: (method: string, path: string, status: number, body: string) => void;
};

// The HTTP host never imports project code. Only this child, after the isolation
// probe passes, can load the copied handler and read or write its application data.
const adapter = `
import { pathToFileURL } from 'node:url';
const [entry, dataDir] = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { method, url, body } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const options = { method, headers: { accept: 'application/json' } };
if (!['GET', 'HEAD'].includes(method)) {
  options.headers['content-type'] = 'application/json';
  options.headers.origin = new URL(url).origin;
  options.body = body;
}
const { handle } = await import(pathToFileURL(entry).href);
const result = await handle(new Request(url, options), { dataDir });
if (!(result instanceof Response)) throw new Error('The backend must return a Response.');
const parts = [];
let size = 0;
if (result.body) {
  for await (const part of result.body) {
    size += part.byteLength;
    if (size > ${MAX_BODY_BYTES}) break;
    parts.push(part);
  }
}
let reply = { status: 502, body: Buffer.from('{"error":"Application response exceeded 48 KiB. Paginate the results."}').toString('base64') };
if (size <= ${MAX_BODY_BYTES}) reply = { status: result.status, body: Buffer.concat(parts).toString('base64') };
process.stdout.write('\\nMITER_HTTP_RESPONSE ' + JSON.stringify(reply));
`;

const replySchema = z
  .strictObject({
    status: z.number().int().min(200).max(599).describe('HTTP response status returned by the app.'),
    body: z
      .string()
      .max(Math.ceil(MAX_BODY_BYTES / 3) * 4)
      .describe('Bounded base64-encoded response bytes.'),
  })
  .describe('A bounded application response from the isolated Node process.');

export type AppBackend = {
  request(method: string, url: string, body: string): Promise<z.infer<typeof replySchema>>;
  close(): Promise<void>;
  resetBackend?: () => Promise<void>;
};

export async function openBackend(snapshot: BackendSnapshot, options: BackendOptions): Promise<AppBackend> {
  const readiness = await inspectReadiness();
  if (readiness.checks.domain.status !== 'ready') {
    throw new Error('Backend execution requires macOS sandbox-exec and Node.js 26 or newer.');
  }
  let temporaryRoot = os.tmpdir();
  if (options.ephemeral) {
    await fs.mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    temporaryRoot = options.dataDir;
  }
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, 'miter-backend-')));
  const source = path.join(scratch, 'source');
  const controller = new AbortController();
  // Ephemeral data lives inside a host-owned scratch directory. Reset can only
  // remove this store, even if a caller accidentally supplies a project directory.
  let data = path.join(scratch, 'data');
  try {
    await fs.mkdir(source, { mode: 0o700 });
    if (!options.ephemeral) {
      data = path.resolve(options.dataDir);
    }
    await fs.mkdir(data, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(data)).isDirectory()) {
      throw new Error('The backend data path must be a private directory.');
    }
    data = await fs.realpath(data);
    for (const [name, content] of snapshot.files) {
      const target = path.join(source, name);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 });
    }
    const runner = path.join(source, '.miter-request.mjs');
    await fs.writeFile(runner, adapter, { flag: 'wx', mode: 0o600 });
    const sandbox = await stores.using(data, controller.signal, () =>
      verifiedNodeSandbox(scratch, source, data, controller.signal),
    );
    const args = [...sandbox, '--', runner, path.join(source, snapshot.entry), data];
    const reset = async () => {
      await stores.using(data, controller.signal, async () => {
        await removeScratch(data);
        await fs.mkdir(data, { mode: 0o700 });
      });
    };
    const backend = {
      async request(method: string, url: string, body: string) {
        return stores.using(data, controller.signal, async () => {
          const result = await execute(
            args,
            source,
            data,
            controller.signal,
            5000,
            JSON.stringify({ method, url, body }),
            96 * 1024,
          );
          if (result.stopped || result.code !== 0) {
            throw new Error('The application backend failed to finish this request.');
          }
          const marker = '\nMITER_HTTP_RESPONSE ';
          const start = result.stdout.lastIndexOf(marker);
          if (start < 0) {
            throw new Error('The application backend did not return a response.');
          }
          const reply = replySchema.parse(JSON.parse(result.stdout.slice(start + marker.length)));
          reply.body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(reply.body, 'base64'));
          if (reply.status >= 300 && reply.status < 400) {
            throw new Error('Backend redirects are unsupported.');
          }
          if (reply.body) {
            JSON.parse(reply.body);
          }
          options.onBackendResponse?.(method, new URL(url).pathname, reply.status, reply.body);
          return reply;
        });
      },
      async close() {
        controller.abort();
        await stores.using(data, new AbortController().signal, () => removeScratch(scratch));
      },
    };
    if (options.ephemeral) {
      return { ...backend, resetBackend: reset };
    }
    return backend;
  } catch (error) {
    await removeScratch(scratch);
    throw error;
  }
}
