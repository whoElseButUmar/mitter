import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeManifestSchema } from './contracts.mjs';
import { registeredLauncherDetails } from './launcher-check.mjs';
import { canonicalDestination, rejectLinks } from './files.mjs';
import { hasErrorCode } from '../helpers/runtime.mjs';

async function optionalText(file) {
  let stat;

  try {
    stat = await lstat(file);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return undefined;
  }

  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) {
    throw new Error('Existing registration must be a bounded regular file, not a link: ' + file);
  }

  return readFile(file, 'utf8');
}

/** Infer only from exact generated launchers and the selected browser identity.
 * No state file is opened; explicit dataHome (even empty for default) wins.
 */
export async function installationDataHome({ destination, manifestPath, identity, dataHome }) {
  if (dataHome !== undefined) {
    return dataHome;
  }

  try {
    const candidates = [];
    const managedLauncher = path.join(destination, 'bin/miter-host');

    await rejectLinks(managedLauncher, destination);
    const managed = await optionalText(managedLauncher);

    if (managed !== undefined) {
      const details = registeredLauncherDetails(managed);

      if (
        path.dirname(details.root) !== path.join(destination, 'releases') ||
        !/^[a-f0-9]{64}(?:-[a-f0-9]{16})?$/.test(path.basename(details.root)) ||
        details.nodeExecutable !== path.join(details.root, 'runtime/node')
      ) {
        throw new Error('The existing managed launcher points outside its retained release.');
      }

      candidates.push(details.dataDirectory);
    }

    const serialized = await optionalText(manifestPath);

    if (serialized !== undefined) {
      const manifest = nativeManifestSchema.parse(JSON.parse(serialized));

      if (
        manifest.name !== identity.nativeHost ||
        manifest.allowed_origins[0] !== `chrome-extension://${identity.extensionId}/`
      ) {
        throw new Error('The existing browser registration belongs to a different extension identity.');
      }

      const source = await optionalText(manifest.path);

      if (source === undefined) {
        throw new Error('The previously registered launcher is missing.');
      }

      candidates.push(registeredLauncherDetails(source).dataDirectory);
    }

    const [selected] = candidates;

    if (selected === undefined) {
      return undefined;
    }

    const canonical = await canonicalDestination(selected);

    for (const candidate of candidates) {
      if ((await canonicalDestination(candidate)) !== canonical) {
        throw new Error('The existing managed and browser launchers use different data folders.');
      }
    }

    return selected;
  } catch (error) {
    throw new Error(
      'Could not safely preserve the existing data folder. Set MITTER_HOME explicitly to the intended folder and rerun the installer; existing data was left untouched.',
      { cause: error },
    );
  }
}
