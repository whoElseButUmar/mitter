import path from 'node:path';
import { promises as fs } from 'node:fs';

/** A real directory, not the spelling used to reach it. Keep this identity for
 * the host lifetime: a retargeted ancestor alias must not redirect state I/O. */
export interface StateRoot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

export async function resolveStateRoot(input: string): Promise<StateRoot> {
  const requested = path.resolve(input);
  const before = await fs.lstat(requested, { bigint: true });
  // Ancestor aliases (including macOS /var -> /private/var) are resolved below.
  // The state directory itself must still be an actual directory, never a link.
  if (!before.isDirectory() || before.isSymbolicLink())
    throw Error(`Unsafe or linked Miter data directory: ${requested}. No data was deleted.`);
  const canonical = await fs.realpath(requested);
  const root = Object.freeze({ path: canonical, dev: before.dev, ino: before.ino });
  await assertStateRoot(root);
  return root;
}

export async function assertStateRoot(root: StateRoot): Promise<void> {
  try {
    const current = await fs.lstat(root.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() ||
        current.dev !== root.dev || current.ino !== root.ino ||
        await fs.realpath(root.path) !== root.path)
      throw Error('Directory identity or canonical path changed.');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw Error(`Miter data directory changed or is inaccessible: ${root.path}. Reset refused: ${detail}`);
  }
}

/** Resolve an existing path, or its longest existing ancestor for a missing
 * project. Missing project registrations must still participate in overlap
 * checks; dangling links and permission errors are not proof of absence. */
export async function canonicalLocation(input: string): Promise<string> {
  let current = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const entry = await fs.lstat(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
        return undefined;
      });
      // A dangling link exists even though realpath fails. Never reinterpret
      // that link as a nonexistent ordinary directory.
      if (entry) throw Error(`Cannot safely resolve protected folder: ${current}.`);
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}
