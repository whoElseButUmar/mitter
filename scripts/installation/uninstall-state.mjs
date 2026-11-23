import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from '../helpers/runtime.mjs';
import { canonicalDestination, inside } from './files.mjs';

const stateDirectories = new Set(['backups', 'preview-data', 'quality-reports', 'runtime', 'syntax']);
const stateFiles =
  /^(?:mitter\.sqlite(?:-wal|-shm|-journal)?|host-lease\.sqlite(?:-wal|-shm|-journal)?|host\.lock|\.reset-in-progress\.json|terminal-control\.json|\.terminal-[a-f0-9-]{36}\.tmp|state-restore-[a-f0-9-]{36}\.partial)$/;

async function dataInfo(directory) {
  try {
    const stat = await lstat(directory);

    if (!stat.isDirectory()) {
      throw new Error('The Miter data path must be a real folder: ' + directory);
    }

    return stat;
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return undefined;
  }
}

export async function uninstallStatePaths(directory, home, purge) {
  if (!(await dataInfo(directory))) {
    return [];
  }

  const canonical = await canonicalDestination(directory);

  for (const protectedFolder of [home, process.cwd()]) {
    if (inside(canonical, await canonicalDestination(protectedFolder))) {
      throw new Error(
        'Choose a terminal working directory outside Miter data and check the configured data folder.',
      );
    }
  }

  if (!purge) {
    return [];
  }

  const files = [];

  for (const name of (await readdir(canonical)).sort()) {
    if (stateDirectories.has(name) || stateFiles.test(name)) {
      const file = path.join(canonical, name);
      const stat = await lstat(file);

      if (!stat.isSymbolicLink() && stat.isDirectory() !== stateDirectories.has(name)) {
        throw new Error('Unexpected file or directory at ' + file);
      }

      files.push(file);
    }
  }

  return files;
}

async function projectRoots(dataDirectory) {
  const { assertStateDatabasePaths } = await import('../../dist/apps/host/src/core/backups.js');
  await assertStateDatabasePaths(dataDirectory);
  const file = path.join(dataDirectory, 'mitter.sqlite');

  try {
    await lstat(file);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return [];
  }

  const { openNodeSqlite } = await import('../../dist/apps/host/src/adapters/sqlite.js');
  const { readStoredProjects } = await import('../../dist/apps/host/src/core/database.js');
  const database = openNodeSqlite(file, true);

  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
      .get();

    if (table === undefined) {
      throw new Error('Could not verify project folders in ' + file);
    }

    const roots = [];

    for (const project of readStoredProjects(database)) {
      roots.push(await canonicalDestination(project.sourceRoot ?? project.root));
    }

    return roots;
  } finally {
    database.close();
  }
}

export async function withUninstallState(plan, purge, removeInstallation) {
  if (!(await dataInfo(plan.data))) {
    await removeInstallation();
    return;
  }

  const { resolveStateRoot, assertStateRoot } = await import('../../dist/apps/host/src/core/state-root.js');
  const root = await resolveStateRoot(plan.data);
  const { acquireHostLock } = await import('../../dist/apps/host/src/core/host-lock.js');
  const release = await acquireHostLock(root.path);

  try {
    const targets = [plan.destination, ...plan.statePaths];

    for (const project of await projectRoots(root.path)) {
      if (targets.some((file) => inside(file, project))) {
        throw new Error('A saved project is inside a removal path. Move it first: ' + project);
      }
    }

    for (const file of plan.statePaths) {
      await assertStateRoot(root);

      if (!['host.lock', 'host-lease.sqlite'].includes(path.basename(file))) {
        await rm(file, { recursive: true, force: true });
      }
    }

    await removeInstallation();

    if (purge) {
      await assertStateRoot(root);
      // Keep the SQLite lease open until the browser registration and launcher
      // are gone, so an old connection cannot start during cleanup.
      await rm(path.join(root.path, 'host-lease.sqlite'), { force: true });
    }
  } finally {
    await release();
  }

  if (purge) {
    await assertStateRoot(root);

    try {
      await rmdir(root.path);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOTEMPTY') && !hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }
  }
}
