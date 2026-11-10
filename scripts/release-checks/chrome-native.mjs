import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extensionIdentitySchema, nativeManifestSchema } from '../installation/contracts.mjs';
import { quotePosix } from '../installation/registration.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const nativeHost = 'ai.mitter.host';
const smokeManifestSchema = nativeManifestSchema
  .extend({
    name: nativeManifestSchema.shape.name
      .refine((name) => name === nativeHost)
      .describe('The Miter host exercised by the live release check.'),
    path: nativeManifestSchema.shape.path
      .refine((filename) => path.isAbsolute(filename) && !filename.includes('\0'))
      .describe('The absolute executable launcher path inside the owned temporary tree.'),
  })
  .describe('A temporary stdio registration allowing only the extension ID returned by Chrome CDP.');

function systemManifestPaths(platform) {
  // DIR_NATIVE_MESSAGING in the official Chromium source:
  // https://chromium.googlesource.com/chromium/src/+/main/chrome/common/chrome_paths.cc
  // CHROME_PATH does not prove branding, so check every supported branding instead of guessing.
  let directories;

  if (platform === 'darwin') {
    directories = [
      '/Library/Google/Chrome/NativeMessagingHosts',
      '/Library/Google/ChromeForTesting/NativeMessagingHosts',
      '/Library/Application Support/Chromium/NativeMessagingHosts',
    ];
  } else if (platform === 'linux') {
    directories = [
      '/etc/opt/chrome/native-messaging-hosts',
      '/etc/opt/chrome_for_testing/native-messaging-hosts',
      '/etc/chromium/native-messaging-hosts',
    ];
  } else {
    throw new Error(
      'Chrome native smoke checks support only macOS and Linux; unsupported platform: ' + platform,
    );
  }

  return directories.map((directory) => path.join(directory, nativeHost + '.json'));
}

function missing(error) {
  return error instanceof Error && error.code === 'ENOENT';
}

/** Await BEFORE constructing ChromePipe. inspect is a read-only lstat seam for fixture tests. */
export async function assertNoSystemHost({ platform = process.platform, inspect = lstat } = {}) {
  for (const filename of systemManifestPaths(platform)) {
    try {
      // Do not follow the final symlink: even a dangling registration is unsafe.
      await inspect(filename);
    } catch (error) {
      if (missing(error)) {
        continue;
      }

      throw new Error(
        'Cannot prove Chrome native messaging isolation: unable to inspect ' +
          filename +
          '. Use a machine where the system registration paths can be checked before launching Chrome.',
        { cause: error },
      );
    }

    throw new Error(
      'Chrome native messaging isolation is unsafe: system registration exists at ' +
        filename +
        '. A system host can be selected instead of the temporary HOME/profile host, and managed ' +
        'NativeMessagingUserLevelHosts policy can disable user hosts. Run this check on a machine without ' +
        'system ai.mitter.host registrations. Nothing was changed.',
    );
  }
}

function strictChild(relative) {
  return relative !== '' && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
}

/** Read-only validation of a caller-owned temporary root; returns its canonical absolute path. */
export async function ownedTemporaryDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) {
    throw new Error('Native fixture directory must be an absolute, caller-owned mkdtemp directory.');
  }

  const temporaryRoot = path.resolve(os.tmpdir());
  const canonicalTemporaryRoot = await realpath(temporaryRoot);
  const requested = path.resolve(directory);
  let relative = path.relative(temporaryRoot, requested);

  if (!strictChild(relative)) {
    // macOS may expose the same temporary root through /var and /private/var.
    relative = path.relative(canonicalTemporaryRoot, requested);
  }

  if (!strictChild(relative)) {
    throw new Error('Native fixture directory must be strictly inside the system temporary directory.');
  }

  let canonical = canonicalTemporaryRoot;

  // Walk from the canonical temporary root so no symlinked ancestor can even
  // cause a metadata read in a real HOME or another tree outside the fixture.
  for (const component of relative.split(path.sep)) {
    canonical = path.join(canonical, component);

    if (!(await existingDirectory(canonical))) {
      throw new Error(
        'Native fixture directory does not exist: ' + directory + '. Create it with mkdtemp first.',
      );
    }
  }

  return canonical;
}

async function existingDirectory(filename) {
  let identity;

  try {
    identity = await lstat(filename);
  } catch (error) {
    if (missing(error)) {
      return false;
    }

    throw error;
  }

  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    identity.uid !== process.getuid() ||
    (identity.mode & 0o022) !== 0
  ) {
    throw new Error(
      'Unsafe native fixture path: ' +
        filename +
        '. Refusing a symlink, unowned or group/world-writable directory.',
    );
  }

  return true;
}

