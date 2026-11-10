import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { nativeManifestSchema } from '../installation/contracts.mjs';
import { quotePosix } from '../installation/registration.mjs';
import { assertNoSystemHost, installNativeHost, ownedTemporaryDirectory } from './chrome-native.mjs';

const launcherProbeSchema = z
  .strictObject({
    argv: z.array(z.string()).describe('The exact Chrome argv forwarded to the harmless fixture entry.'),
    cwd: z.string().min(1).describe('The launcher working directory.'),
    home: z.string().min(1).describe('The isolated HOME path.'),
    userprofile: z.string().min(1).describe('The isolated USERPROFILE path.'),
    state: z.string().min(1).describe('The isolated Miter state path.'),
    config: z.string().min(1).describe('The isolated XDG configuration path.'),
    cache: z.string().min(1).describe('The isolated XDG cache path.'),
    data: z.string().min(1).describe('The isolated XDG data path.'),
    xdgState: z.string().min(1).describe('The isolated XDG state path.'),
    nodeOptions: z.null().describe('The launcher clears inherited Node preload options.'),
    nodePath: z.null().describe('The launcher clears inherited module lookup paths.'),
  })
  .describe('The JSON recorded by the harmless launcher process, not a real native host.');

const extensionId = 'mclgchkiejnomabbnglaodgnmfhhipep';
const origin = `chrome-extension://${extensionId}/`;

// Exact DIR_NATIVE_MESSAGING paths from the official upstream source cited by chrome-native.mjs.
const systemPaths = {
  darwin: [
    '/Library/Google/Chrome/NativeMessagingHosts/ai.mitter.host.json',
    '/Library/Google/ChromeForTesting/NativeMessagingHosts/ai.mitter.host.json',
    '/Library/Application Support/Chromium/NativeMessagingHosts/ai.mitter.host.json',
  ],
  linux: [
    '/etc/opt/chrome/native-messaging-hosts/ai.mitter.host.json',
    '/etc/opt/chrome_for_testing/native-messaging-hosts/ai.mitter.host.json',
    '/etc/chromium/native-messaging-hosts/ai.mitter.host.json',
  ],
};

async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mitter-chrome-native-test-'));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function write(filename, source, mode = 0o600) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, source, { mode });
}

async function nativeFixture(context) {
  const directory = await fixture(context);
  const hostScript = path.join(await realpath(directory), "harmless host ' $HOME.js");
  await write(hostScript, 'process.exitCode = 0;\n');

  return {
    hostScript,
    install(directory, id, options = {}) {
      return installNativeHost(directory, id, { hostScript, ...options });
    },
  };
}

function isolatedInspection(directory, expected, seen) {
  return async (filename) => {
    assert.ok(expected.includes(filename), 'The preflight must use only verified system paths.');
    seen.push(filename);
    // Never inspect the real system's registrations, even on a developer machine.
    return lstat(path.join(directory, filename.slice(1)));
  };
}

test('preflight checks every verified system path without reading registrations or user state', async (context) => {
  const directory = await fixture(context);

  for (const [platform, expected] of Object.entries(systemPaths)) {
    const seen = [];
    await assertNoSystemHost({ platform, inspect: isolatedInspection(directory, expected, seen) });
    assert.deepEqual(seen, expected);
  }

  assert.deepEqual(await readdir(directory), []);
});

