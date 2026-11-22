import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isProjectLaunchRequest } from '../../../../../packages/protocol/src/task-brief.ts';
import { fixture } from './test-fixture.mjs';
import { Service } from '../service.ts';
import { installStarter } from '../starters/install.ts';
import { viteSqliteStarter } from '../starters/vite-sqlite.ts';

test('starter creation writes exactly the shipped source, without an install, worker, or app process', async (context) => {
  const { root, service, store } = await fixture(context);
  const parentRoot = path.dirname(root);
  const input = { parentRoot, folderName: 'notes', name: 'Studio Notes', starter: 'vite-ts-sqlite' };
  const workers = store.workers();
  const created = await service.handle('project.create', input);
  const expected = viteSqliteStarter(input.name);
  assert.equal(created.starter, input.starter);
  assert.deepEqual((await fs.readdir(created.root)).sort(), [...expected.keys()].sort());
  for (const [file, content] of expected) {
    assert.equal(await fs.readFile(path.join(created.root, file), 'utf8'), content, file);
  }
  assert.deepEqual(store.workers(), workers);
  assert.equal(store.projects().find(({ id }) => id === created.id).starter, input.starter);
  assert.deepEqual(await service.handle('project.appRuns', { projectId: created.id }), { runs: [] });
  await assert.rejects(service.handle('project.create', input), /overlaps/);
  const reopened = await service.handle('project.add', { name: 'Existing', root, starter: input.starter });
  assert.equal(reopened.starter, undefined);
});

test('starter Run reuses one launch worker after duplicate clicks, lost receipts and a host restart', async (context) => {
  const { root, service, project, store } = await fixture(context);
  await assert.rejects(service.handle('project.starterTask', { projectId: project.id }), /without a starter/);
  const created = await service.handle('project.create', {
    parentRoot: path.dirname(root),
    folderName: 'desk',
    name: 'Desk',
    starter: 'vite-ts-sqlite',
  });
  const params = { projectId: created.id };
  const failedSave = context.mock.method(store, 'saveWorker', () => {
    throw Error('disk full');
  });
  await assert.rejects(service.handle('project.starterTask', params), /disk full/);
  failedSave.mock.restore();
  const [first, second] = await Promise.all([1, 2].map(() => service.handle('project.starterTask', params)));
  assert.equal(first.id, second.id);
  assert.equal(first.projectId, created.id);
  assert.equal(first.mode, 'local');
  assert.equal(isProjectLaunchRequest(first.goal), true);
  assert.equal(first.worktree, undefined);
  assert.equal(first.state, 'idle');
  assert.equal(store.workers().filter(({ projectId }) => projectId === created.id).length, 1);
  const restarted = new Service(store, service.dataDir, service.factory, service.models);
  try {
    assert.equal((await restarted.handle('project.starterTask', params)).id, first.id);
  } finally {
    await restarted.quiesce();
  }
});

test('install refuses a directory replacement, planted symlink or invalid template path without changing other files', async (context) => {
  const { root } = await fixture(context);
  const target = path.join(path.dirname(root), 'new');
  const old = target + '-original';
  await fs.mkdir(target);
  const owned = await fs.lstat(target, { bigint: true });
  await fs.rename(target, old);
  await fs.symlink(root, target, 'dir');
  const files = new Map([['package.json', '{}\n']]);
  await assert.rejects(installStarter(target, owned, files), /could not be written/);
  assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(installStarter(old, owned, new Map([['../escaped', 'no']])), /invalid filename/);
  const keep = path.join(root, 'important');
  await fs.writeFile(keep, 'unchanged');
  await fs.symlink(keep, path.join(old, 'package.json'));
  await assert.rejects(installStarter(old, owned, files), /could not be written/);
  assert.equal(await fs.readFile(keep, 'utf8'), 'unchanged');
});

test('Open existing cannot register a partially written starter while another view is creating it', async (context) => {
  const { service, root, store } = await fixture(context);
  const parentRoot = path.dirname(root);
  const input = { parentRoot, folderName: 'new-app', name: 'New app', starter: 'vite-ts-sqlite' };
  const creatingRoot = path.join(parentRoot, input.folderName);
  const inspect = fs.lstat;
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let hold = true;
  context.mock.method(fs, 'lstat', async (file, ...options) => {
    if (file === creatingRoot && hold) {
      hold = false;
      started.resolve();
      await resume.promise;
    }
    return inspect(file, ...options);
  });
  const creating = service.handle('project.create', input);
  try {
    await started.promise;
    await assert.rejects(
      service.handle('project.add', { root: creatingRoot, name: 'Too early' }),
      /creating/,
    );
    assert.equal(store.projects().length, 1);
  } finally {
    resume.resolve();
    await creating;
  }
  assert.equal(store.projects().length, 2);
  assert.equal(store.projects().find(({ root }) => root === creatingRoot).starter, input.starter);
});
