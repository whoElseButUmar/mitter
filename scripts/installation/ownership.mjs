import { chmod, lstat, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { atomicConfig } from '../atomic-config.mjs';
import { hasErrorCode } from '../helpers/runtime.mjs';
import { installationOwnerSchema, installationStateSchema } from './bundle-contracts.mjs';
import { installationLockName } from './lock.mjs';
import { rejectLinks } from './files.mjs';

const ownerName = '.miter-installation.json';
const partialPattern =
  /^\.miter-installation\.json\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.partial$/;

async function readMarker(file, schema, maximumBytes) {
  let stat;

  try {
    stat = await lstat(file);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return { status: 'missing' };
  }

  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('Refusing linked or non-regular installation metadata: ' + file);
  }

  if (stat.size > maximumBytes) {
    return { status: 'invalid' };
  }

  let value;

  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    return { status: 'invalid' };
  }

  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    return { status: 'invalid' };
  }

  return { status: 'valid', value: parsed.data };
}

function requireIdentity(marker, identity) {
  if (marker.extensionId !== identity.extensionId) {
    throw new Error('The destination belongs to a different extension identity.');
  }
}

/** Read-only admission. A filename alone never proves ownership. */
export async function inspectOwnership(destination, identity) {
  let entries;

  try {
    entries = await readdir(destination);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return { kind: 'empty' };
  }

  const content = entries.filter((name) => {
    return name !== installationLockName;
  });

  if (content.length === 0) {
    return { kind: 'empty' };
  }

  const owner = await readMarker(path.join(destination, ownerName), installationOwnerSchema, 512);

  if (owner.status === 'valid') {
    requireIdentity(owner.value, identity);

    return { kind: 'owner' };
  }

  const state = await readMarker(path.join(destination, 'installation.json'), installationStateSchema, 16384);

  if (state.status === 'valid') {
    requireIdentity(state.value, identity);

    return { kind: 'state' };
  }

  if (
    owner.status === 'missing' &&
    content.length === 1 &&
    partialPattern.test(content[0]) &&
    entries.includes(installationLockName)
  ) {
    const lock = await lstat(path.join(destination, installationLockName));
    const partial = path.join(destination, content[0]);
    const pending = await readMarker(partial, installationOwnerSchema, 512);

    if (
      lock.isFile() &&
      !lock.isSymbolicLink() &&
      lock.nlink === 1 &&
      lock.size === 0 &&
      pending.status === 'valid'
    ) {
      requireIdentity(pending.value, identity);

      return { kind: 'partial', file: partial };
    }
  }

  throw new Error(
    'Choose an empty destination or an existing managed Miter installation. Ownership metadata is missing or incomplete; unrelated files were left untouched.',
  );
}

/** Caller holds the kernel lock; repeat every proof check before promotion. */
export async function establishOwnership(destination, identity) {
  const proof = await inspectOwnership(destination, identity);
  const ownerFile = path.join(destination, ownerName);

  await rejectLinks(ownerFile, destination);

  if (proof.kind === 'owner') {
    return;
  }

  if (proof.kind === 'partial') {
    await chmod(proof.file, 0o600);
    await rename(proof.file, ownerFile);

    return;
  }

  const owner = installationOwnerSchema.parse({ format: 1, extensionId: identity.extensionId });

  await atomicConfig(ownerFile, JSON.stringify(owner, null, 2) + '\n', 0o600);
}