for (const [platform, expected] of Object.entries(systemPaths)) {
  test(`preflight refuses ${platform} system files, symlinks and dangling symlinks`, async (context) => {
    for (const filename of expected) {
      for (const kind of ['file', 'symlink', 'dangling symlink']) {
        await context.test(filename + ' (' + kind + ')', async (child) => {
          const directory = await fixture(child);
          const registration = path.join(directory, filename.slice(1));
          const target = path.join(directory, 'target');
          await mkdir(path.dirname(registration), { recursive: true, mode: 0o700 });

          if (kind === 'file') {
            await write(registration, 'Not even valid JSON: do not read or launch this registration.');
          } else {
            if (kind === 'symlink') {
              await write(target, 'Owned test target; never launch it.');
            }

            await symlink(target, registration);
          }

          const seen = [];
          await assert.rejects(
            assertNoSystemHost({ platform, inspect: isolatedInspection(directory, expected, seen) }),
            (error) => {
              assert.ok(error instanceof Error);
              assert.ok(error.message.includes(filename));
              assert.match(error.message, /system registration exists/);
              assert.match(error.message, /NativeMessagingUserLevelHosts/);
              assert.match(error.message, /Nothing was changed/);
              return true;
            },
          );
          assert.deepEqual(seen, expected.slice(0, expected.indexOf(filename) + 1));

          if (kind === 'file') {
            assert.equal(
              await readFile(registration, 'utf8'),
              'Not even valid JSON: do not read or launch this registration.',
            );
          } else {
            assert.equal(await readlink(registration), target);
          }
        });
      }
    }
  });
}

test('preflight fails closed on inspection errors and retains their cause', async () => {
  for (const code of ['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP']) {
    const failure = Object.assign(new Error('Owned simulated filesystem failure.'), { code });
    const seen = [];
    await assert.rejects(
      assertNoSystemHost({
        platform: 'linux',
        inspect: async (filename) => {
          seen.push(filename);
          throw failure;
        },
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, failure);
        assert.match(error.message, /Cannot prove Chrome native messaging isolation/);
        assert.ok(error.message.includes(systemPaths.linux[0]));
        assert.match(error.message, /before launching Chrome/);
        return true;
      },
    );
    assert.deepEqual(seen, [systemPaths.linux[0]]);
  }
});

test('unknown platforms fail before inspecting system paths or writing a fixture', async (context) => {
  const { install } = await nativeFixture(context);
  const directory = await fixture(context);

  for (const platform of ['win32', 'freebsd', 'android', '']) {
    await assert.rejects(
      assertNoSystemHost({
        platform,
        inspect: async () => {
          assert.fail('An unsupported platform must not inspect any registration.');
        },
      }),
      /support only macOS and Linux/,
    );
    await assert.rejects(install(directory, extensionId, { platform }), /support only macOS and Linux/);
  }

  assert.deepEqual(await readdir(directory), []);
});

test('installation uses only the isolated user-data manifest and returns UI/project verification paths', async (context) => {
  for (const platform of ['darwin', 'linux']) {
    await context.test(platform, async (child) => {
      const { install, hostScript } = await nativeFixture(child);
      const directory = await fixture(child);
      await mkdir(path.join(directory, 'home'), { mode: 0o700 });
      await write(
        path.join(directory, 'profile/Default/owned-canary'),
        'Preserve the running Chrome profile.',
      );
      const paths = await install(directory, extensionId, { platform });
      const canonical = await realpath(directory);
      assert.deepEqual(paths, {
        profile: path.join(canonical, 'profile'),
        manifestDirectory: path.join(canonical, 'profile/NativeMessagingHosts'),
        manifestPath: path.join(canonical, 'profile/NativeMessagingHosts/ai.mitter.host.json'),
        launcher: path.join(canonical, 'native/mitter-host'),
        home: path.join(canonical, 'home'),
        state: path.join(canonical, 'state'),
        project: path.join(canonical, 'project'),
        hostScript,
      });
      const manifest = nativeManifestSchema.parse(JSON.parse(await readFile(paths.manifestPath, 'utf8')));
      assert.deepEqual(manifest, {
        name: 'ai.mitter.host',
        description: 'Miter local project host',
        path: paths.launcher,
        type: 'stdio',
        allowed_origins: [origin],
      });
      assert.ok(path.isAbsolute(manifest.path));
      assert.equal((await lstat(paths.manifestPath)).mode & 0o777, 0o600);
      assert.equal((await lstat(paths.launcher)).mode & 0o777, 0o700);

      for (const filename of [paths.home, paths.state, paths.project, paths.manifestDirectory]) {
        assert.ok((await lstat(filename)).isDirectory());
        assert.ok(path.relative(canonical, filename).startsWith('..') === false);
      }

      assert.equal(
        await readFile(path.join(paths.profile, 'Default/owned-canary'), 'utf8'),
        'Preserve the running Chrome profile.',
      );
      assert.deepEqual(await readdir(paths.home, { recursive: true }), []);
      assert.deepEqual(await readdir(paths.state), []);
      assert.deepEqual(await readdir(paths.project), []);
      assert.deepEqual(await readdir(paths.manifestDirectory), ['ai.mitter.host.json']);
      const source = await readFile(paths.launcher, 'utf8');
      assert.ok(source.includes(`exec ${quotePosix(process.execPath)} ${quotePosix(hostScript)} "$@"\n`));
      assert.equal(source.includes(origin), false, 'Chrome must supply the origin, not the launcher.');
      assert.equal(source.includes('pnpm'), false);
    });
  }
});

