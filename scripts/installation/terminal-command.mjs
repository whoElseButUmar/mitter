import { lstat, mkdir, readlink, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from '../helpers/runtime.mjs';

async function requireOwnedDirectory(directory, uid) {
  const info = await lstat(directory);

  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) !== 0) {
    throw new Error(
      'A terminal command directory is linked, belongs to another user, or is writable by another user.',
    );
  }

  return { directory, dev: info.dev, ino: info.ino };
}

async function requireSameDirectory(identity, uid) {
  const current = await requireOwnedDirectory(identity.directory, uid);

  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error('A terminal command directory changed during installation.');
  }
}

async function ensureChildDirectory(parent, name, uid) {
  await requireSameDirectory(parent, uid);
  const directory = path.join(parent.directory, name);

  try {
    await mkdir(directory, { mode: 0o755 });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }

  await requireSameDirectory(parent, uid);
  return requireOwnedDirectory(directory, uid);
}

/** The full command remains usable if this optional convenience link cannot be installed. */
export async function installTerminalCommand({ home, command }) {
  const fallback = { command, linked: false };

  try {
    const uid = process.getuid?.();

    if (
      uid === undefined ||
      typeof home !== 'string' ||
      !path.isAbsolute(home) ||
      typeof command !== 'string' ||
      !path.isAbsolute(command)
    ) {
      return {
        ...fallback,
        detail: 'Use the full command path; a safe local terminal shortcut could not be installed.',
      };
    }

    const originalHome = await requireOwnedDirectory(home, uid);
    const canonicalHome = await realpath(home);
    const homeIdentity = await requireOwnedDirectory(canonicalHome, uid);

    if (homeIdentity.dev !== originalHome.dev || homeIdentity.ino !== originalHome.ino) {
      throw new Error('The home directory changed during installation.');
    }

    const local = await ensureChildDirectory(homeIdentity, '.local', uid);
    const bin = await ensureChildDirectory(local, 'bin', uid);
    const shortcut = path.join(bin.directory, 'miter');

    await requireSameDirectory(homeIdentity, uid);
    await requireSameDirectory(local, uid);
    await requireSameDirectory(bin, uid);

    try {
      await symlink(command, shortcut);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }

    await requireSameDirectory(homeIdentity, uid);
    await requireSameDirectory(local, uid);
    await requireSameDirectory(bin, uid);
    const entry = await lstat(shortcut);

    if (!entry.isSymbolicLink() || entry.uid !== uid || (await readlink(shortcut)) !== command) {
      return {
        ...fallback,
        detail:
          'An existing ~/.local/bin/miter belongs to another command. It was left untouched; use the full Miter command path.',
      };
    }

    return {
      command,
      linked: true,
      detail:
        'The miter shortcut is available in ~/.local/bin. The full command path also works; no shell settings were changed.',
    };
  } catch {
    return {
      ...fallback,
      detail:
        'The optional ~/.local/bin/miter shortcut could not be installed safely. Use the full Miter command path; shell settings and existing commands were left untouched.',
    };
  }
}
