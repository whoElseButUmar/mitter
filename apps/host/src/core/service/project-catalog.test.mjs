import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './test-fixture.mjs';
import { pickFolder, pickModelFile } from '../desktop.ts';

test('opening the exact registered folder reuses its identity, settings and revision without a save', async (context) => {
  const owned = await fixture(context);
  owned.project.mission = 'Keep this mission';
  owned.project.revision = 9;
  const save = context.mock.method(owned.store, 'saveProject', () => assert.fail('Reopening must not save.'));
  const alias = path.join(path.dirname(owned.root), 'alias');
  await fs.symlink(owned.root, alias, 'dir');
  for (const root of [owned.root, owned.root + path.sep, alias]) {
    const reopened = await owned.service.handle('project.add', { root, name: 'Do not rename it' });
    assert.equal(reopened, owned.project);
    assert.equal(reopened.name, 'Project');
    assert.equal(reopened.mission, 'Keep this mission');
    assert.equal(reopened.revision, 9);
  }
  assert.equal(save.mock.callCount(), 0);
  assert.equal(owned.service.projects.size, 1);
});

test('reopening works at the project limit while new and nested registration still fail', async (context) => {
  const owned = await fixture(context);
  for (let index = 1; index < 50; index++) {
    owned.service.projects.set('saved_' + index, {
      ...owned.project,
      id: 'saved_' + index,
      root: path.join(path.dirname(owned.root), 'saved-' + index),
    });
  }
  assert.equal(
    (await owned.service.handle('project.add', { root: owned.root, name: 'Existing' })).id,
    owned.project.id,
  );
  const newRoot = path.join(path.dirname(owned.root), 'new-root');
  await fs.mkdir(newRoot);
  await assert.rejects(owned.service.handle('project.add', { root: newRoot, name: 'New' }), /at most 50/);
  await assert.rejects(
    owned.service.handle('project.add', { root: path.dirname(owned.root), name: 'Parent' }),
    /contains|data directory/,
  );
  const nested = path.join(owned.root, 'nested');
  await fs.mkdir(nested);
  await assert.rejects(
    owned.service.handle('project.add', { root: nested, name: 'Nested' }),
    /inside or contains/,
  );
});

test('a failed durable project save never inserts a ghost project into the live catalog', async (context) => {
  const owned = await fixture(context);
  const root = path.join(path.dirname(owned.root), 'unsaved');
  await fs.mkdir(root);
  context.mock.method(owned.store, 'saveProject', () => {
    throw new Error('Database unavailable');
  });
  await assert.rejects(
    owned.service.handle('project.add', { root, name: 'Unsaved' }),
    /Database unavailable/,
  );
  assert.equal(owned.service.projects.size, 1);
  assert.equal(owned.store.projects().length, 1);
});

test('Create project makes one empty child and registers it once; explicit reopen recovers its identity', async (context) => {
  const owned = await fixture(context);
  const parentRoot = path.dirname(owned.root);
  const request = { parentRoot, folderName: 'Café 工作 😀', name: 'My project' };
  const created = await owned.service.handle('project.create', request);
  assert.equal(created.root, path.join(parentRoot, request.folderName));
  assert.equal(created.name, request.name);
  assert.deepEqual(await fs.readdir(created.root), []);
  assert.equal(owned.service.projects.size, 2);
  assert.equal(owned.store.projects().length, 2);
  await assert.rejects(owned.service.handle('project.create', request), /overlaps the saved project/);
  assert.equal(
    (await owned.service.handle('project.add', { root: created.root, name: 'Ignored' })).id,
    created.id,
  );
  assert.equal(owned.service.projects.size, 2);
});

test('new project registration failure leaves its folder intact for explicit recovery, never deletes or retries', async (context) => {
  const owned = await fixture(context);
  const parentRoot = path.dirname(owned.root);
  const save = context.mock.method(owned.store, 'saveProject', () => {
    throw new Error('Disk full');
  });
  await assert.rejects(
    owned.service.handle('project.create', { parentRoot, folderName: 'recover', name: 'Recover' }),
    /registration could not be confirmed.*Open existing/,
  );
  assert.deepEqual(await fs.readdir(path.join(parentRoot, 'recover')), []);
  assert.equal(owned.service.projects.size, 1);
  assert.equal(save.mock.callCount(), 1);
  context.mock.restoreAll();
  const recovered = await owned.service.handle('project.add', {
    root: path.join(parentRoot, 'recover'),
    name: 'Recovered',
  });
  assert.equal(recovered.name, 'Recovered');
  assert.equal(owned.service.projects.size, 2);
});

