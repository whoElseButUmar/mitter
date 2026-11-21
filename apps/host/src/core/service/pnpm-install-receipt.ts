import { createHash, type Hash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Project, Worker } from '../../../../../packages/protocol/src/index.js';
import type { Store } from '../database.js';
import { managedPnpmExecutable } from '../managed-pnpm.js';
import { hasErrorCode } from '../types.js';

export function plainPnpmInstall(command: readonly string[]) {
  return command.length === 2 && command[0] === 'pnpm' && ['install', 'i'].includes(command[1] ?? '');
}

const receiptSchema = z.object({
  root: z.string(),
  projectId: z.string(),
  workerId: z.string(),
  signature: z.string().nullable(),
});

function key(worker: Worker) {
  return 'miter.pnpmInstall.' + worker.runId;
}

function readReceipt(store: Store, worker: Worker, project: Project) {
  const parsed = receiptSchema.safeParse(store.get(key(worker)));
  if (
    parsed.success &&
    parsed.data.workerId === worker.id &&
    parsed.data.root === project.root &&
    parsed.data.projectId === project.id
  ) {
    return parsed.data;
  }
  return;
}

export function pnpmInstallNote(store: Store, worker: Worker, project: Project) {
  if (readReceipt(store, worker, project)) {
    return 'A verified pnpm install already exited 0 for this project in this run. Continue with the build unless dependency inputs have changed.\n';
  }
  return '';
}

export function forgetPnpmInstall(store: Store, worker: Worker) {
  store.set(key(worker), null);
}

function hashEntry(hash: Hash, ...values: string[]) {
  hash.update(JSON.stringify(values) + '\n');
}

async function fileIdentity(filename: string) {
  try {
    const entry = await stat(filename, { bigint: true });
    return [entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeNs, entry.ctimeNs].join('/');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return 'missing';
    }
    throw error;
  }
}

// Capture the environment and manifest on both sides of the command. A lockfile can
// legitimately be created by install; the installed copy must agree with it afterward.
export type PnpmInstallInputs = { hash: string; dependencies: string[] };

export async function pnpmInstallInputs(
  root: string,
  scratch: string,
): Promise<PnpmInstallInputs | undefined> {
  try {
    const manifestPath = path.join(root, 'package.json');
    const meta = await lstat(manifestPath);
    if (!meta.isFile() || meta.size > 128_000 || (await realpath(root)) !== root) {
      return;
    }
    const manifest = await readFile(manifestPath, 'utf8');
    const pkg = z
      .object({
        scripts: z.record(z.string(), z.string()).optional(),
        dependencies: z.record(z.string(), z.string()).optional(),
        devDependencies: z.record(z.string(), z.string()).optional(),
        optionalDependencies: z.record(z.string(), z.string()).optional(),
        pnpm: z.unknown().optional(),
        workspaces: z.unknown().optional(),
      })
      .parse(JSON.parse(manifest));
    const requirements = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    if (
      pkg.pnpm ||
      pkg.workspaces ||
      Object.keys(requirements).some((name) => !/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) ||
      Object.keys(pkg.scripts ?? {}).some((name) =>
        /^(?:preinstall|install|postinstall|prepublish|preprepare|prepare|postprepare|pnpm:devPreinstall)$/.test(
          name,
        ),
      ) ||
      Object.values(requirements).some((version) => !/^[0-9a-zA-Z.*~^<>=| -]+$/.test(version))
    ) {
      return;
    }
    const home = os.homedir();
    const hash = createHash('sha256');
    hashEntry(
      hash,
      root,
      scratch,
      manifest,
      process.platform,
      process.arch,
      process.version,
      await fileIdentity(managedPnpmExecutable()),
    );
    for (const name of Object.keys(process.env).sort()) {
      if (/^(?:npm_|pnpm_|xdg_|home$|path$|ci$|node_)/i.test(name)) {
        hashEntry(hash, name, process.env[name] ?? '');
      }
    }
    for (let dir = root; ; dir = path.dirname(dir)) {
      for (const file of [
        'pnpm-workspace.yaml',
        '.pnpmfile.cjs',
        '.pnpmfile.mjs',
        'pnpmfile.cjs',
        'pnpmfile.mjs',
      ]) {
        if ((await fileIdentity(path.join(dir, file))) !== 'missing') {
          return;
        }
      }
      hashEntry(hash, dir, await fileIdentity(path.join(dir, '.npmrc')));
      if (path.dirname(dir) === dir) {
        break;
      }
    }
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const file of [
      path.join(home, '.npmrc'),
      path.join(scratch, '.npmrc'),
      path.join(configHome, 'pnpm', 'rc'),
      path.join(home, 'Library', 'Preferences', 'pnpm', 'rc'),
      process.env.NPM_CONFIG_USERCONFIG,
      process.env.npm_config_userconfig,
      process.env.NPM_CONFIG_GLOBALCONFIG,
      process.env.npm_config_globalconfig,
    ]) {
      if (file) {
        hashEntry(hash, file, await fileIdentity(file));
      }
    }
    return { hash: hash.digest('hex'), dependencies: Object.keys(requirements) };
  } catch {
    // An install can still be approved and executed normally without a reusable receipt.
    return;
  }
}

