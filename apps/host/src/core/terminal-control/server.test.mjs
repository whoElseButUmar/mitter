import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { get } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fixture } from '../service/test-fixture.mjs';
import { startTerminalControl } from './server.ts';
import { createTerminalClient } from './client.ts';
import { APP_VERSION } from '../../../../../packages/protocol/src/index.ts';
import {
  TERMINAL_CONTROL_MAX_BYTES,
  terminalDescriptorSchema,
} from '../../../../../packages/protocol/src/terminal-control.ts';

async function endpoint(context) {
  const app = await fixture(context);
  const server = await startTerminalControl(app);
  const descriptorPath = path.join(app.dataDir, 'terminal-control.json');
  const descriptor = terminalDescriptorSchema.parse(JSON.parse(await fs.readFile(descriptorPath, 'utf8')));
  context.after(() => server.close());
  return {
    ...app,
    server,
    descriptor,
    descriptorPath,
    client: createTerminalClient({ dataDir: app.dataDir }),
  };
}

function exchange(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => socket.destroy(new Error('Test socket timeout.')));
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      output += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(output));
  });
}

function request(descriptor, method = 'list', params = {}) {
  return { version: 1, id: randomUUID(), token: descriptor.token, method, params };
}

test('private Unix endpoint supports the public client and cleans up on repeated close', async (context) => {
  const app = await endpoint(context);
  const descriptorInfo = await fs.lstat(app.descriptorPath);
  const socketInfo = await fs.lstat(app.descriptor.socketPath);
  const directoryInfo = await fs.lstat(path.dirname(app.descriptor.socketPath));
  assert.equal(descriptorInfo.mode & 0o777, 0o600);
  assert.equal(descriptorInfo.nlink, 1);
  assert.equal(socketInfo.mode & 0o777, 0o600);
  assert.equal(socketInfo.isSocket(), true);
  assert.equal(directoryInfo.mode & 0o777, 0o700);
  assert.equal(socketInfo.uid, process.getuid());
  assert.ok(Buffer.byteLength(app.descriptor.socketPath) < 104);
  assert.equal((await app.client.list()).tasks[0].id, app.worker.id);
  assert.equal((await app.client.status(app.worker.id)).worker.goal, app.worker.goal);
  await app.server.close();
  await app.server.close();
  await assert.rejects(fs.lstat(app.descriptorPath), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.dirname(app.descriptor.socketPath)), { code: 'ENOENT' });
});

test('long data paths do not exceed the macOS Unix socket limit', async (context) => {
  const app = await fixture(context);
  const dataDir = path.join(app.dataDir, 'long-'.repeat(30));
  await fs.mkdir(dataDir, { mode: 0o700 });
  assert.ok(Buffer.byteLength(dataDir) > 104);
  const server = await startTerminalControl({ dataDir, service: app.service });
  context.after(() => server.close());
  assert.equal((await createTerminalClient({ dataDir }).list()).tasks.length, 1);
  await server.close();
});

test('a token mismatch cannot admit a mutation', async (context) => {
  const app = await endpoint(context);
  await app.server.claim({ sessionId: randomUUID(), version: APP_VERSION, available: true });
  const message = request(app.descriptor, 'start', {
    requestId: randomUUID(),
    projectPath: app.root,
    createProject: false,
    goal: 'Build a reservations app.',
    maxTurns: 5,
    maxMinutes: 10,
    consent: true,
  });
  message.token = '0'.repeat(64);
  const response = JSON.parse(await exchange(app.descriptor.socketPath, JSON.stringify(message) + '\n'));
  assert.equal(response.ok, false);
  assert.equal(response.id, message.id);
  assert.equal(app.service.workers.size, 1);
});

test('resume crosses the authenticated socket only with its exact existing boundary and no new budget', async (context) => {
  const app = await endpoint(context);
  const session = { sessionId: randomUUID(), version: APP_VERSION, available: true };
  await app.server.claim(session);
  const original = structuredClone(app.worker);
  const params = {
    requestId: randomUUID(),
    workerId: app.worker.id,
    expectedRun: { runId: app.worker.runId, epoch: app.worker.control?.epoch ?? 0 },
  };
  const invalid = request(app.descriptor, 'resume', { ...params, maxTurns: 20 });
  assert.equal(await exchange(app.descriptor.socketPath, JSON.stringify(invalid) + '\n'), '');
  assert.equal(app.store.get('miter.terminal.operation.' + params.requestId), undefined);
  const message = request(app.descriptor, 'resume', params);
  const response = JSON.parse(await exchange(app.descriptor.socketPath, JSON.stringify(message) + '\n'));
  assert.equal(response.ok, true);
  assert.equal(response.id, message.id);
  assert.equal(response.result.kind, 'resume');
  assert.equal(response.result.state, 'queued');
  const { command } = await app.server.claim(session);
  assert.equal(command.kind, 'resume');
  assert.deepEqual(command.expectedRun, params.expectedRun);
  assert.equal('maxTurns' in command, false);
  assert.equal('maxMinutes' in command, false);
  assert.equal('consent' in command, false);
  assert.equal(app.service.workers.size, 1);
  assert.deepEqual(app.worker, original);
});

