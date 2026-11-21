import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { managedPnpmExecutable } from '../managed-pnpm.js';
import { Locks } from '../locks.js';
import { hasErrorCode } from '../types.js';
import { runStage } from './process.js';

const installs = new Locks();

async function privateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (await fs.realpath(directory)) !== directory
  ) {
    throw new Error('The Miter package cache must be a private directory owned by this user.');
  }
}

async function pinnedLock(filename: string) {
  try {
    return await fs.readFile(filename);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

export async function installDependencies(
  scratch: string,
  manifest: string,
  projectLock: Buffer | undefined,
  signal: AbortSignal,
  onOutput?: (text: string) => void,
) {
  const cwd = path.join(scratch, 'install');
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'Miter');
  const store = path.join(cache, 'pnpm');
  const pins = path.join(cache, 'pnpm-locks');
  await Promise.all([privateDirectory(store), privateDirectory(pins)]);
  const executable = await fs.realpath(managedPnpmExecutable());
  const fingerprint = createHash('sha256').update(manifest).digest('hex');
  const pin = path.join(pins, fingerprint + '.yaml');
  const target = path.join(cwd, 'pnpm-lock.yaml');
  const install = async (lock: Buffer | undefined) => {
    const args = [
      'install',
      '--ignore-workspace',
      '--ignore-scripts',
      '--ignore-pnpmfile',
      '--no-trust-lockfile',
      '--no-runtime',
      '--prefer-offline',
      '--store-dir',
      store,
      '--package-import-method=copy',
      '--registry=https://registry.npmjs.org/',
      '--reporter=append-only',
    ];
    if (lock) {
      await fs.writeFile(target, lock);
      args.push('--frozen-lockfile');
    } else {
      args.push('--no-frozen-lockfile');
    }
    onOutput?.('Installing dependencies with pnpm.\n');
    await runStage(
      { cwd, scratch, executable, store, args, signal, ...(onOutput && { onOutput }) },
      'pnpm install',
      180_000,
    );
  };
  await fs.writeFile(path.join(cwd, 'package.json'), manifest);
  if (projectLock) {
    await install(projectLock);
    return;
  }
  // A generated project may not have a lockfile yet. Preserve its first resolution so the
  // tested build and subsequent preview install the same packages across app restarts.
  await installs.using(pin, signal, async () => {
    const saved = await pinnedLock(pin);
    await install(saved);
    if (saved) {
      return;
    }
    const generated = await fs.readFile(target);
    const temporary = pin + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, generated, { flag: 'wx', mode: 0o600 });
      try {
        await fs.link(temporary, pin);
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) {
          throw error;
        }
        // Another host won publication. Use that resolution before serving.
        const winner = await fs.readFile(pin);
        if (!generated.equals(winner)) {
          await install(winner);
        }
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  });
}
