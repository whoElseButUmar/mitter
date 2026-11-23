import { lstat, mkdtemp, readFile, readdir, readlink, rename, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { errorMessage, hasErrorCode, isMainModule } from '../helpers/runtime.mjs';
import { installationStateSchema } from './bundle-contracts.mjs';
import { extensionIdentitySchema, nativeManifestSchema } from './contracts.mjs';
import { canonicalDestination, inside, rejectLinks } from './files.mjs';
import { registeredLauncherDetails } from './launcher-check.mjs';
import { acquireInstallationLock, installationLockName } from './lock.mjs';
import { inspectOwnership } from './ownership.mjs';
import { registrationPaths } from './registration.mjs';
import { releaseDirectoryName } from './releases.mjs';
import { withUninstallState, uninstallStatePaths } from './uninstall-state.mjs';

const usage = 'Usage: miter uninstall [--purge] [--dry-run]';
const chromeHelp = 'Remove Miter at chrome://extensions in each Chrome profile where you loaded it.';
const uninstallArgumentsSchema = z
  .array(z.enum(['--purge', '--dry-run', '--help']).describe('A supported uninstall option.'))
  .refine((args) => new Set(args).size === args.length)
  .describe('Uninstall flags. Each flag can appear once.');

export function parseUninstallArguments(args) {
  const parsed = uninstallArgumentsSchema.safeParse(args);

  if (!parsed.success) {
    throw new Error(usage, { cause: parsed.error });
  }

  return {
    purge: args.includes('--purge'),
    dryRun: args.includes('--dry-run'),
    help: args.includes('--help'),
  };
}

const managedEntries = new Set([
  '.DS_Store',
  '.miter-installation.json',
  installationLockName,
  'installation.json',
  'bin',
  'extension',
  'releases',
]);

async function entryInfo(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return undefined;
  }
}

async function readMetadata(file, required = true) {
  const stat = await entryInfo(file);

  if (!stat?.isFile() || stat.nlink !== 1 || stat.size > 65536) {
    if (required) {
      throw new Error('Cannot verify the Miter file at ' + file);
    }

    return undefined;
  }

  return readFile(file, 'utf8');
}

async function matchesRegistration(file, identity, launcher) {
  const serialized = await readMetadata(file, false);

  if (serialized === undefined) {
    return false;
  }

  let manifest;

  try {
    manifest = nativeManifestSchema.safeParse(JSON.parse(serialized));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    return false;
  }

  return (
    manifest.success &&
    manifest.data.name === identity.nativeHost &&
    manifest.data.path === launcher &&
    manifest.data.allowed_origins[0] === `chrome-extension://${identity.extensionId}/`
  );
}

async function matchesShortcut(shortcut, home, command) {
  const stat = await entryInfo(shortcut);

  if (stat?.isSymbolicLink() !== true || stat.uid !== process.getuid()) {
    return false;
  }

  const parent = await canonicalDestination(path.dirname(shortcut));
  const expected = path.join(await canonicalDestination(home), '.local/bin');
  return parent === expected && (await readlink(shortcut)) === command;
}