test('Create project rejects existing folders, files and symlinks without changing their contents', async (context) => {
  const owned = await fixture(context);
  const parentRoot = path.dirname(owned.root);
  const existing = path.join(parentRoot, 'existing');
  await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, 'keep.txt'), 'Exact data');
  await fs.writeFile(path.join(parentRoot, 'file'), 'Exact file');
  await fs.symlink(existing, path.join(parentRoot, 'linked'), 'dir');
  for (const folderName of ['existing', 'file', 'linked']) {
    await assert.rejects(
      owned.service.handle('project.create', { parentRoot, folderName, name: 'Keep' }),
      /already exists/,
    );
  }
  assert.equal(await fs.readFile(path.join(existing, 'keep.txt'), 'utf8'), 'Exact data');
  assert.equal(await fs.readFile(path.join(parentRoot, 'file'), 'utf8'), 'Exact file');
  assert.equal((await fs.lstat(path.join(parentRoot, 'linked'))).isSymbolicLink(), true);
  assert.equal(owned.service.projects.size, 1);
});

test('Create project rejects traversal, hidden/reserved names, malformed fields and protected locations before mkdir', async (context) => {
  const owned = await fixture(context);
  const mkdir = context.mock.method(fs, 'mkdir', () =>
    assert.fail('Rejected creation must not create any directory.'),
  );
  const request = { parentRoot: path.dirname(owned.root), folderName: 'Valid', name: 'Project' };
  for (const folderName of [
    '../escape',
    'nested/child',
    'nested\\child',
    '.',
    '..',
    '.git',
    'CON',
    'NUL.txt',
    'name.',
    ' name',
    'name ',
    'a\0b',
    '\ud800',
  ]) {
    await assert.rejects(owned.service.handle('project.create', { ...request, folderName }));
  }
  await assert.rejects(owned.service.handle('project.create', { ...request, overwrite: true }));
  await assert.rejects(owned.service.handle('project.create', { ...request, name: false }));
  await assert.rejects(
    owned.service.handle('project.create', { ...request, parentRoot: owned.root }),
    /overlaps/,
  );
  await assert.rejects(
    owned.service.handle('project.create', { ...request, parentRoot: owned.dataDir }),
    /data directory/,
  );
  assert.equal(mkdir.mock.callCount(), 0);
  assert.equal(owned.service.projects.size, 1);
});

test('folder picking preserves literal trailing spaces and distinguishes parent home from a project root', async (context) => {
  const owned = await fixture(context);
  const root = path.join(path.dirname(owned.root), 'literal spaces  ');
  await fs.mkdir(root);
  assert.deepEqual(await pickFolder(async () => root + '\n', 'darwin'), { root, cancelled: false });
  const home = await fs.realpath(os.homedir());
  assert.deepEqual(await pickFolder(async () => home + '\n', 'darwin', 'parent'), {
    root: home,
    cancelled: false,
  });
  await assert.rejects(
    pickFolder(async () => home + '\n', 'darwin', 'project'),
    /not your home folder/,
  );
  assert.deepEqual(await pickFolder(async () => '', 'darwin', 'parent'), { cancelled: true });
});

test('model picking checks the selected file and treats cancel as an empty result', async (context) => {
  const owned = await fixture(context);
  const model = path.join(owned.root, 'Local model.GGUF');
  await fs.writeFile(model, 'picker fixture');
  const selection = await pickModelFile(async (command) => {
    assert.equal(command.program, '/usr/bin/osascript');
    assert.match(command.args[1], /choose file of type \{"gguf"\}/);
    return model + '\n';
  }, 'darwin');
  assert.deepEqual(selection, { path: model, cancelled: false });

  await assert.rejects(
    pickModelFile(async () => 'remote.gguf\n', 'darwin'),
    /Choose a local .gguf/,
  );
  const directory = path.join(owned.root, 'folder.gguf');
  await fs.mkdir(directory);
  await assert.rejects(
    pickModelFile(async () => directory + '\n', 'darwin'),
    /selected path is not a file/,
  );
  assert.deepEqual(await pickModelFile(async () => '', 'win32'), { cancelled: true });
  assert.deepEqual(
    await pickModelFile(async () => {
      throw Object.assign(new Error('cancelled'), { stderr: 'User canceled. (-128)' });
    }, 'darwin'),
    { cancelled: true },
  );
});

test('replacing the selected parent during validation prevents creation in the replacement directory', async (context) => {
  const owned = await fixture(context);
  const parentRoot = path.join(path.dirname(owned.root), 'selected');
  const retired = parentRoot + '-retired';
  await fs.mkdir(parentRoot);
  await fs.writeFile(path.join(parentRoot, 'keep.txt'), 'Original directory');
  const realpath = fs.realpath;
  let reads = 0;
  context.mock.method(fs, 'realpath', async (input, ...options) => {
    if (input === parentRoot && ++reads === 2) {
      await fs.rename(parentRoot, retired);
      await fs.mkdir(parentRoot);
    }
    return realpath(input, ...options);
  });
  await assert.rejects(
    owned.service.handle('project.create', { parentRoot, folderName: 'New', name: 'New' }),
    /parent folder was replaced/,
  );
  assert.deepEqual(await fs.readdir(parentRoot), []);
  assert.equal(await fs.readFile(path.join(retired, 'keep.txt'), 'utf8'), 'Original directory');
  assert.equal(owned.service.projects.size, 1);
});
