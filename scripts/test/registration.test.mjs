import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  launcherSource,
  parseRegistrationArguments,
  quotePosix,
  registrationManifest,
  registrationPaths,
  registryArguments,
} from '../installation/registration.mjs';
import {
  extensionIdentitySchema,
  installedPackageSchema,
  nativeManifestSchema,
} from '../installation/contracts.mjs';

const identity = {
  name: 'Mitter',
  key: 'YWJj',
  extensionId: 'mclgchkiejnomabbnglaodgnmfhhipep',
  nativeHost: 'ai.mitter.host',
};

function pathsFor(platform, browser = 'chrome', overrides = {}) {
  let home = '/home/test';
  let root = '/installation';

  if (platform === 'win32') {
    home = 'C:\\Users\\test';
    root = 'C:\\Mitter';
  }

  return registrationPaths({
    platform,
    browser,
    home,
    root,
    nativeHost: identity.nativeHost,
    ...overrides,
  });
}

test('registration arguments preserve valid options and reject ignored or ambiguous arguments', () => {
  assert.deepEqual(parseRegistrationArguments([]), {
    browser: 'chrome',
    portable: false,
    remove: false,
    help: false,
    manifestDirectory: undefined,
  });
  assert.deepEqual(
    parseRegistrationArguments(['--chrome', '--chromium', '--portable', '--remove', '--manifest-dir=/first']),
    {
      browser: 'chromium',
      portable: true,
      remove: true,
      help: false,
      manifestDirectory: '/first',
    },
  );
  assert.equal(parseRegistrationArguments(['--help']).help, true);
  for (const args of [
    ['--unrecognized'],
    ['--dry-run'],
    ['--remove', '--remove'],
    ['--manifest-dir='],
    ['--manifest-dir=   '],
    ['--manifest-dir=/unsafe\0/path'],
    ['--manifest-dir=/first', '--manifest-dir=/second'],
    ['--help', '--unknown'],
  ]) {
    assert.throws(() => parseRegistrationArguments(args), /Usage:/);
  }
});

test('registration removal, rejected flags and unbuilt installs do not create state directories', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mitter-registration-cli-'));
  const repositoryRoot = path.resolve(import.meta.dirname, '../..');

  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await symlink(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');

  for (const filename of [
    'register-host.mjs',
    'atomic-config.mjs',
    'verify-build.mjs',
    'prepare-font.mjs',
    'check-security-policy.mjs',
    'check-bundle-imports.mjs',
    'module-imports.mjs',
    'build/contracts.mjs',
    'fonts/contracts.mjs',
    'installation/registration.mjs',
    'installation/contracts.mjs',
    'installation/bootstrap.mjs',
    'helpers/runtime.mjs',
  ]) {
    const target = path.join(root, 'scripts', filename);

    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(repositoryRoot, 'scripts', filename), target);
  }

  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0-rc.21' }));
  await mkdir(path.join(root, 'brand'));
  await writeFile(path.join(root, 'brand/extension-identity.json'), JSON.stringify(identity));
  const before = await readdir(root);

  for (const option of ['--remove', '--dry-run', '--portable']) {
    const result = spawnSync(
      process.execPath,
      ['scripts/register-host.mjs', option, '--manifest-dir=' + path.join(root, 'manifests')],
      {
        cwd: root,
        env: { ...process.env, MITTER_HOME: path.join(root, 'state') },
        encoding: 'utf8',
        timeout: 10000,
        shell: false,
      },
    );

    assert.equal(result.error, undefined);

    if (option === '--remove') {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Removed ai.mitter.host/);
    } else {
      assert.equal(result.status, 1);

      if (option === '--dry-run') {
        assert.match(result.stderr, /Usage:/);
      } else {
        assert.match(
          result.stderr,
          /Host registration stopped: Build verification failed before registration/,
        );
        assert.match(result.stderr, /Run pnpm build/);
      }
    }

    assert.deepEqual(await readdir(root), before);
    await assert.rejects(access(path.join(root, 'state')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(root, 'manifests')), { code: 'ENOENT' });
  }
});

test('registration uses the exact per-browser OS manifest paths', () => {
  assert.equal(
    pathsFor('darwin').manifestDirectory,
    '/home/test/Library/Application Support/Google/Chrome/NativeMessagingHosts',
  );
  assert.equal(
    pathsFor('darwin', 'chromium').manifestDirectory,
    '/home/test/Library/Application Support/Chromium/NativeMessagingHosts',
  );
  assert.equal(pathsFor('linux').manifestDirectory, '/home/test/.config/google-chrome/NativeMessagingHosts');
  assert.equal(
    pathsFor('linux', 'chromium', { xdgConfigHome: '/custom/config' }).manifestDirectory,
    '/custom/config/chromium/NativeMessagingHosts',
  );
  assert.equal(pathsFor('win32').manifestPath, 'C:\\Users\\test\\.mitter\\native\\ai.mitter.host.json');
  assert.equal(pathsFor('win32').launcher, 'C:\\Users\\test\\.mitter\\native\\mitter-host.cmd');
  assert.equal(
    pathsFor('darwin', 'chrome', {
      dataHome: '/private/state',
      manifestDirectory: '/custom/manifests',
    }).launcher,
    '/private/state/native/mitter-host',
  );
  assert.equal(
    pathsFor('linux', 'chrome', { manifestDirectory: '' }).manifestDirectory,
    '/home/test/.config/google-chrome/NativeMessagingHosts',
  );
});

