import path from 'node:path';
import { extensionIdentitySchema, nativeManifestSchema, registrationArgumentsSchema } from './contracts.mjs';

export function parseRegistrationArguments(args) {
  const parsed = registrationArgumentsSchema.safeParse(args);

  if (!parsed.success) {
    throw new Error(
      'Usage: node scripts/register-host.mjs [--chromium] [--portable] [--remove] [--manifest-dir=PATH]',
      { cause: parsed.error },
    );
  }

  args = parsed.data;
  const manifestArguments = args.filter((argument) => {
    return argument.startsWith('--manifest-dir=');
  });
  let browser = 'chrome';

  if (args.includes('--chromium')) {
    browser = 'chromium';
  }

  const [manifestArgument] = manifestArguments;
  let manifestDirectory;

  if (manifestArgument !== undefined) {
    manifestDirectory = manifestArgument.slice('--manifest-dir='.length);
  }

  return {
    browser,
    portable: args.includes('--portable'),
    remove: args.includes('--remove'),
    help: args.includes('--help'),
    manifestDirectory,
  };
}

export function registrationPaths(options) {
  const { platform, home, root, browser, nativeHost, manifestDirectory } = options;
  let paths = path.posix;

  if (platform === 'win32') {
    paths = path.win32;
  }

  const dataDirectory = paths.resolve(options.dataHome || paths.join(home, '.mitter'));
  const installDirectory = paths.join(dataDirectory, 'native');
  let launcherName = 'mitter-host';

  if (platform === 'win32') {
    launcherName = 'mitter-host.cmd';
  }

  const launcher = paths.join(installDirectory, launcherName);
  const hostScript = paths.join(root, 'dist/apps/host/src/native.js');
  let manifestRoot;

  if (manifestDirectory) {
    manifestRoot = paths.resolve(manifestDirectory);
  } else if (platform === 'darwin') {
    let browserDirectory = 'Google/Chrome';

    if (browser === 'chromium') {
      browserDirectory = 'Chromium';
    }

    manifestRoot = paths.join(home, 'Library/Application Support', browserDirectory, 'NativeMessagingHosts');
  } else if (platform === 'win32') {
    manifestRoot = installDirectory;
  } else {
    const configHome = options.xdgConfigHome || paths.join(home, '.config');
    let browserDirectory = 'google-chrome';

    if (browser === 'chromium') {
      browserDirectory = 'chromium';
    }

    manifestRoot = paths.join(configHome, browserDirectory, 'NativeMessagingHosts');
  }

  return {
    dataDirectory,
    installDirectory,
    launcher,
    hostScript,
    manifestDirectory: manifestRoot,
    manifestPath: paths.join(manifestRoot, nativeHost + '.json'),
  };
}

export function quotePosix(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function launcherSource(options) {
  const { platform, nodeExecutable, hostScript, dataDirectory, root, portable } = options;
  let portableArgument = '';

  if (portable) {
    portableArgument = '--portable ';
  }

  if (platform === 'win32') {
    const installationPaths = nodeExecutable + hostScript + dataDirectory + root;

    if (/[\r\n%"]/.test(installationPaths)) {
      throw new Error('For Windows registration, use an installation path without %, quotes, or newlines.');
    }

    return (
      '@echo off\r\n' +
      `set "MITTER_HOME=${dataDirectory}"\r\n` +
      `cd /d "${root}" || exit /b 1\r\n` +
      `"${nodeExecutable}" "${hostScript}" ${portableArgument}%*\r\n`
    );
  }

  return (
    '#!/bin/sh\n' +
    `export MITTER_HOME=${quotePosix(dataDirectory)}\n` +
    `cd ${quotePosix(root)} || exit 1\n` +
    `exec ${quotePosix(nodeExecutable)} ${quotePosix(hostScript)} ${portableArgument}"$@"\n`
  );
}

/** The terminal client preserves cwd and literal arguments; it never launches a second host. */
export function cliLauncherSource({ platform, nodeExecutable, cliScript, dataDirectory, uninstall }) {
  if (platform === 'win32') {
    if (/[\r\n%"]/.test(nodeExecutable + cliScript + dataDirectory)) {
      throw new Error('For Windows registration, use an installation path without %, quotes, or newlines.');
    }

    return (
      '@echo off\r\n' + `set "MITTER_HOME=${dataDirectory}"\r\n` + `"${nodeExecutable}" "${cliScript}" %*\r\n`
    );
  }

  let maintenance = '';

  if (uninstall) {
    const command = [nodeExecutable, uninstall.script, uninstall.home, uninstall.manifestPath]
      .map(quotePosix)
      .join(' ');

    maintenance = `if [ "$1" = uninstall ]; then\n  shift\n  exec ${command} "$@"\nfi\n`;
  }

  return (
    '#!/bin/sh\n' +
    `export MITTER_HOME=${quotePosix(dataDirectory)}\n` +
    maintenance +
    `exec ${quotePosix(nodeExecutable)} ${quotePosix(cliScript)} "$@"\n`
  );
}

export function registrationManifest(identity, launcher) {
  const parsedIdentity = extensionIdentitySchema.parse(identity);

  return nativeManifestSchema.parse({
    name: parsedIdentity.nativeHost,
    description: 'Miter local project host',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${parsedIdentity.extensionId}/`],
  });
}

export function registryArguments(browser, nativeHost, manifestPath, remove) {
  let browserKey = 'Google\\Chrome';

  if (browser === 'chromium') {
    browserKey = 'Chromium';
  }

  const key = `HKCU\\Software\\${browserKey}\\NativeMessagingHosts\\${nativeHost}`;

  if (remove) {
    return ['delete', key, '/f'];
  }

  return ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'];
}
