import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, makeWorker, importBatch, registerScript, runToBoundary } from './test-fixture.mjs';

test('worktrees share base revisions without replacing the registered root', async (context) => {
  const { service, worker, store, project, root } = await fixture(context, {
    workers: [makeWorker(), makeWorker({ id: 'worker_2', runId: 'run_2' })],
  });
  const peer = service.workers.get('worker_2');
  assert.ok(peer);
  const worktreeRoot = path.join(path.dirname(root), 'isolated');
  await fs.mkdir(worktreeRoot);
  worker.worktree = { root: worktreeRoot, branch: 'task-branch', baseCommit: 'fixture' };
  store.saveWorker(worker);
  const profile = await registerScript(
    service,
    project,
    worktreeRoot,
    "require('node:fs').appendFileSync('runs.txt', 'run\\n');",
  );
  await importBatch(service, worker, [
    { type: 'write', path: 'isolated.txt', content: 'isolated', expectedHash: 'missing' },
    { type: 'command', profileId: profile.id },
  ]);
  await runToBoundary(service, worker);
  assert.equal(project.revision, 2);
  const oldApproval = worker.pending;
  assert.ok(oldApproval);
  assert.equal(oldApproval.revision, project.revision);

  await importBatch(service, peer, [
    { type: 'write', path: 'shared.txt', content: 'shared', expectedHash: 'missing' },
  ]);
  await runToBoundary(service, peer);
  assert.equal(project.revision, 3);
  await assert.rejects(
    service.handle('worker.approve', { workerId: worker.id, token: oldApproval.token, approve: true }),
    /Workspace changed/,
  );
  await runToBoundary(service, worker);
  assert.ok(worker.pending);
  assert.equal(worker.pending.revision, 3);
  await service.handle('worker.approve', { workerId: worker.id, token: worker.pending.token, approve: true });
  await service.wait(worker.id);
  assert.equal(project.revision, 4);
  assert.equal(await fs.readFile(path.join(worktreeRoot, 'isolated.txt'), 'utf8'), 'isolated');
  assert.equal(await fs.readFile(path.join(worktreeRoot, 'runs.txt'), 'utf8'), 'run\n');
  assert.equal(await fs.readFile(path.join(root, 'shared.txt'), 'utf8'), 'shared');
  await assert.rejects(fs.access(path.join(root, 'isolated.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(worktreeRoot, 'shared.txt')), { code: 'ENOENT' });
  const savedProject = store.projects().find((saved) => saved.id === project.id);
  assert.ok(savedProject);
  assert.equal(savedProject.root, root);
  assert.equal(savedProject.revision, 4);
  assert.equal(savedProject.sourceRoot, undefined);
});

test('profile changes fence the running project; context and renames keep revisions', async (context) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const models = {
    propose: async () => {
      entered.resolve();
      await release.promise;

      return JSON.stringify({ summary: 'Finish.', actions: [{ type: 'finish', summary: 'Done.' }] });
    },
    close: () => release.resolve(),
  };
  const { service, worker, project, root } = await fixture(context, {
    workers: [makeWorker({ mode: 'local' })],
    models,
  });
  const otherRoot = path.join(path.dirname(root), 'other-project');
  await fs.mkdir(otherRoot);
  const other = await service.handle('project.add', { name: 'Other', root: otherRoot });
  service.settings.coderModelPath = '/configured/model.gguf';
  service.run(worker.id);
  await entered.promise;
  await assert.rejects(
    service.handle('project.profile', { projectId: project.id, profile: null }),
    /Pause this project/,
  );
  const profile = {
    id: 'node_script',
    label: 'Node',
    program: process.execPath,
    args: ['script.cjs'],
    timeoutMs: 5000,
  };
  await service.handle('project.profile', { projectId: other.id, profile });
  assert.equal(other.revision, 1);
  assert.equal(project.revision, 0);
  assert.deepEqual(
    await service.handle('project.context', {
      projectId: project.id,
      save: true,
      mission: 'Goal',
      conventions: 'Rules',
    }),
    { mission: 'Goal', conventions: 'Rules' },
  );
  await service.handle('project.rename', { projectId: project.id, name: '  Renamed  ' });
  assert.equal(project.name, 'Renamed');
  assert.equal(project.revision, 0);
  release.resolve();
  await service.wait(worker.id);
  assert.equal(worker.state, 'complete');
});