test('POSIX launcher preserves exact quoting, argument forwarding and portable flag spacing', () => {
  assert.equal(quotePosix("one'two"), "'one'\\''two'");
  const source = launcherSource({
    platform: 'darwin',
    nodeExecutable: '/node bin/node',
    hostScript: "/host's/native.js",
    dataDirectory: '/private/state',
    root: '/root folder',
    portable: true,
  });

  assert.equal(
    source,
    '#!/bin/sh\n' +
      "export MITTER_HOME='/private/state'\n" +
      "cd '/root folder' || exit 1\n" +
      "exec '/node bin/node' '/host'\\''s/native.js' --portable \"$@\"\n",
  );
  assert.equal(
    launcherSource({
      platform: 'linux',
      nodeExecutable: '/node',
      hostScript: '/native.js',
      dataDirectory: '/state',
      root: '/root',
      portable: false,
    }),
    "#!/bin/sh\nexport MITTER_HOME='/state'\ncd '/root' || exit 1\n" + "exec '/node' '/native.js' \"$@\"\n",
  );
});

test('Windows launcher preserves CRLF, quoting and forwarding while refusing unsafe paths', () => {
  const options = {
    platform: 'win32',
    nodeExecutable: 'C:\\Node Folder\\node.exe',
    hostScript: 'C:\\Mitter\\native.js',
    dataDirectory: 'C:\\Private State',
    root: 'C:\\Mitter',
    portable: false,
  };

  assert.equal(
    launcherSource(options),
    '@echo off\r\nset "MITTER_HOME=C:\\Private State"\r\n' +
      'cd /d "C:\\Mitter" || exit /b 1\r\n"C:\\Node Folder\\node.exe" "C:\\Mitter\\native.js" %*\r\n',
  );
  assert.match(launcherSource({ ...options, portable: true }), / --portable %\*\r\n$/);

  for (const property of ['nodeExecutable', 'hostScript', 'dataDirectory', 'root']) {
    for (const unsafeCharacter of ['%', '"', '\r', '\n']) {
      assert.throws(() => {
        launcherSource({ ...options, [property]: 'unsafe' + unsafeCharacter });
      }, /without %, quotes, or newlines/);
    }
  }
});

test('Windows registry arguments are HKCU-only and preserve add/delete flags', () => {
  assert.deepEqual(registryArguments('chrome', identity.nativeHost, 'C:\\manifest.json', false), [
    'add',
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\ai.mitter.host',
    '/ve',
    '/t',
    'REG_SZ',
    '/d',
    'C:\\manifest.json',
    '/f',
  ]);
  assert.deepEqual(registryArguments('chromium', identity.nativeHost, 'C:\\manifest.json', true), [
    'delete',
    'HKCU\\Software\\Chromium\\NativeMessagingHosts\\ai.mitter.host',
    '/f',
  ]);
});

test('identity and native manifest schemas reject unsafe or broadened registration contracts', () => {
  const manifest = registrationManifest(identity, '/private/native/mitter-host');

  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${identity.extensionId}/`]);
  assert.equal(manifest.type, 'stdio');

  for (const nativeHost of ['../host', 'host/name', '.host', 'host.', 'HOST']) {
    assert.equal(extensionIdentitySchema.safeParse({ ...identity, nativeHost }).success, false);
  }

  assert.equal(extensionIdentitySchema.safeParse({ ...identity, extensionId: 'not-an-id' }).success, false);
  assert.equal(extensionIdentitySchema.safeParse({ ...identity, key: '' }).success, false);
  assert.equal(nativeManifestSchema.safeParse({ ...manifest, allowed_origins: ['*'] }).success, false);
  assert.equal(nativeManifestSchema.safeParse({ ...manifest, type: 'shell' }).success, false);
  assert.equal(nativeManifestSchema.safeParse({ ...manifest, extra: true }).success, false);
  assert.equal(nativeManifestSchema.safeParse({ ...manifest, path: '/native\0/host' }).success, false);
  assert.equal(typeof extensionIdentitySchema.description, 'string');
  assert.equal(typeof nativeManifestSchema.description, 'string');
});

test('installed metadata describes and validates the fields used by scripts', () => {
  const project = {
    name: 'mitter',
    version: '1.0.0-rc.21',
    packageManager: 'pnpm@12.10.1',
    mitter: { modelRuntimes: { 'node-llama-cpp': '3.22.1' } },
    scripts: { unrelated: 'ignored' },
  };

  assert.equal(installedPackageSchema.parse(project).version, project.version);
  assert.equal(installedPackageSchema.safeParse({ ...project, version: 1 }).success, false);
  const unpinnedManager = installedPackageSchema.safeParse({
    ...project,
    packageManager: 'pnpm@latest',
  });

  assert.equal(unpinnedManager.success, false);
  const invalidRuntimes = installedPackageSchema.safeParse({
    ...project,
    mitter: { modelRuntimes: [] },
  });

  assert.equal(invalidRuntimes.success, false);
  assert.equal(typeof installedPackageSchema.description, 'string');
});
