import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { copyTree, digest } from './files.mjs';
import { packageNamePattern } from './bootstrap.mjs';
import { hasErrorCode } from '../helpers/runtime.mjs';

const nameSchema = z
  .string()
  .regex(packageNamePattern)
  .describe('A canonical npm package name without filesystem traversal.');

const dependencyMetadataSchema = z
  .object({
    name: nameSchema,
    version: z.string().min(1).describe('Installed npm package version.'),
    dependencies: z.record(nameSchema, z.string()).optional().describe('Required installed dependencies.'),
    optionalDependencies: z
      .record(nameSchema, z.string())
      .optional()
      .describe('Optional installed dependencies.'),
  })
  .describe('The installed package dependency graph; unrelated package metadata is ignored.');

async function resolveUnexportedPackage(name, require, cause) {
  // Package exports govern imports, not which installed files belong in a bundle.
  // Keep Node's dependency search order so a nested version cannot become a hoisted one.
  for (const modules of require.resolve.paths(name) ?? []) {
    let directory;

    try {
      directory = await realpath(path.join(modules, name));
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        continue;
      }

      throw error;
    }

    const metadata = dependencyMetadataSchema.parse(
      JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')),
    );

    if (metadata.name !== name) {
      throw new Error('Installed dependency metadata does not match its requested name: ' + name);
    }

    return { directory, metadata };
  }

  throw new Error('Cannot locate installed dependency metadata: ' + name, { cause });
}

async function resolvePackage(name, from) {
  name = nameSchema.parse(name);
  const require = createRequire(path.join(from, 'package.json'));
  let entry;

  try {
    entry = require.resolve(name + '/package.json');
  } catch {
    try {
      entry = require.resolve(name);
    } catch (error) {
      return resolveUnexportedPackage(name, require, error);
    }
  }

  let directory = path.dirname(await realpath(entry));

  while (true) {
    try {
      const metadata = dependencyMetadataSchema.parse(
        JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')),
      );

      if (metadata.name === name) {
        return { directory, metadata };
      }
    } catch {
      // An entrypoint may live below its package.json.
    }

    const parent = path.dirname(directory);

    if (parent === directory) {
      throw new Error('Cannot locate installed dependency metadata: ' + name);
    }

    directory = parent;
  }
}

/** Only the two native packages with a verified prebuild layout are filtered.
 * Other package files, source and license notices remain intact.
 */
function includeRuntimeFile(name, relative) {
  if (!relative.startsWith('prebuilds/')) {
    return true;
  }

  const selected = process.platform + '-' + process.arch;

  if (name === 'node-pty') {
    return relative.split('/')[1] === selected;
  }

  if (name === 'better-sqlite3') {
    return relative === 'prebuilds/' + selected + '.node';
  }

  return true;
}

export async function copyDependencies(root, destination, names) {
  const copied = new Map();

  async function linkDependency(name, from, targetModules) {
    const { directory, metadata } = await resolvePackage(name, from);
    let copiedDirectory = copied.get(directory);

    if (copiedDirectory === undefined) {
      const key = metadata.name.replaceAll('/', '+') + '-' + digest(directory).slice(0, 12);

      copiedDirectory = path.join(destination, 'node_modules/.miter', key);
      copied.set(directory, copiedDirectory);
      await copyTree(directory, copiedDirectory, {
        exclude: new Set(['node_modules', 'node_gyp_bins']),
        include(relative) {
          return includeRuntimeFile(metadata.name, relative);
        },
      });

      for (const dependency of Object.keys(metadata.dependencies ?? {})) {
        if (Object.hasOwn(metadata.optionalDependencies ?? {}, dependency)) {
          continue;
        }

        await linkDependency(dependency, directory, path.join(copiedDirectory, 'node_modules'));
      }

      for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) {
        try {
          await resolvePackage(dependency, directory);
        } catch {
          continue;
        }

        await linkDependency(dependency, directory, path.join(copiedDirectory, 'node_modules'));
      }
    }

    const link = path.join(targetModules, name);

    await mkdir(path.dirname(link), { recursive: true, mode: 0o700 });
    await symlink(path.relative(path.dirname(link), copiedDirectory), link);
  }

  for (const name of names) {
    await linkDependency(name, root, path.join(destination, 'node_modules'));
  }
}
