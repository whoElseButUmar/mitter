import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, copyFile, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

test('script entry detection runs through filesystem aliases and symlinks without executing imported CLIs', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'miter-entrypoint-'));

  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await copyFile(new URL('../helpers/runtime.mjs', import.meta.url), path.join(directory, 'runtime.mjs'));
  const entry = path.join(directory, 'entry.mjs');
  const importer = path.join(directory, 'importer.mjs');

  await writeFile(
    entry,
    "import { isMainModule } from './runtime.mjs'; if (isMainModule(import.meta.url)) console.log('entry ran');",
  );
  await writeFile(importer, "import './entry.mjs'; console.log('importer ran');");
  const linked = path.join(directory, 'linked.mjs');

  await symlink('entry.mjs', linked);

  for (const file of [entry, await realpath(entry), linked]) {
    const output = execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 10000 });

    assert.equal(output, 'entry ran\n');
  }

  assert.equal(
    execFileSync(process.execPath, [importer], { encoding: 'utf8', timeout: 10000 }),
    'importer ran\n',
  );
  const output = execFileSync(process.execPath, ['--preserve-symlinks-main', linked], {
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(output, 'entry ran\n');
});
