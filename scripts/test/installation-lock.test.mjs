import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { acquireInstallationLock, installationLockName } from '../installation/lock.mjs';

async function temporary(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'miter-install-lock-'));

  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

test(
  'advisory install lock rejects contention and reuses its inode after release',
  { skip: process.platform !== 'darwin' },
  async (context) => {
    const directory = await temporary(context);
    const first = await acquireInstallationLock(directory);

    try {
      await assert.rejects(acquireInstallationLock(directory), /Another Miter installer/);
    } finally {
      await first.close();
    }

    const before = await lstat(path.join(directory, installationLockName));
    const next = await acquireInstallationLock(directory);

    await next.close();
    const after = await lstat(path.join(directory, installationLockName));

    assert.equal(before.ino, after.ino);
    assert.equal(after.size, 0);
  },
);

test(
  'SIGKILL releases the install lock without a surviving helper or manual deletion',
  { skip: process.platform !== 'darwin', timeout: 15000 },
  async (context) => {
    const directory = await temporary(context);
    const script = path.join(directory, 'holder.mjs');
    const moduleUrl = new URL('../installation/lock.mjs', import.meta.url).href;

    await writeFile(
      script,
      `import { acquireInstallationLock } from ${JSON.stringify(moduleUrl)};\nconst handle = await acquireInstallationLock(process.argv[2]);\nconsole.log('locked');\nsetInterval(() => {}, 1000);\n`,
    );
    const child = spawn(process.execPath, [script, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    context.after(() => {
      child.kill('SIGKILL');
    });
    const closed = once(child, 'close');
    const [ready] = await once(child.stdout, 'data');

    assert.match(ready.toString(), /locked/, stderr);
    await assert.rejects(acquireInstallationLock(directory), /Another Miter installer/);
    child.kill('SIGKILL');
    await closed;
    const next = await acquireInstallationLock(directory);

    await next.close();
    assert.equal(await readFile(path.join(directory, installationLockName), 'utf8'), '');
  },
);

test(
  'legacy locks, symlinks and nonempty lock files are refused without deleting them',
  { skip: process.platform !== 'darwin' },
  async (context) => {
    const directory = await temporary(context);
    const legacy = path.join(directory, '.install-lock');

    await mkdir(legacy);
    await assert.rejects(acquireInstallationLock(directory), /older installer/);
    assert.equal((await lstat(legacy)).isDirectory(), true);
    await rm(legacy, { recursive: true });
    const target = path.join(directory, 'keep.txt');
    const file = path.join(directory, installationLockName);

    await writeFile(target, 'keep');
    await symlink(target, file);
    await assert.rejects(acquireInstallationLock(directory), /symbolic link/);
    assert.equal(await readFile(target, 'utf8'), 'keep');
    await rm(file);
    await writeFile(file, 'not a lock');
    await assert.rejects(acquireInstallationLock(directory), /empty regular file with a single link/);
    assert.equal(await readFile(file, 'utf8'), 'not a lock');
  },
);
