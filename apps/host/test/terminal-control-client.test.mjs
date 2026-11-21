import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createTerminalClient, TerminalControlError } from '../src/core/terminal-control/client.ts';
import { terminalControlRequestSchema } from '../../../packages/protocol/src/terminal-control.ts';

async function endpoint(context, respond) {
  const root = await fs.realpath('/tmp');
  const directory = await fs.mkdtemp(path.join(root, 'miter-client-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'control.sock');
  const descriptorPath = path.join(directory, 'terminal-control.json');
  const token = randomBytes(32).toString('hex');
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let line = '';
    socket.on('data', (bytes) => {
      line += bytes.toString('utf8');
      if (!line.endsWith('\n')) {
        return;
      }
      const request = terminalControlRequestSchema.parse(JSON.parse(line));
      requests.push(request);
      assert.equal(request.token, token);
      respond(socket, request);
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  await fs.chmod(socketPath, 0o600);
  await fs.writeFile(descriptorPath, JSON.stringify({ version: 1, pid: process.pid, socketPath, token }), {
    mode: 0o600,
  });
  context.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    descriptorPath,
    socketPath,
    token,
    requests,
    client: createTerminalClient({ dataDir: directory, timeoutMs: 500 }),
  };
}

function startParams() {
  return {
    requestId: randomUUID(),
    projectPath: '/tmp/app',
    createProject: false,
    goal: ' Build café\n',
    maxTurns: 20,
    maxMinutes: 60,
    consent: true,
  };
}

function operation(params) {
  return {
    requestId: params.requestId,
    kind: 'start',
    state: 'queued',
    workerId: 'task-1',
    expectedRun: { runId: 'run-1', epoch: 1 },
    createdAt: 1,
    updatedAt: 1,
  };
}

function reply(socket, request, result) {
  socket.end(JSON.stringify({ version: 1, id: request.id, ok: true, result }) + '\n');
}

test('real Unix socket carries one authenticated bounded request and returns its matched receipt', async (context) => {
  const fixture = await endpoint(context, (socket, request) =>
    reply(socket, request, operation(request.params)),
  );
  const params = startParams();
  const result = await fixture.client.start(params);
  assert.equal(result.requestId, params.requestId);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].params.goal, params.goal);
  assert.equal(fixture.requests[0].method, 'start');
});

test('resume uses the authenticated socket without start fields and binds its receipt to the reviewed run', async (context) => {
  const params = { requestId: randomUUID(), workerId: 'task-1', expectedRun: { runId: 'run-1', epoch: 1 } };
  const fixture = await endpoint(context, (socket, request) =>
    reply(socket, request, { ...operation(request.params), kind: 'resume' }),
  );
  assert.equal((await fixture.client.resume(params)).kind, 'resume');
  assert.deepEqual(fixture.requests[0].params, params);
  assert.equal(fixture.requests[0].method, 'resume');

  const wrongRun = await endpoint(context, (socket, request) =>
    reply(socket, request, {
      ...operation(request.params),
      kind: 'resume',
      expectedRun: { runId: 'another-run', epoch: 1 },
    }),
  );
  await assert.rejects(wrongRun.client.resume(params), (error) => error.delivery === 'unknown');
  assert.equal(wrongRun.requests.length, 1);
});

test('resume rejects budget and new-chat fields before sending any request', async (context) => {
  const fixture = await endpoint(context, () => {});
  const params = { requestId: randomUUID(), workerId: 'task-1', expectedRun: { runId: 'run-1', epoch: 1 } };
  for (const extra of [{ maxTurns: 20 }, { maxMinutes: 60 }, { newChat: true }]) {
    await assert.rejects(fixture.client.resume({ ...params, ...extra }));
  }
  assert.equal(fixture.requests.length, 0);
});

test('private connection discovery rejects readable descriptor, symlink and unsafe socket without connecting', async (context) => {
  const fixture = await endpoint(context, (socket, request) =>
    reply(socket, request, { browserConnected: true, tasks: [] }),
  );
  await fs.chmod(fixture.descriptorPath, 0o644);
  await assert.rejects(
    fixture.client.list(),
    (error) => error instanceof TerminalControlError && error.delivery === 'not-sent',
  );
  await fs.chmod(fixture.descriptorPath, 0o600);
  const actual = path.join(fixture.directory, 'real-descriptor.json');
  await fs.rename(fixture.descriptorPath, actual);
  await fs.symlink(actual, fixture.descriptorPath);
  await assert.rejects(fixture.client.list(), /unsafe or incompatible/);
  await fs.unlink(fixture.descriptorPath);
  await fs.rename(actual, fixture.descriptorPath);
  await fs.chmod(fixture.socketPath, 0o666);
  await assert.rejects(fixture.client.list(), /unsafe or incompatible/);
  assert.equal(fixture.requests.length, 0);
});

test('linked endpoint and linked data directory are refused before the token is transmitted', async (context) => {
  const fixture = await endpoint(context, () => {});
  const alias = fixture.directory + '-link';
  await fs.symlink(fixture.directory, alias);
  context.after(() => fs.unlink(alias));
  const client = createTerminalClient({ dataDir: alias });
  await assert.rejects(client.list(), /unsafe or incompatible/);
  await fs.writeFile(
    fixture.descriptorPath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      socketPath: path.join(alias, 'control.sock'),
      token: fixture.token,
    }),
  );
  await assert.rejects(fixture.client.list(), /unsafe or incompatible/);
  assert.equal(fixture.requests.length, 0);
});

