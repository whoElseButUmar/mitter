import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { installationStateSchema } from './bundle-contracts.mjs';
import { copyTree, rejectLinks } from './files.mjs';
import { verifyBundle, verifyPackagedRuntime } from './verification.mjs';
import { hasErrorCode } from '../helpers/runtime.mjs';

export function releaseDirectoryName(state) {
  let name = state.release;

  if (state.repairId !== undefined) {
    name += '-' + state.repairId;
  }

  return name;
}

async function activeInstallation(destination) {
  let serialized;

  try {
    serialized = await readFile(path.join(destination, 'installation.json'), 'utf8');
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return undefined;
  }

  try {
    const parsed = installationStateSchema.safeParse(JSON.parse(serialized));

    if (parsed.success) {
      return parsed.data;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  // The owned destination may have an interrupted or damaged marker. Its
  // contents never authorize a path until they pass the current schema.
  return undefined;
}

async function exists(file) {
  try {
    await lstat(file);

    return true;
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return false;
  }
}

async function matchesBundle(root, release) {
  try {
    const verified = await verifyBundle(root);

    return verified.release === release;
  } catch {
    // Never rewrite a damaged release: a running host may still use its path.
    return false;
  }
}

/** Caller owns the installation lock. Repair goes into a new immutable
 * directory, preserving old paths and allowing the same ZIP to fix corruption.
 */
export async function prepareRelease({ bundle, destination, release }) {
  const releases = path.join(destination, 'releases');
  const active = await activeInstallation(destination);
  const candidates = [];

  if (active?.release === release && active.repairId !== undefined) {
    candidates.push({ release, repairId: active.repairId });
  }

  candidates.push({ release });

  for (const candidate of candidates) {
    const root = path.join(releases, releaseDirectoryName(candidate));

    await rejectLinks(root, destination);

    if (await matchesBundle(root, release)) {
      verifyPackagedRuntime(root);

      return { root, repairId: candidate.repairId };
    }
  }

  let repairId;
  let root = path.join(releases, release);

  if (await exists(root)) {
    repairId = randomBytes(8).toString('hex');
    root = path.join(releases, release + '-' + repairId);

    if (await exists(root)) {
      throw new Error('A new repair directory already exists. Retry the installer.');
    }
  }

  await rejectLinks(root, destination);
  const staging = await mkdtemp(path.join(releases, '.installing-'));

  try {
    await copyTree(bundle, staging, { links: bundle });
    const verified = await verifyBundle(staging);

    if (verified.release !== release) {
      throw new Error('The source bundle changed while it was being copied. Retry with the original ZIP.');
    }

    verifyPackagedRuntime(staging);
    await rename(staging, root);

    return { root, repairId };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
