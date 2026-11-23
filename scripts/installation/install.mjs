import { mkdir, lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicConfig, configTransaction } from '../atomic-config.mjs';
import { errorMessage, isMainModule } from '../helpers/runtime.mjs';
import { extensionIdentitySchema } from './contracts.mjs';
import { installationStateSchema, installArgumentsSchema } from './bundle-contracts.mjs';
import { verifyBundle } from './verification.mjs';
import { installationDataHome } from './data-home.mjs';
import { installTerminalCommand } from './terminal-command.mjs';
import { prepareRelease } from './releases.mjs';
import { canonicalDestination, inside, rejectLinks } from './files.mjs';
import { acquireInstallationLock } from './lock.mjs';
import { establishOwnership, inspectOwnership } from './ownership.mjs';
import {
  cliLauncherSource,
  launcherSource,
  registrationManifest,
  registrationPaths,
} from './registration.mjs';

export function parseInstallArguments(args) {
  const options = { chromium: false, help: false, destination: undefined };
  const parsed = installArgumentsSchema.safeParse(args);

  if (!parsed.success) {
    throw new Error('Usage: Install Miter.command [--destination=PATH] [--chromium]', {
      cause: parsed.error,
    });
  }

  for (const argument of parsed.data) {
    if (argument === '--chromium') {
      options.chromium = true;
    } else if (argument === '--help') {
      options.help = true;
    } else {
      options.destination = path.resolve(argument.slice(14));
    }
  }

  return options;
}

async function managedDestination(destination, source, identity) {
  // Check the final component before realpath can hide a destination symlink.
  await rejectLinks(destination, path.dirname(destination));
  destination = await canonicalDestination(destination);

  if (inside(destination, source) || inside(source, destination)) {
    throw new Error('The installation destination and bundle must be separate directories.');
  }

  await inspectOwnership(destination, identity);

  return destination;
}

/** Only unpublished mkdtemp directories belong to this recovery path. Published
 * releases have digest names and may still serve a running host.
 */
async function removeInterruptedCopies(releases, destination) {
  for (const name of await readdir(releases)) {
    if (!/^\.installing-[A-Za-z0-9]{6}$/.test(name)) {
      continue;
    }

    const directory = path.join(releases, name);

    await rejectLinks(directory, destination);
    const stat = await lstat(directory);

    if (stat.isDirectory()) {
      await rm(directory, { recursive: true });
    }
  }
}