test('wrong transport identifiers and wrong result shapes are uncertain, never auto-retried', async (context) => {
  const fixture = await endpoint(context, (socket, request) => {
    socket.end(
      JSON.stringify({ version: 1, id: randomUUID(), ok: true, result: operation(request.params) }) + '\n',
    );
  });
  await assert.rejects(fixture.client.start(startParams()), (error) => {
    assert.equal(error.delivery, 'unknown');
    assert.doesNotMatch(error.message, new RegExp(fixture.token));
    return true;
  });
  assert.equal(fixture.requests.length, 1);

  const wrongShape = await endpoint(context, (socket, request) =>
    reply(socket, request, { browserConnected: true, tasks: [] }),
  );
  await assert.rejects(wrongShape.client.start(startParams()), (error) => error.delivery === 'unknown');
  assert.equal(wrongShape.requests.length, 1);
});

test('a valid receipt for another mutation is rejected', async (context) => {
  const fixture = await endpoint(context, (socket, request) =>
    reply(socket, request, operation({ requestId: randomUUID() })),
  );
  await assert.rejects(fixture.client.start(startParams()), (error) => error.delivery === 'unknown');
});

test('timeouts after send and oversized replies retain uncertain delivery and do not resend', async (context) => {
  const silent = await endpoint(context, () => {});
  const client = createTerminalClient({ dataDir: silent.directory, timeoutMs: 20 });
  await assert.rejects(client.start(startParams()), (error) => error.delivery === 'unknown');
  assert.equal(silent.requests.length, 1);
  const oversized = await endpoint(context, (socket) => socket.end('x'.repeat(256 * 1024 + 1)));
  await assert.rejects(oversized.client.start(startParams()), /oversized/);
  assert.equal(oversized.requests.length, 1);
});

test('missing host and abort before sending are explicit and never create local state', async (context) => {
  const absent = '/tmp/miter-absent-' + randomUUID();
  await assert.rejects(createTerminalClient({ dataDir: absent }).list(), /Open Miter in Chrome once/);
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
  const fixture = await endpoint(context, () => {});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createTerminalClient({ dataDir: fixture.directory, signal: controller.signal }).list(),
    (error) => error.delivery === 'not-sent',
  );
  assert.equal(fixture.requests.length, 0);
});

test('host rejection is distinct from lost acknowledgement and keeps the public failure reason', async (context) => {
  const fixture = await endpoint(context, (socket, request) =>
    socket.end(
      JSON.stringify({ version: 1, id: request.id, ok: false, error: 'Open ChatGPT and sign in.' }) + '\n',
    ),
  );
  await assert.rejects(fixture.client.start(startParams()), (error) => {
    assert.equal(error.delivery, 'rejected');
    assert.equal(error.message, 'Open ChatGPT and sign in.');
    return true;
  });
});

test('preview client rejects an invalid browser URL or mismatched task/run before exposing a link', async (context) => {
  const params = { workerId: 'task-1', expectedRun: { runId: 'run-1', epoch: 0 } };
  const id = 'a'.repeat(32);
  const preview = {
    previewId: id,
    url: 'http://miter-' + id + '.localhost:8123/' + id + '/index.html',
    files: 1,
    bytes: 200,
    idleTimeoutMs: 1800000,
    detail: 'A local application preview.',
  };
  for (const override of [
    { workerId: 'other' },
    { expectedRun: { runId: 'old', epoch: 0 } },
    { preview: { ...preview, url: 'https://example.com/' } },
  ]) {
    const fixture = await endpoint(context, (socket, request) =>
      reply(socket, request, { ...params, preview, ...override }),
    );
    await assert.rejects(fixture.client.preview(params));
    assert.equal(fixture.requests.length, 1);
  }
});
