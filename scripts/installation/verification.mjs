import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleManifestSchema } from './bundle-contracts.mjs';
import { digest, inventory } from './files.mjs';

export async function verifyBundle(root) {
  const manifestFile = path.join(root, 'bundle.json');
  const stat = await lstat(manifestFile);

  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) {
    throw new Error('Bundle manifest must be a regular file no larger than 8 MiB.');
  }

  const manifestBytes = await readFile(manifestFile);
  const manifest = bundleManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));

  if (manifest.platform !== process.platform || manifest.architecture !== process.arch) {
    throw new Error('This bundle needs macOS ' + manifest.architecture + '. Build it on this Mac instead.');
  }

  if (JSON.stringify(await inventory(root)) !== JSON.stringify(manifest.files)) {
    throw new Error('Bundle files changed or are incomplete. Recreate the bundle before installing.');
  }

  return { manifest, release: digest(manifestBytes) };
}

export function verifyPackagedRuntime(root) {
  const node = path.join(root, 'runtime/node');
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'miter-bundle-runtime-'));
  const env = { PATH: '/usr/bin:/bin', HOME: temporary, TMPDIR: temporary };

  try {
    execFileSync(node, ['scripts/verify-build.mjs'], {
      cwd: root,
      env,
      stdio: 'pipe',
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    });
    execFileSync(node, ['scripts/installation/verify-runtime.mjs'], {
      cwd: root,
      env,
      stdio: 'pipe',
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
