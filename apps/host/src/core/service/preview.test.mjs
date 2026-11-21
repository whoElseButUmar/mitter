import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, makeWorker } from './test-fixture.mjs';
import { RequestQueue } from '../request-queue.ts';
import {
  appRunListResultSchema,
  previewStartResultSchema,
} from '../../../../../packages/protocol/src/rpc.ts';

function read(url, { method = 'GET', body } = {}) {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: address.pathname + address.search,
        method,
        headers: { Host: address.host, Origin: address.origin, 'Content-Type': 'application/json' },
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    call.on('error', reject);
    call.end(body);
  });
}

async function status(url) {
  return (await read(url)).status;
}

test('preview requests bind to the task run and late cleanup closes only the captured session', async (context) => {
  const { service, root, worker } = await fixture(context);
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><h1>Preview</h1>');
  const expectedRun = { runId: worker.runId, epoch: 0 };
  await assert.rejects(
    service.handle('worker.previewStart', {
      workerId: worker.id,
      expectedRun: { runId: 'stale_run', epoch: 0 },
    }),
  );
  const first = await service.handle('worker.previewStart', { workerId: worker.id, expectedRun });
  assert.deepEqual(previewStartResultSchema.parse(first), first);
  assert.equal(await status(first.url), 200);
  worker.runId = 'new_run';
  assert.deepEqual(
    await service.handle('worker.previewStop', {
      workerId: worker.id,
      expectedRun,
      previewId: first.previewId,
    }),
    { stopped: true },
  );
  await assert.rejects(status(first.url));
});

test('reset and shutdown quiescence stop preview listeners before state may be removed', async (context) => {
  const { service, root, worker } = await fixture(context);
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><h1>Preview</h1>');
  const opened = await service.handle('worker.previewStart', { workerId: worker.id });
  assert.equal(await status(opened.url), 200);
  await service.quiesce();
  await assert.rejects(status(opened.url));
  await assert.rejects(service.handle('worker.previewStart', { workerId: worker.id }), /shutting down/);
  await service.quiesce();
});

test('Run attaches to a completed app, preserves a working app on failed restart, and targets only the selected session', async (context) => {
  const { service, root, project, worker } = await fixture(context, {
    workers: [makeWorker({ state: 'complete' })],
    beforeOpen(store) {
      store.saveProject({ id: 'other_project', name: 'Other', root: '/other', profiles: [], revision: 0 });
    },
  });
  const index = path.join(root, 'index.html');
  const writeApp = () => fs.writeFile(index, '<!doctype html><h1>My app</h1>');
  await writeApp();
  const input = { workerId: worker.id, expectedRun: { runId: worker.runId, epoch: 0 }, mode: 'run' };
  const list = async () =>
    appRunListResultSchema.parse(await service.handle('project.appRuns', { projectId: project.id })).runs;
  const first = service.handle('worker.previewStart', input);
  const repeated = service.handle('worker.previewStart', input);
  const [starting] = await list();
  assert.equal(starting.state, 'starting');
  const [app, same] = await Promise.all([first, repeated]);
  assert.deepEqual(app, same);
  assert.equal(starting.previewId, app.previewId);
  assert.deepEqual(await service.handle('worker.previewStart', input), app);
  assert.equal(await status(app.url), 200);
  let rows = await list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'running');
  assert.equal(rows[0].url, app.url);
  assert.match(rows[0].output, /GET \/index\.html 200/);
  assert.ok(!rows[0].output.includes(app.previewId));
  assert.deepEqual(await service.handle('project.appRuns', { projectId: 'other_project' }), { runs: [] });
  const restart = { ...input, mode: 'restart', replacePreviewId: app.previewId };
  await fs.unlink(index);
  await assert.rejects(service.handle('worker.previewStart', restart));
  rows = await list();
  assert.deepEqual(
    rows.map((row) => row.state),
    ['failed', 'running'],
  );
  assert.equal(rows[0].url, undefined);
  assert.match(rows[0].output, /index\.html/i);
  assert.equal(await status(app.url), 200);
  await writeApp();
  const next = await service.handle('worker.previewStart', restart);
  assert.notEqual(next.previewId, app.previewId);
  await assert.rejects(service.handle('worker.previewStart', restart), /replaced/);
  assert.deepEqual(
    await service.handle('worker.previewStop', {
      workerId: worker.id,
      expectedRun: input.expectedRun,
      previewId: app.previewId,
    }),
    { stopped: false },
  );
  assert.equal(await status(next.url), 200);
  await assert.rejects(status(app.url));
  assert.deepEqual(
    (await list()).map((row) => row.state),
    ['running', 'failed', 'stopped'],
  );
});