/** Install only verified local bytes. User databases and running processes are untouched. */
export async function installLocalBundle({
  bundle,
  destination,
  chromium = false,
  home = os.homedir(),
  dataHome = process.env.MITTER_HOME,
  manifestDirectory,
}) {
  bundle = await canonicalDestination(bundle);
  const { manifest, release } = await verifyBundle(bundle);
  const identity = extensionIdentitySchema.parse(
    JSON.parse(await readFile(path.join(bundle, 'brand/extension-identity.json'), 'utf8')),
  );

  destination ??= path.join(home, 'Library/Application Support/Miter');
  destination = await managedDestination(path.resolve(destination), bundle, identity);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const lock = await acquireInstallationLock(destination);

  try {
    // Recheck ownership under the lock: another installer may have won while
    // this process was validating an initially empty destination.
    await managedDestination(destination, bundle, identity);
    await establishOwnership(destination, identity);
    let browser = 'chrome';

    if (chromium) {
      browser = 'chromium';
    }

    const existingPaths = registrationPaths({
      platform: 'darwin',
      root: bundle,
      home,
      manifestDirectory,
      browser,
      nativeHost: identity.nativeHost,
    });
    dataHome = await installationDataHome({
      destination,
      manifestPath: existingPaths.manifestPath,
      identity,
      dataHome,
    });
    const releases = path.join(destination, 'releases');

    await rejectLinks(releases, destination);
    await mkdir(releases, { recursive: true, mode: 0o700 });
    await removeInterruptedCopies(releases, destination);
    const prepared = await prepareRelease({ bundle, destination, release });
    const releaseRoot = prepared.root;

    const paths = registrationPaths({
      platform: 'darwin',
      root: releaseRoot,
      home,
      dataHome,
      manifestDirectory,
      browser,
      nativeHost: identity.nativeHost,
    });
    const launcher = path.join(destination, 'bin/miter-host');
    const command = path.join(destination, 'bin/miter');
    const extension = path.join(destination, 'extension');
    const marker = path.join(destination, 'installation.json');
    const writes = [];

    // Keep previous hashed assets available to tabs still running the old release.
    // New entries and the manifest are replaced atomically; Chrome reload stays explicit.
    for (const entry of manifest.files) {
      const prefix = 'apps/extension/.output/chrome-mv3/';

      if (!entry.path.startsWith(prefix)) {
        continue;
      }

      if (!('sha256' in entry)) {
        throw new Error('Extension assets may not be symbolic links.');
      }

      writes.push({
        file: path.join(extension, entry.path.slice(prefix.length)),
        source: path.join(releaseRoot, entry.path),
        mode: entry.mode,
      });
    }

    writes.sort((left, right) => {
      return Number(left.file.endsWith('/manifest.json')) - Number(right.file.endsWith('/manifest.json'));
    });

    for (const item of [...writes, { file: launcher }, { file: command }, { file: marker }]) {
      await rejectLinks(item.file, destination);
      await mkdir(path.dirname(item.file), { recursive: true, mode: 0o700 });
    }

    const manifestParent = path.dirname(paths.manifestDirectory);

    await rejectLinks(paths.manifestPath, manifestParent);
    await mkdir(paths.manifestDirectory, { recursive: true, mode: 0o700 });
    await configTransaction(
      [
        ...writes.map((item) => {
          return item.file;
        }),
        launcher,
        command,
        paths.manifestPath,
        marker,
      ],
      async () => {
        for (const item of writes) {
          await atomicConfig(item.file, await readFile(item.source), item.mode);
        }

        const source = launcherSource({
          ...paths,
          platform: 'darwin',
          nodeExecutable: path.join(releaseRoot, 'runtime/node'),
          root: releaseRoot,
          portable: false,
        });

        await atomicConfig(launcher, source, 0o700);
        await atomicConfig(
          command,
          cliLauncherSource({
            platform: 'darwin',
            nodeExecutable: path.join(releaseRoot, 'runtime/node'),
            cliScript: path.join(releaseRoot, 'dist/apps/host/src/cli.js'),
            dataDirectory: paths.dataDirectory,
            uninstall: {
              script: path.join(releaseRoot, 'scripts/installation/uninstall.mjs'),
              home,
              manifestPath: paths.manifestPath,
            },
          }),
          0o700,
        );
        await atomicConfig(
          paths.manifestPath,
          JSON.stringify(registrationManifest(identity, launcher), null, 2) + '\n',
          0o600,
        );
        const state = installationStateSchema.parse({
          format: 1,
          release,
          repairId: prepared.repairId,
          version: manifest.version,
          extensionId: identity.extensionId,
        });

        await atomicConfig(marker, JSON.stringify(state, null, 2) + '\n', 0o600);
      },
    );

    const terminal = await installTerminalCommand({ home, command });
    return { destination, extension, command, terminal, release: releaseRoot, manifest: paths.manifestPath };
  } finally {
    await lock.close();
  }
}

export function printInstalled(result) {
  console.log('Miter installed: ' + result.destination);
  console.log('Terminal command: ' + result.command);
  console.log(result.terminal.detail);
  console.log('First install: Chrome → Extensions → Developer mode → Load unpacked:');
  console.log(result.extension);
  console.log(
    'Already loaded from this managed extension folder: reload Miter on chrome://extensions, then close and reopen its workspace tab.',
  );
  console.log(
    'Source migration: keep the checkout and existing extension without uninstalling; see scripts/installation/README.md because Reload keeps the current path.',
  );
  console.log('Keep the managed installation folder. The installer bundle can be moved or removed.');
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseInstallArguments(process.argv.slice(2));

    if (options.help) {
      console.log('Install or update Miter: Install Miter.command [--destination=PATH] [--chromium]');
    } else {
      const result = await installLocalBundle({
        ...options,
        bundle: path.resolve(import.meta.dirname, '../..'),
      });

      printInstalled(result);
    }
  } catch (error) {
    console.error('Installation stopped: ' + errorMessage(error));
    process.exitCode = 1;
  }
}
