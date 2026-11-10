import { lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { errorMessage, hasErrorCode } from './helpers/runtime.mjs';

async function removeIfPresent(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

export async function previousFile(file) {
  let stat;

  try {
    stat = await lstat(file);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return undefined;
  }

  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('Refusing a linked or non-regular registration file: ' + file);
  }

  return {
    bytes: await readFile(file),
    mode: stat.mode & 0o777,
  };
}

export async function atomicConfig(file, data, mode) {
  await previousFile(file);
  const temporary = file + '.' + randomUUID() + '.partial';

  try {
    const handle = await open(temporary, 'wx', mode);

    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporary, file);
  } finally {
    await removeIfPresent(temporary);
  }
}

/** Restore original bytes and modes after a failed registration step. */
export async function configTransaction(files, write) {
  const originals = [];

  for (const file of files) {
    originals.push([file, await previousFile(file)]);
  }

  try {
    return await write();
  } catch (error) {
    const rollbackFailures = [];

    for (const [file, original] of originals) {
      try {
        if (original) {
          await atomicConfig(file, original.bytes, original.mode);
        } else {
          await removeIfPresent(file);
        }
      } catch (restoreError) {
        rollbackFailures.push(errorMessage(restoreError));
      }
    }

    if (rollbackFailures.length > 0) {
      const details = rollbackFailures.join('; ');

      throw new Error(errorMessage(error) + '; registration rollback failed: ' + details, { cause: error });
    }

    throw error;
  }
}
