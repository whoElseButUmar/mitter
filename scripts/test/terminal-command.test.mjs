import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installTerminalCommand } from '../installation/terminal-command.mjs';

async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'miter terminal '));
  const home = path.join(directory, 'User Home');
  const command = path.join(directory, 'Application Support', 'Miter', 'bin', 'miter');
  const bin = path.join(home, '.local', 'bin');
  await mkdir(home, { mode: 0o700 });
  await mkdir(path.dirname(command), { recursive: true });
  await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(path.join(home, '.zshrc'), '# User preferences\n');
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, home, command, bin, shortcut: path.join(bin, 'miter') };
}

test('installs and repeats an exact convenience link with spaces without changing shell settings', async (context) => {
  const item = await fixture(context);
  const result = await installTerminalCommand(item);
  assert.equal(result.command, item.command);
  assert.equal(result.linked, true);
  assert.equal(await readlink(item.shortcut), item.command);
  const original = await lstat(item.shortcut);
  assert.equal((await installTerminalCommand(item)).linked, true);
  assert.equal((await lstat(item.shortcut)).ino, original.ino);
  assert.equal(await readFile(path.join(item.home, '.zshrc'), 'utf8'), '# User preferences\n');
});

test('preserves foreign files and links and returns the full command fallback', async (context) => {
  for (const kind of ['file', 'link']) {
    const item = await fixture(context);
    await mkdir(item.bin, { recursive: true });
    if (kind === 'file') {
      await writeFile(item.shortcut, 'unrelated executable');
    } else {
      await symlink('/some/other/miter', item.shortcut);
    }
    const before = await lstat(item.shortcut);
    const result = await installTerminalCommand(item);
    assert.equal(result.linked, false);
    assert.equal(result.command, item.command);
    assert.match(result.detail, /left untouched/);
    assert.equal((await lstat(item.shortcut)).ino, before.ino);
    if (kind === 'file') {
      assert.equal(await readFile(item.shortcut, 'utf8'), 'unrelated executable');
    } else {
      assert.equal(await readlink(item.shortcut), '/some/other/miter');
    }
  }
});

test('does not follow linked .local or bin directories or write into them', async (context) => {
  for (const name of ['.local', 'bin']) {
    const item = await fixture(context);
    const outside = path.join(item.directory, 'outside');
    await mkdir(outside);
    if (name === '.local') {
      await symlink(outside, path.join(item.home, '.local'));
    } else {
      await mkdir(path.join(item.home, '.local'));
      await symlink(outside, item.bin);
    }
    const result = await installTerminalCommand(item);
    assert.equal(result.linked, false);
    assert.equal(result.command, item.command);
    await assert.rejects(lstat(path.join(outside, 'miter')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(outside, 'bin')), { code: 'ENOENT' });
  }
});

test('rejects directories writable by others and reports invalid paths without throwing', async (context) => {
  const item = await fixture(context);
  await mkdir(item.bin, { recursive: true });
  await chmod(item.bin, 0o777);
  const result = await installTerminalCommand(item);
  assert.equal(result.linked, false);
  await assert.rejects(lstat(item.shortcut), { code: 'ENOENT' });
  assert.equal((await installTerminalCommand({ home: item.home, command: 'relative' })).linked, false);
  assert.equal((await installTerminalCommand({ home: 'relative', command: item.command })).linked, false);
});