async function removalPlan({ release, home, manifestPath, purge }) {
  const destination = path.dirname(path.dirname(release));
  const releases = path.join(destination, 'releases');

  if (path.dirname(release) !== releases || (await canonicalDestination(destination)) !== destination) {
    throw new Error('Run the uninstall command from a managed Miter installation.');
  }

  await rejectLinks(release, destination);
  const identity = extensionIdentitySchema.parse(
    JSON.parse(await readMetadata(path.join(release, 'brand/extension-identity.json'))),
  );
  const ownership = await inspectOwnership(destination, identity);

  if (ownership.kind !== 'owner' && ownership.kind !== 'state') {
    throw new Error('Could not verify the managed Miter installation.');
  }

  const state = installationStateSchema.parse(
    JSON.parse(await readMetadata(path.join(destination, 'installation.json'))),
  );
  const launcher = path.join(destination, 'bin/miter-host');

  await rejectLinks(launcher, destination);
  const details = registeredLauncherDetails(await readMetadata(launcher));

  if (
    state.extensionId !== identity.extensionId ||
    path.join(releases, releaseDirectoryName(state)) !== release ||
    details.root !== release ||
    details.nodeExecutable !== path.join(release, 'runtime/node')
  ) {
    throw new Error('This Miter command is stale. Use the current managed installation.');
  }

  const data = await canonicalDestination(details.dataDirectory);
  const workingDirectory = await canonicalDestination(process.cwd());

  if (inside(destination, data) || inside(destination, workingDirectory)) {
    throw new Error(
      'Move outside the Miter installation and keep its data folder separate before uninstalling.',
    );
  }

  for (const name of await readdir(destination)) {
    if (!managedEntries.has(name)) {
      throw new Error(
        'Move the unrecognized item out of the Miter installation first: ' + path.join(destination, name),
      );
    }
  }

  const manifestCandidates = new Set([manifestPath]);

  for (const browser of ['chrome', 'chromium']) {
    manifestCandidates.add(
      registrationPaths({
        platform: 'darwin',
        home,
        browser,
        root: release,
        nativeHost: identity.nativeHost,
      }).manifestPath,
    );
  }

  const manifests = [];

  for (const file of manifestCandidates) {
    if (await matchesRegistration(file, identity, launcher)) {
      const parent = await canonicalDestination(path.dirname(file));

      manifests.push(path.join(parent, path.basename(file)));
    }
  }

  const command = path.join(destination, 'bin/miter');
  const shortcut = path.join(home, '.local/bin/miter');
  const links = [];

  if (await matchesShortcut(shortcut, home, command)) {
    links.push(shortcut);
  }

  const statePaths = await uninstallStatePaths(details.dataDirectory, home, purge);

  return {
    destination,
    identity,
    launcher,
    command,
    manifests: [...new Set(manifests)],
    links,
    data,
    statePaths,
  };
}

async function retireInstallation(destination) {
  const retired = await mkdtemp(path.join(path.dirname(destination), '.miter-uninstall-'));

  try {
    // Retire the lock with its directory. An installer can then open a fresh lock
    // without sharing a path with the cleanup of this release.
    await rename(destination, path.join(retired, 'installation'));
  } catch (error) {
    await rmdir(retired);
    throw error;
  }

  try {
    await rm(retired, { recursive: true });
  } catch (error) {
    throw new Error('Miter was disconnected. Finish removing its files at ' + retired, { cause: error });
  }
}

export async function uninstallManaged(options, { output, confirm }) {
  const plan = await removalPlan(options);
  const paths = [plan.destination, ...plan.manifests, ...plan.links, ...plan.statePaths];

  output('Miter will remove these paths:');
  for (const file of paths) {
    output('  ' + file);
  }

  if (options.purge) {
    output('Purge permanently deletes tasks, settings, backups and saved preview data in the listed paths.');
    output('Project folders and isolated worktrees are preserved.');
  }

  if (options.dryRun) {
    output('Dry run. ' + chromeHelp);
    return;
  }

  if (options.purge && (await confirm()) !== 'PURGE') {
    output('Uninstall canceled.');
    return;
  }

  const lock = await acquireInstallationLock(plan.destination);

  try {
    const current = await removalPlan(options);

    if (JSON.stringify(current) !== JSON.stringify(plan)) {
      throw new Error('The installation changed. Review the new removal plan by running the command again.');
    }

    await withUninstallState(plan, options.purge, async () => {
      for (const file of plan.manifests) {
        if (await matchesRegistration(file, plan.identity, plan.launcher)) {
          await unlink(file);
        }
      }

      for (const file of plan.links) {
        if (await matchesShortcut(file, options.home, plan.command)) {
          await unlink(file);
        }
      }

      await retireInstallation(plan.destination);
    });
  } finally {
    await lock.close();
  }

  output('Miter’s local installation was removed. ' + chromeHelp);
}

async function confirmPurge() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run purge from an interactive terminal so you can confirm the deletion.');
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return await terminal.question('Type PURGE to permanently delete the listed data: ');
  } finally {
    terminal.close();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const [home, manifestPath, ...args] = process.argv.slice(2);
    const options = parseUninstallArguments(args);

    if (options.help) {
      console.log(usage);
      console.log('--purge also deletes saved local Miter data. --dry-run lists the paths only.');
    } else {
      await uninstallManaged(
        { ...options, release: path.resolve(import.meta.dirname, '../..'), home, manifestPath },
        { output: console.log, confirm: confirmPurge },
      );
    }
  } catch (error) {
    console.error('Uninstall stopped: ' + errorMessage(error));
    process.exitCode = 1;
  }
}