test('launcher quotes literal temporary paths, isolates inherited state and forwards exact Chrome arguments', async (context) => {
  const { install, hostScript } = await nativeFixture(context);
  const directory = await fixture(context);
  const owned = path.join(
    directory,
    'spaces \' " $HOME `touch backtick-injection` $(touch command-injection); π\nnext',
  );
  await mkdir(owned, { mode: 0o700 });
  const poison = path.join(directory, 'poison');
  await mkdir(poison, { mode: 0o700 });
  await write(path.join(poison, 'canary'), 'Do not read or alter inherited state.');
  const preload = path.join(poison, 'preload.mjs');
  await write(preload, 'throw new Error("Inherited NODE_OPTIONS must not load code.");\n');

  const probe =
    'console.log(JSON.stringify({' +
    'argv: process.argv.slice(1), cwd: process.cwd(), ' +
    'home: process.env.HOME, userprofile: process.env.USERPROFILE, state: process.env.MITTER_HOME, ' +
    'config: process.env.XDG_CONFIG_HOME, cache: process.env.XDG_CACHE_HOME, ' +
    'data: process.env.XDG_DATA_HOME, xdgState: process.env.XDG_STATE_HOME, ' +
    'nodeOptions: process.env.NODE_OPTIONS ?? null, nodePath: process.env.NODE_PATH ?? null' +
    '}));';
  const executable = path.join(owned, 'fake node \' " $HOME');
  // This executable records the harmless fixture entry path; it never imports application code.
  await write(
    executable,
    '#!/bin/sh\n' + `exec ${quotePosix(process.execPath)} -e ${quotePosix(probe)} "$@"\n`,
    0o700,
  );
  const paths = await install(owned, extensionId, { nodeExecutable: executable });
  const args = [
    origin,
    '--parent-window=0',
    '',
    'space and \' " quotes',
    '$HOME; $(touch argument-injection)',
    'line\nbreak',
  ];
  const before = await readdir(directory);
  const result = spawnSync(paths.launcher, args, {
    cwd: directory,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: poison,
      USERPROFILE: poison,
      MITTER_HOME: poison,
      XDG_CONFIG_HOME: poison,
      XDG_CACHE_HOME: poison,
      XDG_DATA_HOME: poison,
      XDG_STATE_HOME: poison,
      NODE_OPTIONS: '--import=' + preload,
      NODE_PATH: poison,
    },
    encoding: 'utf8',
    timeout: 5000,
    shell: false,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(launcherProbeSchema.parse(JSON.parse(result.stdout)), {
    argv: [hostScript, ...args],
    cwd: await realpath(owned),
    home: paths.home,
    userprofile: paths.home,
    state: paths.state,
    config: path.join(paths.home, '.config'),
    cache: path.join(paths.home, '.cache'),
    data: path.join(paths.home, '.local/share'),
    xdgState: path.join(paths.home, '.local/state'),
    nodeOptions: null,
    nodePath: null,
  });
  assert.deepEqual(await readdir(directory), before, 'Shell substitutions must not create extra files.');
  assert.deepEqual(
    (await readdir(owned)).sort(),
    ['fake node \' " $HOME', 'home', 'native', 'profile', 'project', 'state'].sort(),
  );
  assert.equal(await readFile(path.join(poison, 'canary'), 'utf8'), 'Do not read or alter inherited state.');
});

test('invalid CDP origins, executable and host paths are rejected before fixture creation', async (context) => {
  const { install } = await nativeFixture(context);
  const directory = await fixture(context);

  for (const id of [
    undefined,
    null,
    '',
    'a'.repeat(31),
    'q'.repeat(32),
    extensionId.toUpperCase(),
    origin,
    '*',
    '../escape',
    { id: extensionId },
  ]) {
    await assert.rejects(install(directory, id), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /extension ID returned by Chrome CDP/);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }

  for (const nodeExecutable of [null, 'node', '/node\0escape']) {
    await assert.rejects(
      install(directory, extensionId, { nodeExecutable }),
      /Node executable must be an absolute path/,
    );
  }

  for (const hostScript of [null, 42, '', 'host.js', 'file:///host.js', '/host\0escape.js']) {
    await assert.rejects(
      install(directory, extensionId, { hostScript }),
      /host entry must be an absolute path without NUL characters/,
    );
  }

  assert.deepEqual(await readdir(directory), []);
});

test('host entry overrides reject missing, unreadable, non-regular and symlink files without writes', async (context) => {
  const { install, hostScript } = await nativeFixture(context);
  const directory = await fixture(context);
  const inputs = await fixture(context);
  const missing = path.join(inputs, 'missing.js');
  const folder = path.join(inputs, 'folder.js');
  const link = path.join(inputs, 'link.js');
  const dangling = path.join(inputs, 'dangling.js');
  const unreadable = path.join(inputs, 'unreadable.js');
  await mkdir(folder, { mode: 0o700 });
  await symlink(hostScript, link);
  await symlink(missing, dangling);
  await write(unreadable, 'process.exitCode = 0;\n');
  await chmod(unreadable, 0o000);

  for (const entry of [missing, folder, link, dangling, unreadable]) {
    await assert.rejects(install(directory, extensionId, { hostScript: entry }), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /readable regular host entry/);
      assert.ok(error.message.includes(entry));
      assert.ok(error.cause instanceof Error);

      if (entry === missing) {
        assert.equal(error.cause.code, 'ENOENT');
      } else if (entry === unreadable) {
        assert.match(error.cause.message, /no read permission bits/);
      } else {
        assert.match(error.cause.message, /regular file, not a symlink/);
      }

      return true;
    });
    assert.deepEqual(await readdir(directory), []);
  }

  assert.equal(await readlink(link), hostScript);
  assert.equal(await readlink(dangling), missing);
  assert.equal((await lstat(unreadable)).mode & 0o777, 0o000);
});

