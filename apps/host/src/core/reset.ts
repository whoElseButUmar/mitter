import { hasErrorCode, errorMessage } from './types.js';
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertStateRoot, canonicalLocation, resolveStateRoot, type StateRoot } from './state-root.js';

export const RESET_MARKER = '.reset-in-progress.json';

export const resetFailureSchema = z
  .object({
    path: z.string().describe('The application-state path whose cleanup failed.'),
    error: z.string().describe('The cleanup failure message retained for an explicit retry.'),
  })
  .describe('One application-state cleanup failure; deletion remains incomplete.');

export const resetResultSchema = z
  .object({
    cleared: z.boolean().describe('Whether every eligible application-state deletion completed.'),
    failures: z.array(resetFailureSchema).describe('Cleanup failures that keep the reset barrier locked.'),
    preserved: z
      .array(z.string().describe('A retained infrastructure or source path.'))
      .describe('Protected paths deliberately preserved by cleanup.'),
  })
  .describe(
    'Verified application-state cleanup result with protected ' + 'infrastructure and source retained.',
  );

export type ResetFailure = z.infer<typeof resetFailureSchema>;

export type ResetResult = z.infer<typeof resetResultSchema>;
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
const message = errorMessage;

/** Only Miter's private state tree is eligible. Never follow a link, cross a
 * filesystem boundary, or erase source trees stored as isolated worktrees.
 * Installation launchers and the live host lease are infrastructure, not state.
 * Keeping the same lease inode prevents a second host entering during reset. */

export async function validateResetRoot(dataDir: string, projectRoots: string[] = []): Promise<StateRoot> {
  const identity = await resolveStateRoot(dataDir);
  const root = identity.path;
  const sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  // Compare every protected path in the same canonical namespace. A harmless
  // alias must neither reject /var/folders nor hide an overlapping project.
  const protectedRoots = await Promise.all([os.homedir(), sourceRoot, process.cwd()].map(canonicalLocation));

  if (root === path.parse(root).root || protectedRoots.some((folder) => inside(root, folder))) {
    throw new Error(
      `Unsafe Miter data directory: ${root}. Refusing to delete a home, installation, or working directory (or its ancestor).`,
    );
  }

  const worktrees = path.join(root, 'worktrees');

  for (const projectRoot of projectRoots) {
    const folder = await canonicalLocation(projectRoot);

    if ((inside(root, folder) || inside(folder, root)) && !inside(worktrees, folder)) {
      throw new Error(
        `Project folder overlaps Miter state: ${folder}. Reset refused; move Miter state outside the project first.`,
      );
    }
  }

  await assertResetMarker(root);
  await assertStateRoot(identity);

  return identity;
}

async function assertResetMarker(root: string): Promise<void> {
  const marker = await fs.lstat(path.join(root, RESET_MARKER)).catch((e: unknown) => {
    if (!hasErrorCode(e, 'ENOENT')) {
      throw e;
    }

    return undefined;
  });

  if (marker && (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1)) {
    throw new Error(`Unsafe reset marker: ${path.join(root, RESET_MARKER)}.`);
  }
}

export async function markResetPending(dataDir: string): Promise<void> {
  try {
    const handle = await fs.open(path.join(dataDir, RESET_MARKER), 'wx', 0o600);

    try {
      await handle.writeFile(
        JSON.stringify({
          version: 1,
          pending: true,
        }) + '\n',
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }

    await assertResetMarker(dataDir);
  }
}

export async function resetPending(dataDir: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(dataDir, RESET_MARKER));

    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }

    throw error;
  }
}

/** Called only after all writers, shells, model processes and state DB handles
 * have stopped. Partial deletion is NOT a successful reset; the marker remains.
 * Individual unlink/rmdir operations make failures inspectable and never follow
 * symlinks. User-controlled project roots are never deletion targets. */

export async function removeApplicationState(
  dataDir: string,
  expected?: StateRoot,
  projectRoots: string[] = [],
): Promise<ResetResult> {
  if (expected) {
    await assertStateRoot(expected);
  }

  const identity = await validateResetRoot(dataDir, projectRoots);
  const root = identity.path;

  if (
    expected &&
    (root !== expected.path || identity.dev !== expected.dev || identity.ino !== expected.ino)
  ) {
    throw Error(`Miter data directory changed before cleanup: ${root}. Reset refused.`);
  }

  const preservedNames = new Set([
    RESET_MARKER,
    'host.lock',
    'host-lease.sqlite',
    'host-lease.sqlite-journal',
    'native/mitter-host',
    'native/mitter-host.cmd',
    'native/ai.mitter.host.json',
    // These contain actual user source, including uncommitted changes. Preserve
    // orphaned worktrees too; the database is not the only proof they are valuable.
    'worktrees',
  ]);
  const failures: ResetFailure[] = [];
  const preserved: string[] = [];
  const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
  async function remove(file: string): Promise<void> {
    if (preservedNames.has(relative(file))) {
      preserved.push(file);
      return;
    }

    try {
      // Work only under the pinned canonical root, never the caller's alias.
      // Recheck identity as well as spelling: a replacement real directory is
      // not the directory whose writers and database were stopped.
      await assertParent(file);
      const stat = await fs.lstat(file, {
        bigint: true,
      });

      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (stat.dev !== identity.dev) {
          throw Error('Mounted filesystem is not Miter-owned; not traversed.');
        }

        await assertDirectory(file, stat);

        for (const name of await fs.readdir(file)) {
          await remove(path.join(file, name));
        }

        await assertDirectory(file, stat);

        if (!(await fs.readdir(file)).length) {
          await fs.rmdir(file);
        } else if (!preserved.some((p) => inside(file, p)) && !failures.some((p) => inside(file, p.path))) {
          throw Error('Directory changed while resetting; retry after closing other writers.');
        }
      } else {
        await assertParent(file);
        await fs.unlink(file);
      } // links are unlinked, never dereferenced
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        failures.push({
          path: file,
          error: message(error),
        });
      }
    }
  }
  async function assertParent(file: string): Promise<void> {
    await assertStateRoot(identity);
    const parent = path.dirname(file);

    if ((await fs.realpath(parent)) !== parent) {
      throw Error('Parent became a symbolic link; not followed.');
    }
  }
  async function assertDirectory(
    dir: string,
    expected?: {
      dev: bigint;
      ino: bigint;
    },
  ): Promise<void> {
    await assertStateRoot(identity);
    const stat = await fs.lstat(dir, {
      bigint: true,
    });

    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(dir)) !== dir ||
      stat.dev !== identity.dev ||
      (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))
    ) {
      throw Error(`Directory changed or is mounted/linked; not traversed: ${dir}.`);
    }
  }

  await assertStateRoot(identity);

  for (const name of await fs.readdir(root)) {
    await remove(path.join(root, name));
  }
  // Detect late writers without declaring success just because unlink resolved.
  async function verify(dir: string): Promise<void> {
    await assertDirectory(dir);

    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      const rel = relative(file);

      if (preservedNames.has(rel)) {
        continue;
      }

      if (rel === 'native') {
        const stat = await fs.lstat(file);

        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          await verify(file);
          continue;
        }
      }

      if (!failures.some((f) => inside(file, f.path) || inside(f.path, file))) {
        failures.push({
          path: file,
          error: 'Still present after cleanup; reset remains locked.',
        });
      }
    }
  }

  try {
    await verify(root);
  } catch (error) {
    failures.push({
      path: root,
      error: message(error),
    });
  }

  return {
    cleared: failures.length === 0,
    failures,
    preserved: preserved.filter((p) => !p.endsWith(RESET_MARKER)),
  };
}