test(
  'the native request queue can read and cancel a starting app before its workspace lock releases',
  { timeout: 5000 },
  async (context) => {
    const { service, root, worker } = await fixture(context, {
      workers: [makeWorker({ state: 'complete' })],
    });
    const gate = Promise.withResolvers();
    const held = service.locks.using(root, new AbortController().signal, () => gate.promise);
    const queue = new RequestQueue(assert.fail);
    const submit = (method, input) =>
      new Promise((resolve, reject) => {
        const accepted = queue.submit(method, async () => {
          try {
            resolve(await service.handle(method, input));
          } catch (error) {
            reject(error);
          }
        });
        assert.equal(accepted, true);
      });
    try {
      const expectedRun = { runId: worker.runId, epoch: 0 };
      const pending = assert.rejects(
        submit('worker.previewStart', { workerId: worker.id, expectedRun, mode: 'run' }),
        /startup stopped/,
      );
      const {
        runs: [opening],
      } = await submit('project.appRuns', { projectId: worker.projectId });
      assert.equal(opening.state, 'starting');
      assert.equal(opening.url, undefined);
      assert.deepEqual(
        await submit('worker.previewStop', {
          workerId: worker.id,
          expectedRun,
          previewId: opening.previewId,
        }),
        { stopped: true },
      );
      await pending;
      await queue.whenIdle(1000);
      const {
        runs: [stopped],
      } = await submit('project.appRuns', { projectId: worker.projectId });
      assert.equal(stopped.state, 'stopped');
      assert.match(stopped.output, /startup stopped/i);
    } finally {
      gate.resolve();
      await held;
    }
  },
);

test('Run enforces the task boundary, completion, and outstanding approvals', async (context) => {
  const { service, worker } = await fixture(context);
  const input = { workerId: worker.id, expectedRun: { runId: worker.runId, epoch: 0 }, mode: 'run' };
  await assert.rejects(service.handle('worker.previewStart', input), /complete/i);
  worker.state = 'complete';
  await assert.rejects(
    service.handle('worker.previewStart', { ...input, expectedRun: { runId: 'different_run', epoch: 0 } }),
  );
  worker.pending = {};
  await assert.rejects(service.handle('worker.previewStart', input), /approvals/);
  assert.deepEqual(await service.handle('project.appRuns', { projectId: worker.projectId }), { runs: [] });
});

test(
  'normal workspace previews retain project data when a new task run opens a fresh URL',
  { skip: process.platform !== 'darwin' },
  async (context) => {
    const { service, root, worker } = await fixture(context);
    await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><h1>Records</h1>');
    await fs.writeFile(path.join(root, 'miter.backend.json'), '{"entry":"backend.mjs"}');
    await fs.writeFile(
      path.join(root, 'backend.mjs'),
      `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    export async function handle(request, {dataDir}) {
      const file = path.join(dataDir, 'record.json');
      if (request.method === 'POST') {
        await fs.writeFile(file, await request.text());
        return new Response(null, {status: 204});
      }
      return Response.json(JSON.parse(await fs.readFile(file,'utf8')));
    }`,
    );
    const first = await service.handle('worker.previewStart', { workerId: worker.id });
    const saved = await read(new URL('./api/record', first.url), {
      method: 'POST',
      body: '{"tool":"hand saw"}',
    });
    assert.equal(saved.status, 204);
    worker.runId = 'new_project_run';
    const next = await service.handle('worker.previewStart', { workerId: worker.id });
    assert.notEqual(next.url, first.url);
    assert.deepEqual(await read(new URL('./api/record', next.url)), {
      status: 200,
      body: '{"tool":"hand saw"}',
    });
    const {
      runs: [running, replaced],
    } = await service.handle('project.appRuns', { projectId: worker.projectId });
    assert.equal(running.url, next.url);
    assert.match(running.output, /Starting the project’s Node backend/);
    assert.match(running.output, /GET \/api 200/);
    assert.match(replaced.output, /POST \/api 204/);
    for (const row of [running, replaced]) {
      assert.ok(!row.output.includes(row.previewId));
      assert.doesNotMatch(row.output, /hand saw|api\/record/);
    }
  },
);

test('launching an unsupported project reports the project error once without asking for a model', async (context) => {
  const { service, worker } = await fixture(context);
  worker.mode = 'local';
  worker.goal = 'Start the dev server and open the app preview.';
  await service.handle('worker.run', { workerId: worker.id, expectedRun: { runId: worker.runId, epoch: 0 } });
  await service.wait(worker.id);
  assert.equal(worker.state, 'blocked');
  assert.match(worker.error, /package\.json|Vite|Next/i);
  assert.equal(worker.iteration, 1);
  assert.equal(worker.completion, undefined);
});

test('a launch-only goal starts the existing framework without claiming an app audit', async (context) => {
  const { service, root, worker } = await fixture(context);
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '8.0.0' } }),
  );
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Day Pass Desk</h1>');
  const launch = context.mock.method(
    service.previews,
    'start',
    async (id, boundary, folder, assertCurrent) => {
      assertCurrent();
      assert.equal(id, worker.id);
      assert.equal(boundary.runId, worker.runId);
      assert.equal(folder, root);
      return { framework: 'vite' };
    },
  );
  worker.mode = 'local';
  worker.goal = 'Start the dev server and open the app preview.';
  await service.handle('worker.run', { workerId: worker.id, expectedRun: { runId: worker.runId, epoch: 0 } });
  await service.wait(worker.id);
  assert.equal(worker.state, 'complete', worker.error);
  assert.equal(launch.mock.callCount(), 1);
  assert.equal(worker.completion.evidence.devServer, 'vite');
  for (const category of ['source', 'domain', 'browser', 'lighthouse']) {
    assert.equal(worker.completion.evidence[category], 'not-run', category);
  }
});
