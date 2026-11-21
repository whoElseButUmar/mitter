import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { quarantinedCompiler } from './compiler-bindings.js';
import { launchProcess, waitForPage } from './process.js';

test(
  'app terminal receives real stdout and stderr with credentials masked across pipe writes',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'miter-output-')));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const filename = path.join(cwd, 'output.mjs');
    await writeFile(
      filename,
      [
        "process.stdout.write('pass');",
        'await new Promise(resolve => setTimeout(resolve, 15));',
        "process.stdout.write('word=hunter-fixture\\n');",
        "process.stderr.write('Compiled 2 modules\\n');",
      ].join('\n'),
    );
    let output = '';
    const handle = launchProcess({
      cwd,
      scratch: cwd,
      signal: new AbortController().signal,
      executable: await realpath(process.execPath),
      args: [filename],
      onOutput: (text) => {
        output += text;
      },
    });
    t.after(() => handle.close());
    assert.equal(await handle.finished, 0, handle.detail());
    assert.match(output, /Compiled 2 modules/);
    assert.match(output, /password=\[REDACTED\]/);
    assert.ok(!output.includes('hunter-fixture'));
  },
);

test(
  'readiness waits for a listener owned by this launch; a different local server receives no requests',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'miter-dev-process-')));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const cwd = path.join(scratch, 'app');
    await mkdir(cwd);
    let requests = 0;
    const other = createServer((_req, res) => {
      requests++;
      res.end('different application');
    });
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => other.close(resolve)));
    const port = other.address().port;
    const filename = path.join(cwd, 'idle.mjs');
    await writeFile(filename, 'setTimeout(()=>process.exit(0),400);');
    const processHandle = launchProcess({
      cwd,
      scratch,
      executable: await realpath(process.execPath),
      args: [filename],
      port,
      signal: controller.signal,
    });
    t.after(() => processHandle.close());
    await assert.rejects(
      waitForPage('http://127.0.0.1:' + port + '/', processHandle, controller.signal),
      /exited/,
    );
    assert.equal(requests, 0);
  },
);

test(
  'sandboxed framework process can serve the assigned port and cancellation closes it',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'miter-dev-owner-')));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const cwd = path.join(scratch, 'app');
    await mkdir(cwd);
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'miter-dev-external-')));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const sentinel = path.join(outside, 'outside.txt');
    await writeFile(sentinel, 'private test fixture');
    const filename = path.join(cwd, 'server.mjs');
    await writeFile(
      filename,
      `
    import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
    import { readFile } from 'node:fs/promises';
    let isolated=false;
    try {await readFile(process.argv[3]);}catch(error){isolated=['EPERM','EACCES'].includes(error.code);}
    if(!isolated) throw Error('Unexpected access to unrelated source');
    createServer((_req,res)=>res.end('ready')).listen(Number(process.argv[2]),'127.0.0.1');
  `,
    );
    const controller = new AbortController();
    const server = launchProcess({
      cwd,
      scratch,
      executable: await realpath(process.execPath),
      args: [filename, String(port), sentinel],
      port,
      signal: controller.signal,
    });
    t.after(() => server.close());
    const url = 'http://127.0.0.1:' + port + '/';
    await waitForPage(url, server, controller.signal);
    assert.equal(await (await fetch(url)).text(), 'ready');
    controller.abort();
    await server.finished;
    await assert.rejects(fetch(url), /fetch failed/);
  },
);

test(
  'portable runtime detects and preserves macOS quarantine and skips native addons in framework workers',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'miter-dev-portable-')));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const cwd = path.join(scratch, 'app');
    await mkdir(cwd);
    const signal = new AbortController().signal;
    const fixture = path.join(cwd, 'quarantine-fixture.node');
    await writeFile(fixture, 'ordinary text, never loaded');
    assert.equal(await quarantinedCompiler(fixture, 'fixture', signal), false);
    const xattr = promisify(execFile);
    const marker = '0081;01010101;MiterTest;';
    await xattr('/usr/bin/xattr', ['-w', 'com.apple.quarantine', marker, fixture]);
    assert.equal(await quarantinedCompiler(fixture, 'fixture', signal), true);
    assert.equal(
      (await xattr('/usr/bin/xattr', ['-p', 'com.apple.quarantine', fixture])).stdout.trim(),
      marker,
    );
    const entry = path.join(cwd, 'worker.cjs');
    await writeFile(
      entry,
      [
        'const assert = require("node:assert/strict");',
        'assert.equal(process.env.NAPI_RS_FORCE_WASI, "error");',
        'assert.throws(() => require("./quarantine-fixture.node"), {code: "ERR_DLOPEN_DISABLED"});',
      ].join('\n'),
    );
    const parent = path.join(cwd, 'parent.cjs');
    await writeFile(
      parent,
      'require("node:child_process").execFileSync(process.execPath, [process.argv[2]], {stdio:"inherit"});',
    );
    const handle = launchProcess({
      cwd,
      scratch,
      signal,
      executable: await realpath(process.execPath),
      args: [parent, entry],
      portable: true,
      forceWasi: true,
    });
    t.after(() => handle.close());
    assert.equal(await handle.finished, 0, handle.detail());
  },
);
