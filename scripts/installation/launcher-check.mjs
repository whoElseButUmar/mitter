import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { installationStateSchema } from './bundle-contracts.mjs';
import { releaseDirectoryName } from './releases.mjs';
import { launcherSource } from './registration.mjs';
import { hasErrorCode } from '../helpers/runtime.mjs';

/** Parse only the exact shell template emitted by our registrar. Never evaluate
 * shell text or guess whether an arbitrary replacement launcher is equivalent.
 */
export function registeredLauncherDetails(source) {
  const quoted = source.match(/'(?:[^']|'\\'')*'/g);

  if (!quoted || quoted.length !== 4) {
    throw new Error('The native launcher is not in the expected Miter format. Rerun the installer.');
  }

  const values = quoted.map((value) => {
    return value.slice(1, -1).replaceAll("'\\''", "'");
  });

  if (
    !values.every((value) => {
      return path.isAbsolute(value) && !value.includes('\0');
    })
  ) {
    throw new Error('The native launcher contains an invalid installation path. Rerun the installer.');
  }

  const [dataDirectory, root, nodeExecutable, hostScript] = values;
  const portable = source.endsWith(' --portable "$@"\n');
  const details = { platform: 'darwin', dataDirectory, root, nodeExecutable, hostScript, portable };

  if (launcherSource(details) !== source || hostScript !== path.join(root, 'dist/apps/host/src/native.js')) {
    throw new Error('The native launcher changed or points outside its installation. Rerun the installer.');
  }

  return details;
}

async function regularFile(file, mode) {
  const stat = await lstat(file);

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Expected a regular installation file: ' + file);
  }

  await access(file, mode);
}

export async function inspectRegisteredLauncher(file, extensionId, platform) {
  await regularFile(file, constants.X_OK);
  file = await realpath(file);

  if (platform !== 'darwin') {
    return undefined;
  }

  const details = registeredLauncherDetails(await readFile(file, 'utf8'));

  await regularFile(details.nodeExecutable, constants.X_OK);
  await regularFile(details.hostScript, constants.R_OK);
  const managed = path.dirname(path.dirname(file));
  const marker = path.join(managed, 'installation.json');
  let state;

  try {
    state = installationStateSchema.parse(JSON.parse(await readFile(marker, 'utf8')));
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw new Error('Managed installation metadata is invalid. Rerun Install Miter.command.', {
        cause: error,
      });
    }

    try {
      await lstat(path.join(managed, '.miter-installation.json'));
      throw new Error('Managed installation did not finish. Rerun Install Miter.command.');
    } catch (ownerError) {
      if (!hasErrorCode(ownerError, 'ENOENT')) {
        throw ownerError;
      }
    }

    return details;
  }

  const release = path.join(managed, 'releases', releaseDirectoryName(state));

  if (
    state.extensionId !== extensionId ||
    details.root !== release ||
    details.nodeExecutable !== path.join(release, 'runtime/node')
  ) {
    throw new Error(
      'The registered launcher and active managed release do not match. Rerun Install Miter.command.',
    );
  }

  const { verifyBundle } = await import('./verification.mjs');

  const verified = await verifyBundle(release);

  if (verified.release !== state.release) {
    throw new Error('The active release no longer matches its recorded bundle. Rerun Install Miter.command.');
  }

  return details;
}
