import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { hasErrorCode } from '../helpers/runtime.mjs';
import { rejectLinks } from './files.mjs';

export const installationLockName = '.installation.lock';

/** BSD advisory locks belong to the open-file description, including the
 * descriptor inherited by lockf. Keeping this handle open holds the lock after
 * lockf exits; process death closes it automatically. Never unlink the inode.
 */
export async function acquireInstallationLock(destination) {
  if (process.platform !== 'darwin') {
    throw new Error('The managed installer requires macOS.');
  }

  const legacy = path.join(destination, '.install-lock');

  try {
    await lstat(legacy);
    throw new Error(
      'An older installer left a lock at ' +
        legacy +
        '. Close any older installer before removing that legacy directory and retrying.',
    );
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }

  const file = path.join(destination, installationLockName);

  await rejectLinks(file, destination);
  const handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let acquired = false;

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 0) {
      throw new Error('The installer lock must be an empty regular file with a single link: ' + file);
    }

    const result = spawnSync('/usr/bin/lockf', ['-s', '-t', '0', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', handle.fd],
      env: { PATH: '/usr/bin:/bin' },
      timeout: 5000,
      maxBuffer: 4096,
      encoding: 'utf8',
    });

    if (result.status === 75) {
      throw new Error('Another Miter installer is using ' + destination + '. Let it finish, then retry.');
    }

    if (result.error || result.status !== 0) {
      throw new Error(
        'Could not acquire the macOS installation lock. Check folder permissions and retry. ' +
          (result.stderr || result.error?.message || ''),
        { cause: result.error },
      );
    }

    acquired = true;

    return handle;
  } finally {
    if (!acquired) {
      await handle.close();
    }
  }
}
