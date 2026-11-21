import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicConfig, configTransaction } from '../atomic-config.mjs';
import { hasErrorCode } from '../helpers/runtime.mjs';
import { canonicalDestination, digest } from './files.mjs';
import { verifyBundle, verifyPackagedRuntime } from './verification.mjs';

/** Make one deliverable from an already verified local bundle. Extraction and
 * runtime checks happen before publishing the ZIP or its checksum.
 */
export async function createBundleArchive(bundle) {
  bundle = await canonicalDestination(bundle);
  await verifyBundle(bundle);
  const file = bundle + '.zip';

  try {
    const existing = await lstat(file);

    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw new Error('Refusing to overwrite a linked or non-regular installer ZIP: ' + file);
    }
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }

  const partial = file + '.' + randomUUID() + '.partial';
  const extracted = await mkdtemp(path.join(os.tmpdir(), 'miter-archive-check-'));
  const env = { PATH: '/usr/bin:/bin', HOME: extracted, TMPDIR: extracted, COPYFILE_DISABLE: '1' };

  try {
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', bundle, partial], {
      env,
      timeout: 60000,
      stdio: 'pipe',
      maxBuffer: 1024 * 1024,
    });
    execFileSync('/usr/bin/ditto', ['-x', '-k', partial, extracted], {
      env,
      timeout: 60000,
      stdio: 'pipe',
      maxBuffer: 1024 * 1024,
    });
    const restored = path.join(extracted, path.basename(bundle));

    await verifyBundle(restored);
    verifyPackagedRuntime(restored);
    const bytes = await readFile(partial);
    const sha256 = digest(bytes);

    await configTransaction([file, file + '.sha256'], async () => {
      await rename(partial, file);
      await atomicConfig(file + '.sha256', sha256 + '  ' + path.basename(file) + '\n', 0o600);
    });

    return { file, bytes: bytes.length, sha256 };
  } finally {
    await rm(partial, { force: true });
    await rm(extracted, { recursive: true, force: true });
  }
}