async function assertNewFile(filename) {
  try {
    await lstat(filename);
  } catch (error) {
    if (missing(error)) {
      return;
    }

    throw error;
  }

  throw new Error('Native fixture file already exists: ' + filename + '. Use a fresh temporary tree.');
}

/**
 * Call AFTER Extensions.loadUnpacked returns its ID, before opening native-connected UI.
 * directory is the caller's disposable mkdtemp tree; the caller owns cleanup.
 * platform/nodeExecutable/hostScript overrides let source-only tests use a harmless temporary host entry.
 * Explicit hostScript overrides must still be absolute, regular, readable files.
 */
export async function installNativeHost(
  directory,
  extensionId,
  {
    platform = process.platform,
    nodeExecutable = process.execPath,
    hostScript = path.join(root, 'dist/apps/host/src/native.js'),
  } = {},
) {
  systemManifestPaths(platform);
  const parsedId = extensionIdentitySchema.shape.extensionId.safeParse(extensionId);

  if (!parsedId.success) {
    throw new Error('Native fixture needs the 32-letter extension ID returned by Chrome CDP.', {
      cause: parsedId.error,
    });
  }

  if (
    typeof nodeExecutable !== 'string' ||
    !path.isAbsolute(nodeExecutable) ||
    nodeExecutable.includes('\0')
  ) {
    throw new Error('Native fixture Node executable must be an absolute path.');
  }

  if (typeof hostScript !== 'string' || !path.isAbsolute(hostScript) || hostScript.includes('\0')) {
    throw new Error('Native fixture host entry must be an absolute path without NUL characters.');
  }

  try {
    const identity = await lstat(hostScript);

    if (!identity.isFile()) {
      throw new Error('Native host entry must be a regular file, not a symlink.');
    }

    // A privileged runner must not silently accept an entry with no read permissions.
    if ((identity.mode & 0o444) === 0) {
      throw new Error('Native host entry has no read permission bits.');
    }

    await access(hostScript, constants.R_OK);
    await access(nodeExecutable, constants.X_OK);
  } catch (error) {
    throw new Error(
      'Native fixture needs a readable regular host entry at ' +
        hostScript +
        ' and executable Node. Run pnpm build for the default entry or provide valid fixture overrides.',
      {
        cause: error,
      },
    );
  }

  const fixture = await ownedTemporaryDirectory(directory);
  const home = path.join(fixture, 'home');
  const state = path.join(fixture, 'state');
  const project = path.join(fixture, 'project');
  const native = path.join(fixture, 'native');
  const profile = path.join(fixture, 'profile');
  // DIR_USER_NATIVE_MESSAGING appends this to DIR_USER_DATA, not to HOME or Default.
  const manifestDirectory = path.join(profile, 'NativeMessagingHosts');
  const launcher = path.join(native, 'mitter-host');
  const manifestPath = path.join(manifestDirectory, nativeHost + '.json');
  const directories = [home, state, project, native, profile, manifestDirectory];
  const missingDirectories = [];

  // Validate every existing parent before creating anything or examining its children.
  for (const filename of directories) {
    if (!(await existingDirectory(filename))) {
      missingDirectories.push(filename);
    }
  }

  await assertNewFile(launcher);
  await assertNewFile(manifestPath);
  const manifest = smokeManifestSchema.parse({
    name: nativeHost,
    description: 'Miter local project host',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${parsedId.data}/`],
  });
  const source =
    '#!/bin/sh\n' +
    `export HOME=${quotePosix(home)}\n` +
    `export USERPROFILE=${quotePosix(home)}\n` +
    `export MITTER_HOME=${quotePosix(state)}\n` +
    `export XDG_CONFIG_HOME=${quotePosix(path.join(home, '.config'))}\n` +
    `export XDG_CACHE_HOME=${quotePosix(path.join(home, '.cache'))}\n` +
    `export XDG_DATA_HOME=${quotePosix(path.join(home, '.local/share'))}\n` +
    `export XDG_STATE_HOME=${quotePosix(path.join(home, '.local/state'))}\n` +
    'unset NODE_OPTIONS NODE_PATH\n' +
    `cd ${quotePosix(fixture)} || exit 1\n` +
    `exec ${quotePosix(nodeExecutable)} ${quotePosix(hostScript)} "$@"\n`;

  for (const filename of missingDirectories) {
    await mkdir(filename, { mode: 0o700 });
  }

  // Exclusive creates also refuse dangling file symlinks; never replace caller-owned bytes.
  await writeFile(launcher, source, { flag: 'wx', mode: 0o700 });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

  return { profile, manifestDirectory, manifestPath, launcher, home, state, project, hostScript };
}
