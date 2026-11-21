import { createHash } from 'node:crypto';
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from '../helpers/runtime.mjs';

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function inside(root, file) {
  const relative = path.relative(root, file);

  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** Resolve existing ancestors, including macOS /var -> /private/var, before comparing paths. */
export async function canonicalDestination(file) {
  try {
    return await realpath(file);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return path.join(await canonicalDestination(path.dirname(file)), path.basename(file));
  }
}

/** Existing installer-owned paths must never redirect writes through symbolic links. */
export async function rejectLinks(file, boundary) {
  let current = path.resolve(file);
  const stop = path.resolve(boundary);

  if (!inside(stop, current)) {
    throw new Error('Installation path escapes its owned directory: ' + current);
  }

  while (true) {
    try {
      const stat = await lstat(current);

      if (stat.isSymbolicLink()) {
        throw new Error('Refusing a symbolic link in an installation path: ' + current);
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }

    if (current === stop) {
      return;
    }

    current = path.dirname(current);
  }
}

export async function copyTree(source, destination, options = {}) {
  options.sourceRoot ??= source;
  const relative = path.relative(options.sourceRoot, source).split(path.sep).join('/');

  if (options.include && !options.include(relative)) {
    return;
  }

  const stat = await lstat(source);

  if (path.basename(source) === '.DS_Store' && stat.isFile()) {
    return;
  }

  options.budget ??= { files: 0, bytes: 0 };
  options.budget.files += 1;
  options.budget.bytes += stat.size;

  if (options.budget.files > 30000 || options.budget.bytes > 1024 * 1024 * 1024) {
    throw new Error('Copy exceeds 30,000 entries or 1 GiB.');
  }

  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });

    for (const name of (await readdir(source)).sort()) {
      if (options.exclude?.has(name)) {
        continue;
      }

      await copyTree(path.join(source, name), path.join(destination, name), options);
    }
  } else if (stat.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    await chmod(destination, stat.mode & 0o777);
  } else if (stat.isSymbolicLink() && options.links) {
    const target = await readlink(source);

    if (path.isAbsolute(target) || !inside(options.links, path.resolve(source, '..', target))) {
      throw new Error('Bundle symbolic link escapes its root: ' + source);
    }

    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await symlink(target, destination);
  } else {
    throw new Error('Cannot package a symbolic link or special file: ' + source);
  }
}

/** Inventory is closed: added files, links, executable bits and changed bytes are detected. */
export async function inventory(root) {
  root = await realpath(root);
  const entries = [];
  let bytes = 0;

  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join('/');

      if (relative === 'bundle.json') {
        continue;
      }

      const stat = await lstat(file);

      if (name === '.DS_Store' && stat.isFile()) {
        continue;
      }

      if (stat.isDirectory()) {
        await visit(file);
      } else if (stat.isFile()) {
        bytes += stat.size;

        if (bytes > 1024 * 1024 * 1024) {
          throw new Error('Bundle exceeds 1 GiB.');
        }

        entries.push({ path: relative, sha256: digest(await readFile(file)), mode: stat.mode & 0o777 });
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(file);
        const resolved = await realpath(file);

        if (path.isAbsolute(target) || !inside(root, resolved)) {
          throw new Error('Bundle symbolic link escapes its root: ' + relative);
        }

        entries.push({ path: relative, target });
      } else {
        throw new Error('Unsupported bundle file: ' + relative);
      }

      if (entries.length > 30000 || bytes > 1024 * 1024 * 1024) {
        throw new Error('Bundle exceeds 30,000 files or 1 GiB.');
      }
    }
  }

  await visit(root);

  return entries;
}