test('owned temporary root validation is reusable and read-only before Chrome preparation', async (context) => {
  const directory = await fixture(context);
  const canonical = await realpath(directory);
  assert.equal(await ownedTemporaryDirectory(directory), canonical);
  assert.equal(await ownedTemporaryDirectory(canonical), canonical);
  assert.deepEqual(await readdir(directory), []);

  const alias = path.join(directory, 'alias');
  await symlink(directory, alias);
  await assert.rejects(ownedTemporaryDirectory(alias), /Unsafe native fixture path/);
  await assert.rejects(ownedTemporaryDirectory(path.join(alias, 'child')), /Unsafe native fixture path/);
  await assert.rejects(ownedTemporaryDirectory(os.tmpdir()), /fixture directory must be/);
  await assert.rejects(ownedTemporaryDirectory('.'), /fixture directory must be/);
  assert.deepEqual(await readdir(directory), ['alias']);
});

test('installation requires an existing owned temporary directory, never a root or symlink alias', async (context) => {
  const { install } = await nativeFixture(context);
  const directory = await fixture(context);
  const outside = path.join(directory, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await write(path.join(outside, 'canary'), 'Preserve sibling bytes.');
  await symlink(outside, path.join(directory, 'alias'));
  await write(path.join(directory, 'file'), 'Not a directory.');

  for (const invalid of [undefined, null, '.', '/', os.tmpdir(), '/tmp\0escape']) {
    await assert.rejects(install(invalid, extensionId), /fixture directory must be/);
  }

  await assert.rejects(install(path.join(directory, 'missing'), extensionId), /Create it with mkdtemp/);
  await assert.rejects(install(path.join(directory, 'file'), extensionId), /Unsafe native fixture path/);
  await assert.rejects(install(path.join(directory, 'alias'), extensionId), /Unsafe native fixture path/);
  await assert.rejects(
    install(path.join(directory, 'alias/child'), extensionId),
    /Unsafe native fixture path/,
  );
  assert.deepEqual(await readdir(outside), ['canary']);
  assert.equal(await readFile(path.join(outside, 'canary'), 'utf8'), 'Preserve sibling bytes.');
  assert.deepEqual((await readdir(directory)).sort(), ['alias', 'file', 'outside']);
});

test('writable temporary roots are refused without changing their permissions or contents', async (context) => {
  const { install } = await nativeFixture(context);
  const directory = await fixture(context);
  await chmod(directory, 0o777);
  await assert.rejects(ownedTemporaryDirectory(directory), /group\/world-writable directory/);
  await assert.rejects(install(directory, extensionId), /group\/world-writable directory/);
  assert.equal((await lstat(directory)).mode & 0o777, 0o777);
  assert.deepEqual(await readdir(directory), []);
});

test('symlinked fixture parents cannot escape or cause partial installation', async (context) => {
  for (const relative of ['home', 'state', 'project', 'native', 'profile', 'profile/NativeMessagingHosts']) {
    await context.test(relative, async (child) => {
      const { install } = await nativeFixture(child);
      const directory = await fixture(child);
      const owned = path.join(directory, 'owned');
      const outside = path.join(directory, 'outside');
      await mkdir(owned, { mode: 0o700 });
      await write(path.join(outside, 'canary'), 'Do not alter sibling state.');
      const alias = path.join(owned, relative);
      await mkdir(path.dirname(alias), { recursive: true, mode: 0o700 });
      await symlink(outside, alias);
      const before = await readdir(owned, { recursive: true });
      await assert.rejects(install(owned, extensionId), /Unsafe native fixture path/);
      assert.deepEqual(await readdir(owned, { recursive: true }), before);
      assert.deepEqual(await readdir(outside), ['canary']);
      assert.equal(await readFile(path.join(outside, 'canary'), 'utf8'), 'Do not alter sibling state.');
    });
  }
});

test('existing manifest and launcher files, including dangling symlinks, are never replaced', async (context) => {
  for (const relative of ['native/mitter-host', 'profile/NativeMessagingHosts/ai.mitter.host.json']) {
    for (const dangling of [false, true]) {
      await context.test(relative + ', dangling=' + dangling, async (child) => {
        const { install } = await nativeFixture(child);
        const directory = await fixture(child);
        const filename = path.join(directory, relative);
        const absent = path.join(directory, 'absent');
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });

        if (dangling) {
          await symlink(absent, filename);
        } else {
          await write(filename, 'Preserve these exact bytes.');
        }

        const before = await readdir(directory, { recursive: true });
        await assert.rejects(install(directory, extensionId), /fixture file already exists/);
        assert.deepEqual(await readdir(directory, { recursive: true }), before);

        if (dangling) {
          assert.equal(await readlink(filename), absent);
        } else {
          assert.equal(await readFile(filename, 'utf8'), 'Preserve these exact bytes.');
        }
      });
    }
  }
});