async function installedSignature(root: string, inputs: PnpmInstallInputs): Promise<string | undefined> {
  try {
    const modules = path.join(root, 'node_modules');
    const virtual = path.join(modules, '.pnpm');
    if ((await realpath(virtual)) !== virtual) {
      return;
    }
    const lock = path.join(root, 'pnpm-lock.yaml');
    const installedLock = path.join(virtual, 'lock.yaml');
    const locks = await Promise.all([
      lstat(lock),
      lstat(installedLock),
      lstat(path.join(modules, '.modules.yaml')),
    ]);
    if (locks.some((item) => !item.isFile() || item.size === 0 || item.size > 2_000_000)) {
      return;
    }
    const [expected, actual] = await Promise.all([readFile(lock), readFile(installedLock)]);
    if (
      !expected.equals(actual) ||
      /(?:\b(?:file|link|workspace):|^patchedDependencies:)/m.test(expected.toString('utf8'))
    ) {
      return;
    }

    for (const name of inputs.dependencies) {
      const pkg = await realpath(path.join(modules, name));
      if (!pkg.startsWith(virtual + path.sep) || !(await lstat(path.join(pkg, 'package.json'))).isFile()) {
        return;
      }
    }
    const hash = createHash('sha256').update(inputs.hash).update(expected);
    const pending = [modules];
    let count = 0;
    while (pending.length) {
      const directory = pending.pop();
      if (!directory) {
        break;
      }
      const names = (await readdir(directory)).sort();
      count += names.length;
      if (count > 10_000) {
        return;
      }
      // Vite and TypeScript may write build caches beside the installed packages.
      for (const name of names) {
        if (directory === modules && ['.vite', '.vite-temp', '.cache', '.tmp'].includes(name)) {
          continue;
        }
        const entry = path.join(directory, name);
        const info = await lstat(entry, { bigint: true });
        hashEntry(
          hash,
          path.relative(modules, entry),
          String(info.dev),
          String(info.ino),
          String(info.mode),
          String(info.size),
          String(info.mtimeNs),
          String(info.ctimeNs),
        );
        if (info.isDirectory()) {
          pending.push(entry);
        } else if (info.isSymbolicLink()) {
          const target = await realpath(entry);
          if (!target.startsWith(virtual + path.sep)) {
            return;
          }
          hashEntry(hash, await readlink(entry));
        } else if (!info.isFile()) {
          return;
        }
      }
    }
    return hash.digest('hex');
  } catch {
    return;
  }
}

export async function recordPnpmInstall(
  store: Store,
  worker: Worker,
  project: Project,
  scratch: string,
  initial: PnpmInstallInputs | undefined,
  signal: AbortSignal,
) {
  let signature: string | undefined;
  if (initial && initial.hash === (await pnpmInstallInputs(project.root, scratch))?.hash) {
    signature = await installedSignature(project.root, initial);
  }
  signal.throwIfAborted();
  store.set(key(worker), {
    workerId: worker.id,
    projectId: project.id,
    root: project.root,
    signature: signature ?? null,
  });
}

export async function pnpmInstallIsCurrent(
  store: Store,
  worker: Worker,
  project: Project,
  inputs: PnpmInstallInputs | undefined,
) {
  const receipt = readReceipt(store, worker, project);
  return Boolean(
    inputs && receipt?.signature && receipt.signature === (await installedSignature(project.root, inputs)),
  );
}