test('unknown fields, multiple frames, and oversized input are rejected before admission', async (context) => {
  const app = await endpoint(context);
  const invalid = { ...request(app.descriptor), unexpected: true };
  assert.equal(await exchange(app.descriptor.socketPath, JSON.stringify(invalid) + '\n'), '');
  const line = JSON.stringify(request(app.descriptor)) + '\n';
  assert.equal(await exchange(app.descriptor.socketPath, line + line), '');
  assert.equal(await exchange(app.descriptor.socketPath, 'x'.repeat(TERMINAL_CONTROL_MAX_BYTES + 1)), '');
  assert.equal(app.service.workers.size, 1);
});

test('another live endpoint is not replaced or killed', async (context) => {
  const app = await endpoint(context);
  const original = await fs.readFile(app.descriptorPath, 'utf8');
  await assert.rejects(startTerminalControl(app), /Another live Miter terminal endpoint/);
  assert.equal(await fs.readFile(app.descriptorPath, 'utf8'), original);
  assert.equal((await app.client.list()).tasks.length, 1);
});

test('linked and public descriptor files are rejected without deleting their targets', async (context) => {
  const app = await fixture(context);
  const descriptorPath = path.join(app.dataDir, 'terminal-control.json');
  const target = path.join(app.dataDir, 'unrelated-file');
  await fs.writeFile(target, 'keep this file', { mode: 0o600 });
  await fs.symlink(target, descriptorPath);
  await assert.rejects(startTerminalControl(app), /unsafe ownership or permissions/);
  assert.equal(await fs.readFile(target, 'utf8'), 'keep this file');
  assert.equal((await fs.lstat(descriptorPath)).isSymbolicLink(), true);
  await fs.unlink(descriptorPath);
  await fs.writeFile(descriptorPath, '{}', { mode: 0o644 });
  await assert.rejects(startTerminalControl(app), /unsafe ownership or permissions/);
  assert.equal(await fs.readFile(descriptorPath, 'utf8'), '{}');
});

test('a replaced descriptor is preserved during shutdown', async (context) => {
  const app = await endpoint(context);
  const replacement = path.join(app.dataDir, 'replacement.json');
  await fs.writeFile(replacement, 'replacement owner', { mode: 0o600 });
  await fs.rename(replacement, app.descriptorPath);
  await app.server.close();
  assert.equal(await fs.readFile(app.descriptorPath, 'utf8'), 'replacement owner');
});

test('a shared-writable data directory cannot publish a terminal endpoint', async (context) => {
  const app = await fixture(context);
  await fs.chmod(app.dataDir, 0o770);
  await assert.rejects(startTerminalControl(app), /not writable by other users/);
  await assert.rejects(fs.lstat(path.join(app.dataDir, 'terminal-control.json')), { code: 'ENOENT' });
});

test('shutdown waits for an accepted mutation even after the requesting socket disconnects', async (context) => {
  const app = await endpoint(context);
  await app.server.claim({ sessionId: randomUUID(), version: APP_VERSION, available: true });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const original = app.service.handle.bind(app.service);
  app.service.handle = async (method, params) => {
    if (method === 'worker.create') {
      entered.resolve();
      await release.promise;
    }
    return original(method, params);
  };
  const requestId = randomUUID();
  const started = app.client
    .start({
      requestId,
      projectPath: app.root,
      createProject: false,
      goal: 'Build an app.',
      maxTurns: 5,
      maxMinutes: 10,
      consent: true,
    })
    .catch(() => undefined);
  await entered.promise;
  let closed = false;
  const closing = app.server.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve();
  await closing;
  await started;
  const saved = app.store.get('miter.terminal.operation.' + requestId);
  assert.equal(saved.operation.state, 'queued');
  assert.ok(app.service.workers.has(saved.operation.workerId));
});

test('terminal preview serves a completed app from the bound host without a browser relay', async (context) => {
  const app = await endpoint(context);
  const { worker } = await app.client.status(app.worker.id);
  const params = { workerId: worker.id, expectedRun: worker.expectedRun };
  await assert.rejects(app.client.preview({ ...params, workerId: 'missing' }), /Task not found/);
  await assert.rejects(app.client.preview(params), /after this task completes/);
  app.worker.state = 'complete';
  await assert.rejects(app.client.preview(params), /No index.html/);
  await fs.writeFile(path.join(app.root, 'index.html'), '<!doctype html><title>Completed app</title>');
  await assert.rejects(
    app.client.preview({
      ...params,
      expectedRun: { ...params.expectedRun, epoch: params.expectedRun.epoch + 1 },
    }),
    /earlier task run/,
  );
  const preview = await app.client.preview(params);
  const url = new URL(preview.url);
  const body = await new Promise((resolve, reject) => {
    const call = get(
      { hostname: '127.0.0.1', port: url.port, path: url.pathname, headers: { Host: url.host } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    call.on('error', reject);
  });
  assert.equal(body, '<!doctype html><title>Completed app</title>');
  assert.deepEqual(
    await app.service.handle('worker.previewStop', { ...params, previewId: preview.previewId }),
    { stopped: true },
  );
  assert.equal((await app.client.status(worker.id)).browserConnected, false);
});
