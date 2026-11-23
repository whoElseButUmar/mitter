import './host-source-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
  chmod,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { bundleManifestSchema } from '../installation/bundle-contracts.mjs';
import { digest, inventory, copyTree } from '../installation/files.mjs';
import { buildLocalBundle } from '../installation/bundle.mjs';
import { verifyBundle } from '../installation/verification.mjs';
import { installLocalBundle, parseInstallArguments } from '../installation/install.mjs';
import { parseUninstallArguments, uninstallManaged } from '../installation/uninstall.mjs';
import { copyDependencies } from '../installation/dependencies.mjs';

const macOnly = process.platform !== 'darwin';
const identity = {
  name: 'Miter',
  key: 'YWJj',
  extensionId: 'mclgchkiejnomabbnglaodgnmfhhipep',
  nativeHost: 'ai.mitter.host',
};

async function temporary(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'miter-local-install-'));

  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

async function seal(bundle) {
  const manifest = bundleManifestSchema.parse({
    format: 1,
    version: '1.0.0',
    platform: 'darwin',
    architecture: process.arch,
    node: process.versions.node,
    files: await inventory(bundle),
  });

  await writeFile(path.join(bundle, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function fixtureBundle(directory) {
  const bundle = path.join(directory, 'bundle');
  const files = {
    'package.json': '{"type":"module"}',
    'brand/extension-identity.json': JSON.stringify(identity),
    'scripts/verify-build.mjs': 'console.log("fixture assets verified");',
    'scripts/installation/verify-runtime.mjs': 'console.log("fixture runtime verified");',
    'scripts/installation/uninstall.mjs': 'console.log(JSON.stringify(process.argv.slice(2)));',
    'dist/apps/host/src/native.js': 'console.log("fixture-host=" + process.execPath);',
    'dist/apps/host/src/cli.js':
      'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),home:process.env.MITTER_HOME}));',
    'apps/extension/.output/chrome-mv3/manifest.json': '{"version":"1.0.0"}',
    'apps/extension/.output/chrome-mv3/old-chunk.js': 'old chunk',
  };

  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(bundle, file)), { recursive: true });
    await writeFile(path.join(bundle, file), content);
  }

  await mkdir(path.join(bundle, 'runtime'));
  await copyFile(process.execPath, path.join(bundle, 'runtime/node'));
  await chmod(path.join(bundle, 'runtime/node'), 0o755);
  await seal(bundle);

  return bundle;
}

test('local installer arguments reject repeated flags and empty or unknown overrides', () => {
  assert.deepEqual(parseInstallArguments(['--chromium', '--destination=./fixture']), {
    chromium: true,
    help: false,
    destination: path.resolve('fixture'),
  });

  for (const args of [
    ['--destination='],
    ['--destination=a', '--destination=b'],
    ['--chromium', '--chromium'],
    ['--remove'],
    ['--destination=bad\0path'],
  ]) {
    assert.throws(() => {
      parseInstallArguments(args);
    });
  }
});

test('uninstall rejects unknown flags and requires an explicit purge flag', () => {
  assert.deepEqual(parseUninstallArguments(['--dry-run']), { purge: false, dryRun: true, help: false });
  assert.equal(parseUninstallArguments(['--purge']).purge, true);
  assert.throws(() => parseUninstallArguments(['--force']), /Usage/);
  assert.throws(() => parseUninstallArguments(['--purge', '--purge']), /Usage/);
});

test(
  'managed uninstall removes only its own installation and registrations',
  { skip: macOnly },
  async (context) => {
    const directory = await temporary(context);
    const bundle = await fixtureBundle(directory);
    const home = await realpath(directory);
    const dataHome = path.join(home, 'empty-state');
    const manifestDirectory = path.join(home, 'custom host registrations');
    const installed = await installLocalBundle({ bundle, home, dataHome, manifestDirectory });
    const shortcut = path.join(home, '.local/bin/miter');
    const { registrationManifest, registrationPaths } = await import('../installation/registration.mjs');
    const other = registrationPaths({
      platform: 'darwin',
      root: bundle,
      home,
      browser: 'chromium',
      nativeHost: identity.nativeHost,
    });
    const foreign = JSON.stringify(registrationManifest(identity, path.join(home, 'other-setup/host')));

    await mkdir(other.manifestDirectory, { recursive: true });
    await writeFile(other.manifestPath, foreign);
    assert.deepEqual(JSON.parse(execFileSync(shortcut, ['uninstall', '--dry-run'], { encoding: 'utf8' })), [
      home,
      installed.manifest,
      '--dry-run',
    ]);

    const options = { home, manifestPath: installed.manifest, release: installed.release };
    const output = [];
    const ui = {
      output: (line) => {
        output.push(line);
      },
      confirm: () => assert.fail('Unexpected confirmation'),
    };
    await uninstallManaged({ ...options, dryRun: true }, ui);
    assert.ok(output.includes('  ' + installed.destination));
    assert.ok(output.includes('  ' + installed.manifest));
    assert.ok(output.includes('  ' + shortcut));
    assert.ok(!output.includes('  ' + other.manifestPath));
    assert.equal((await lstat(installed.destination)).isDirectory(), true);

    const unknown = path.join(installed.destination, 'my-project');
    await mkdir(unknown);
    await assert.rejects(uninstallManaged(options, ui), /unrecognized item/);
    assert.equal((await lstat(unknown)).isDirectory(), true);
    await rm(unknown, { recursive: true });

    const otherManifest = path.join(home, 'other-manifest.json');
    await rename(other.manifestPath, otherManifest);
    await symlink(otherManifest, other.manifestPath);
    await uninstallManaged(options, ui);
    await assert.rejects(lstat(installed.destination), { code: 'ENOENT' });
    await assert.rejects(lstat(installed.manifest), { code: 'ENOENT' });
    await assert.rejects(lstat(shortcut), { code: 'ENOENT' });
    await assert.rejects(lstat(dataHome), { code: 'ENOENT' });
    assert.equal((await lstat(other.manifestPath)).isSymbolicLink(), true);
    assert.equal(await readFile(other.manifestPath, 'utf8'), foreign);
    assert.equal((await lstat(bundle)).isDirectory(), true);
  },
);

test(
  'purge requires confirmation and preserves saved projects, worktrees and unrelated files',
  { skip: macOnly },
  async (context) => {
    const directory = await temporary(context);
    const bundle = await fixtureBundle(directory);
    const home = await realpath(directory);
    const data = path.join(home, 'custom-state');
    const backup = path.join(data, 'backups/state.sqlite');
    const worktree = path.join(data, 'worktrees/task/project.txt');
    const databaseFile = path.join(data, 'mitter.sqlite');
    const project = path.join(home, 'source-project');
    const unrelated = path.join(data, 'keep.txt');
    const { openNodeSqlite } = await import('../../apps/host/src/adapters/sqlite.js');
    const { Store } = await import('../../apps/host/src/core/database.js');
    const { acquireHostLock } = await import('../../apps/host/src/core/host-lock.js');

    function saveProject(root) {
      const database = openNodeSqlite(databaseFile);
      try {
        new Store(database).saveProject({
          id: 'project',
          name: 'Saved project',
          root,
          profiles: [],
          revision: 0,
        });
      } finally {
        database.close();
      }
    }

    await mkdir(path.dirname(backup), { recursive: true });
    await mkdir(path.dirname(worktree), { recursive: true });
    await mkdir(project);
    await writeFile(path.join(project, 'index.html'), 'project source');
    await writeFile(backup, 'saved backup');
    await writeFile(worktree, 'project source');
    await writeFile(unrelated, 'other data');
    await symlink(project, path.join(path.dirname(backup), 'project-link'));
    saveProject(path.dirname(backup));
    const installed = await installLocalBundle({ bundle, home, dataHome: data });
    const output = [];
    const options = { home, manifestPath: installed.manifest, release: installed.release, purge: true };

    await uninstallManaged(options, {
      output: (line) => {
        output.push(line);
      },
      confirm: () => 'cancel',
    });

    assert.ok(output.includes('  ' + path.dirname(backup)));
    assert.ok(!output.includes('  ' + path.join(data, 'worktrees')));
    assert.ok(output.includes('Uninstall canceled.'));
    assert.equal(await readFile(backup, 'utf8'), 'saved backup');
    assert.equal(await readFile(worktree, 'utf8'), 'project source');
    assert.equal((await lstat(installed.manifest)).isFile(), true);
    await assert.rejects(lstat(path.join(data, 'host-lease.sqlite')), { code: 'ENOENT' });

    const confirmed = { output() {}, confirm: () => 'PURGE' };
    const unlock = await acquireHostLock(data);
    try {
      await assert.rejects(uninstallManaged(options, confirmed), /Another Miter host is running/);
    } finally {
      await unlock();
    }
    await assert.rejects(uninstallManaged(options, confirmed), /A saved project is inside a removal path/);
    assert.equal(await readFile(backup, 'utf8'), 'saved backup');
    assert.equal((await lstat(installed.manifest)).isFile(), true);

    saveProject(project);
    await uninstallManaged(options, confirmed);
    await assert.rejects(lstat(installed.destination), { code: 'ENOENT' });
    await assert.rejects(lstat(databaseFile), { code: 'ENOENT' });
    await assert.rejects(lstat(backup), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(data, 'host-lease.sqlite')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(project, 'index.html'), 'utf8'), 'project source');
    assert.equal(await readFile(worktree, 'utf8'), 'project source');
    assert.equal(await readFile(unrelated, 'utf8'), 'other data');
  },
);

test('dependency packaging retains distinct transitive versions without external links', async (context) => {
  const directory = await temporary(context);
  const source = path.join(directory, 'source');
  const output = path.join(directory, 'output');

  for (const [folder, name, version, dependencies] of [
    ['a', 'a', '1.0.0', { shared: '1.0.0' }],
    ['a/node_modules/shared', 'shared', '1.0.0', {}],
    ['b', 'b', '1.0.0', { shared: '2.0.0' }],
    ['b/node_modules/shared', 'shared', '2.0.0', {}],
  ]) {
    const packageDirectory = path.join(source, 'node_modules', folder);

    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({ name, version, dependencies, main: 'index.js' }),
    );
    let content = 'module.exports = ' + JSON.stringify(version);

    if (Object.keys(dependencies).length > 0) {
      content = 'module.exports = require("shared")';
    }

    await writeFile(path.join(packageDirectory, 'index.js'), content);
  }

  await writeFile(path.join(source, 'package.json'), '{}');
  await copyDependencies(source, output, ['a', 'b']);
  const entries = await inventory(output);

  assert.ok(
    entries.some((entry) => {
      return 'target' in entry;
    }),
  );
  await rm(source, { recursive: true });
  const result = execFileSync(process.execPath, ['-e', 'console.log(require("a"), require("b"))'], {
    cwd: output,
    encoding: 'utf8',
  });

  assert.equal(result.trim(), '1.0.0 2.0.0');
  await assert.rejects(copyDependencies(output, path.join(directory, 'invalid'), ['../outside']));
});

test('dependency packaging preserves nested types-only exports, scoped links and license files', async (context) => {
  const directory = await temporary(context);
  const source = path.join(directory, 'source');
  const output = path.join(directory, 'output');
  const dependency = '@fixture/types';

  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'package.json'), '{}');

  for (const [owner, version] of [
    ['a', '1.2.0'],
    ['b', '2.3.0'],
  ]) {
    const ownerDirectory = path.join(source, 'node_modules', owner);
    const installed = path.join(source, '.store', owner, dependency);
    const link = path.join(ownerDirectory, 'node_modules', dependency);

    await mkdir(ownerDirectory, { recursive: true });
    await writeFile(
      path.join(ownerDirectory, 'package.json'),
      JSON.stringify({
        name: owner,
        version: '1.0.0',
        main: 'index.js',
        dependencies: { [dependency]: version },
      }),
    );
    await writeFile(path.join(ownerDirectory, 'index.js'), 'module.exports = "' + owner + '";');
    await mkdir(installed, { recursive: true });
    await writeFile(
      path.join(installed, 'package.json'),
      JSON.stringify({
        name: dependency,
        version,
        types: './index.d.ts',
        exports: { '.': { types: './index.d.ts' } },
      }),
    );
    await writeFile(path.join(installed, 'index.d.ts'), 'export type Version = "' + version + '";');
    await writeFile(path.join(installed, 'LICENSE'), 'License for version ' + version + '\n');
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(path.relative(path.dirname(link), installed), link);
  }

  const hoisted = path.join(source, 'node_modules', dependency);

  await mkdir(hoisted, { recursive: true });
  await writeFile(
    path.join(hoisted, 'package.json'),
    JSON.stringify({
      name: dependency,
      version: '9.0.0',
      exports: {},
    }),
  );
  await copyDependencies(source, output, ['a', 'b']);
  await rm(source, { recursive: true });
  await inventory(output);

  for (const [owner, version] of [
    ['a', '1.2.0'],
    ['b', '2.3.0'],
  ]) {
    const installed = path.join(output, 'node_modules', owner, 'node_modules', dependency);
    const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));

    assert.equal(metadata.name, dependency);
    assert.equal(metadata.version, version);
    assert.equal(
      await readFile(path.join(installed, 'index.d.ts'), 'utf8'),
      'export type Version = "' + version + '";',
    );
    assert.equal(
      await readFile(path.join(installed, 'LICENSE'), 'utf8'),
      'License for version ' + version + '\n',
    );
  }
});

test('an invalid nearest hidden package does not fall through to a different hoisted version', async (context) => {
  const directory = await temporary(context);
  const source = path.join(directory, 'source');
  const owner = path.join(source, 'node_modules', 'owner');
  const nested = path.join(owner, 'node_modules', 'hidden');
  const hoisted = path.join(source, 'node_modules', 'hidden');

  await mkdir(nested, { recursive: true });
  await mkdir(hoisted, { recursive: true });
  await writeFile(path.join(source, 'package.json'), '{}');
  await writeFile(
    path.join(owner, 'package.json'),
    JSON.stringify({
      name: 'owner',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { hidden: '1.0.0' },
    }),
  );
  await writeFile(path.join(owner, 'index.js'), 'module.exports = 1;');
  await writeFile(
    path.join(nested, 'package.json'),
    JSON.stringify({
      name: 'different-package',
      version: '1.0.0',
      exports: {},
    }),
  );
  await writeFile(
    path.join(hoisted, 'package.json'),
    JSON.stringify({
      name: 'hidden',
      version: '2.0.0',
      exports: {},
    }),
  );

  await assert.rejects(copyDependencies(source, path.join(directory, 'output'), ['owner']), /does not match/);
});

test(
  'managed local installation survives bundle relocation and updates without deleting old releases or state',
  { skip: macOnly },
  async (context) => {
    const directory = await temporary(context);
    let bundle = await fixtureBundle(directory);
    const home = path.join(directory, 'home');
    const dataHome = path.join(home, 'state');
    const destination = path.join(home, 'Application Support/Miter');

    await mkdir(dataHome, { recursive: true });
    await writeFile(path.join(dataHome, 'keep.txt'), 'existing user state');
    const options = { destination, home, dataHome };
    const first = await installLocalBundle({ bundle, ...options });
    const launcher = path.join(first.destination, 'bin/miter-host');
    const manifest = JSON.parse(await readFile(first.manifest, 'utf8'));

    assert.equal(manifest.path, launcher);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${identity.extensionId}/`]);
    assert.equal((await lstat(first.extension)).isDirectory(), true);
    assert.doesNotMatch(await readFile(launcher, 'utf8'), /\.nvm/);
    const movedBundle = path.join(directory, 'moved bundle');

    await rename(bundle, movedBundle);
    bundle = movedBundle;
    const launched = execFileSync(launcher, [], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });

    assert.match(launched, /fixture-host=/);
    assert.ok(launched.includes(path.join(first.release, 'runtime/node')));
    const literalGoal = 'build $HOME `echo untouched` and spaces';
    const commandResult = JSON.parse(
      execFileSync(first.command, ['start', '--goal', literalGoal], {
        cwd: directory,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      }),
    );

    assert.deepEqual(commandResult, {
      cwd: await realpath(directory),
      args: ['start', '--goal', literalGoal],
      home: dataHome,
    });
    assert.equal((await lstat(first.command)).mode & 0o777, 0o700);
    const interrupted = path.join(destination, 'releases/.installing-abc123');
    const outside = path.join(directory, 'outside-copy.txt');

    await mkdir(interrupted);
    await writeFile(path.join(interrupted, 'partial.bin'), 'incomplete copy');
    await writeFile(outside, 'keep');
    await symlink(outside, path.join(interrupted, 'outside-link'));
    const repeat = await installLocalBundle({ bundle, ...options });

    await assert.rejects(lstat(interrupted), { code: 'ENOENT' });
    assert.equal(await readFile(outside, 'utf8'), 'keep');

    assert.equal(repeat.release, first.release);
    await rm(path.join(bundle, 'apps/extension/.output/chrome-mv3/old-chunk.js'));
    await writeFile(path.join(bundle, 'apps/extension/.output/chrome-mv3/new-chunk.js'), 'new chunk');
    await writeFile(
      path.join(bundle, 'apps/extension/.output/chrome-mv3/manifest.json'),
      '{"version":"1.0.1"}',
    );
    await seal(bundle);
    const second = await installLocalBundle({ bundle, ...options });

    assert.notEqual(second.release, first.release);
    assert.equal(
      await readFile(path.join(first.release, 'apps/extension/.output/chrome-mv3/old-chunk.js'), 'utf8'),
      'old chunk',
    );
    assert.equal(await readFile(path.join(second.extension, 'old-chunk.js'), 'utf8'), 'old chunk');
    assert.equal(await readFile(path.join(second.extension, 'new-chunk.js'), 'utf8'), 'new chunk');
    assert.equal(await readFile(path.join(dataHome, 'keep.txt'), 'utf8'), 'existing user state');
    assert.deepEqual(await readdir(dataHome), ['keep.txt']);
    assert.equal((await readdir(path.join(destination, 'releases'))).length, 2);
    assert.equal((await readdir(destination)).includes('.install-lock'), false);
  },
);

test(
  'installer rejects changed bundles, foreign destinations, links and failed runtime before registration',
  { skip: macOnly },
  async (context) => {
    const directory = await temporary(context);
    const bundle = await fixtureBundle(directory);
    const home = path.join(directory, 'home');
    const destination = path.join(home, 'Miter');
    const options = { bundle, home, destination, dataHome: path.join(home, 'state') };

    await writeFile(path.join(bundle, 'unexpected.txt'), 'changed');
    await assert.rejects(installLocalBundle(options), /files changed/);
    await assert.rejects(lstat(home), { code: 'ENOENT' });
    await rm(path.join(bundle, 'unexpected.txt'));
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'personal.txt'), 'untouched');
    await assert.rejects(installLocalBundle(options), /empty destination/);
    assert.equal(await readFile(path.join(destination, 'personal.txt'), 'utf8'), 'untouched');
    await rm(destination, { recursive: true });
    await symlink(bundle, destination);
    await assert.rejects(installLocalBundle(options), /symbolic link/);
    await rm(destination);
    await assert.rejects(installLocalBundle({ ...options, destination: directory }), /separate directories/);
    await writeFile(
      path.join(bundle, 'scripts/installation/verify-runtime.mjs'),
      'throw new Error("fixture runtime unavailable");',
    );
    await seal(bundle);
    await assert.rejects(installLocalBundle(options), /fixture runtime unavailable/);
    await assert.rejects(lstat(path.join(home, 'Library')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(destination, 'installation.json')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(path.join(destination, 'releases')), []);
    assert.equal((await readdir(destination)).includes('.install-lock'), false);
    await writeFile(
      path.join(bundle, 'scripts/installation/verify-runtime.mjs'),
      'console.log("runtime repaired");',
    );
    await seal(bundle);
    const retried = await installLocalBundle(options);

    assert.ok(retried.release);
    assert.equal(
      JSON.parse(await readFile(path.join(destination, 'installation.json'), 'utf8')).extensionId,
      identity.extensionId,
    );
  },
);

test(
  'unsafe source cleanup, external bundle links and native registration links fail closed',
  { skip: macOnly },
  async (context) => {
    const directory = await temporary(context);
    const bundle = await fixtureBundle(directory);

    await assert.rejects(buildLocalBundle({ root: bundle, output: directory }), /must not replace/);
    await assert.rejects(
      buildLocalBundle({ root: bundle, output: path.join(bundle, 'scripts/recursive') }),
      /must not replace/,
    );
    await symlink(process.execPath, path.join(bundle, 'external'));
    await assert.rejects(verifyBundle(bundle), /escapes its root/);
    await rm(path.join(bundle, 'external'));
    const home = path.join(directory, 'home');
    const manifestDirectory = path.join(home, 'manifests');
    const protectedFile = path.join(directory, 'protected.txt');

    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(protectedFile, 'original');
    await symlink(protectedFile, path.join(manifestDirectory, identity.nativeHost + '.json'));
    const destination = path.join(home, 'Miter');

    await assert.rejects(installLocalBundle({ bundle, destination, home, manifestDirectory }), (error) => {
      assert.match(error.message, /safely preserve the existing data folder/);
      assert.match(error.cause.message, /regular file, not a link/);

      return true;
    });
    await assert.rejects(
      installLocalBundle({
        bundle,
        destination,
        home,
        manifestDirectory,
        dataHome: path.join(home, 'explicit-state'),
      }),
      /symbolic link/,
    );
    assert.equal(await readFile(protectedFile, 'utf8'), 'original');
    await assert.rejects(lstat(path.join(destination, 'bin/miter-host')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(destination, 'installation.json')), { code: 'ENOENT' });
    assert.equal(digest(await readFile(path.join(bundle, 'runtime/node'))).length, 64);
  },
);

test(
  'failed registration restores the prior extension, launcher and active release marker',
  { skip: macOnly },
  async (context) => {
    const directory = await temporary(context);
    const bundle = await fixtureBundle(directory);
    const home = path.join(directory, 'home');
    const manifestDirectory = path.join(home, 'manifests');
    const destination = path.join(home, 'Miter');
    const options = { bundle, destination, home, manifestDirectory, dataHome: path.join(home, 'state') };
    const installed = await installLocalBundle(options);
    const marker = path.join(destination, 'installation.json');
    const launcher = path.join(destination, 'bin/miter-host');
    const beforeMarker = await readFile(marker);
    const beforeLauncher = await readFile(launcher);
    const beforeManifest = await readFile(installed.manifest);
    const beforeExtension = await readFile(path.join(installed.extension, 'manifest.json'));

    await writeFile(
      path.join(bundle, 'apps/extension/.output/chrome-mv3/manifest.json'),
      '{"version":"changed"}',
    );
    await writeFile(path.join(bundle, 'apps/extension/.output/chrome-mv3/new-file.js'), 'changed');
    await seal(bundle);
    await chmod(manifestDirectory, 0o500);

    try {
      await assert.rejects(installLocalBundle(options), /EACCES|EPERM/);
    } finally {
      await chmod(manifestDirectory, 0o700);
    }

    assert.deepEqual(await readFile(marker), beforeMarker);
    assert.deepEqual(await readFile(launcher), beforeLauncher);
    assert.deepEqual(await readFile(installed.manifest), beforeManifest);
    assert.deepEqual(await readFile(path.join(installed.extension, 'manifest.json')), beforeExtension);
    await assert.rejects(lstat(path.join(installed.extension, 'new-file.js')), { code: 'ENOENT' });
    assert.equal((await readdir(destination)).includes('.install-lock'), false);
  },
);

test('packaging keeps selected native prebuilds and every license while dropping foreign architectures', async (context) => {
  const directory = await temporary(context);
  const source = path.join(directory, 'source');
  const output = path.join(directory, 'output');
  const selected = process.platform + '-' + process.arch;
  const foreign = 'foreign-architecture';

  for (const name of ['node-pty', 'better-sqlite3']) {
    const packageDirectory = path.join(source, 'node_modules', name);

    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
    );
    await writeFile(path.join(packageDirectory, 'index.js'), 'module.exports = true;');
    await writeFile(path.join(packageDirectory, 'LICENSE'), 'entire upstream license');

    for (const target of [selected, foreign]) {
      let native = path.join(packageDirectory, 'prebuilds', target + '.node');

      if (name === 'node-pty') {
        native = path.join(packageDirectory, 'prebuilds', target, 'pty.node');
      }

      await mkdir(path.dirname(native), { recursive: true });
      await writeFile(native, 'fixture native bytes');
    }
  }

  await writeFile(path.join(source, 'package.json'), '{}');
  await copyDependencies(source, output, ['node-pty', 'better-sqlite3']);
  const files = await inventory(output);
  const native = files.filter((file) => {
    return file.path.endsWith('.node');
  });

  assert.equal(native.length, 2);
  assert.ok(
    native.every((file) => {
      return file.path.includes(selected);
    }),
  );
  assert.equal(
    files.filter((file) => {
      return file.path.endsWith('/LICENSE');
    }).length,
    2,
  );
});

test(
  'Finder metadata does not invalidate a bundle, but other extra files still do',
  { skip: macOnly },
  async (context) => {
    const directory = await temporary(context);
    const bundle = await fixtureBundle(directory);

    await writeFile(path.join(bundle, '.DS_Store'), 'Finder metadata');
    await writeFile(path.join(bundle, 'brand/.DS_Store'), 'Finder metadata');
    await verifyBundle(bundle);
    const copy = path.join(directory, 'copy');

    await copyTree(bundle, copy, { links: bundle });
    await verifyBundle(copy);
    await assert.rejects(lstat(path.join(copy, '.DS_Store')), { code: 'ENOENT' });
    await writeFile(path.join(bundle, 'unexpected.js'), 'untracked script');
    await assert.rejects(verifyBundle(bundle), /files changed/);
  },
);

test(
  'first installation resumes from a kernel lock alone or a complete matching owner partial',
  { skip: macOnly },
  async (context) => {
    const directory = await temporary(context);
    const bundle = await fixtureBundle(directory);
    const home = path.join(directory, 'home');

    for (const fixture of [
      { name: 'Miter-lock', partial: false },
      { name: 'Miter-partial', partial: true },
    ]) {
      const destination = path.join(home, fixture.name);
      const partial = path.join(
        destination,
        '.miter-installation.json.3c4e125b-286f-463d-8932-3f43b3b45d45.partial',
      );

      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, '.installation.lock'), '');

      if (fixture.partial) {
        await writeFile(partial, JSON.stringify({ format: 1, extensionId: identity.extensionId }));
      }

      const installed = await installLocalBundle({
        bundle,
        destination,
        home,
        dataHome: path.join(home, 'state'),
      });

      assert.ok(installed.release);
      assert.equal((await lstat(path.join(destination, '.installation.lock'))).size, 0);
      assert.equal(
        JSON.parse(await readFile(path.join(destination, '.miter-installation.json'), 'utf8')).extensionId,
        identity.extensionId,
      );
      await assert.rejects(lstat(partial), { code: 'ENOENT' });
    }
  },
);

test(
  'managed launcher diagnostics reject a changed release and work through path aliases',
  { skip: macOnly },
  async (context) => {
    const { inspectRegisteredLauncher } = await import('../installation/launcher-check.mjs');
    const directory = await temporary(context);
    const bundle = await fixtureBundle(directory);
    const home = path.join(directory, 'home');
    const destination = path.join(home, 'Miter');
    const installed = await installLocalBundle({
      bundle,
      destination,
      home,
      dataHome: path.join(home, 'state'),
    });
    const file = path.join(destination, 'bin/miter-host');

    assert.equal(
      (await inspectRegisteredLauncher(file, identity.extensionId, 'darwin')).root,
      installed.release,
    );
    const native = path.join(installed.release, 'dist/apps/host/src/native.js');

    await writeFile(native, 'changed host bytes');
    await assert.rejects(inspectRegisteredLauncher(file, identity.extensionId, 'darwin'), /files changed/);
    // A different valid bundle must not be accepted under the recorded hash.
    await seal(installed.release);
    await assert.rejects(
      inspectRegisteredLauncher(file, identity.extensionId, 'darwin'),
      /no longer matches/,
    );
    const repaired = await installLocalBundle({
      bundle,
      destination,
      home,
      dataHome: path.join(home, 'state'),
    });

    assert.notEqual(repaired.release, installed.release);
    assert.equal(await readFile(native, 'utf8'), 'changed host bytes');
    assert.match(
      await readFile(path.join(repaired.release, 'dist/apps/host/src/native.js'), 'utf8'),
      /fixture-host/,
    );
    assert.equal(
      (await inspectRegisteredLauncher(file, identity.extensionId, 'darwin')).root,
      repaired.release,
    );
    const state = JSON.parse(await readFile(path.join(destination, 'installation.json'), 'utf8'));

    assert.match(state.repairId, /^[a-f0-9]{16}$/);
    assert.equal(state.release, (await verifyBundle(bundle)).release);
    const repeated = await installLocalBundle({
      bundle,
      destination,
      home,
      dataHome: path.join(home, 'state'),
    });

    assert.equal(repeated.release, repaired.release);
    assert.equal((await readdir(path.join(destination, 'releases'))).length, 2);
    await writeFile(
      path.join(destination, 'installation.json'),
      JSON.stringify({ ...state, repairId: '../../outside' }),
    );
    await assert.rejects(
      inspectRegisteredLauncher(file, identity.extensionId, 'darwin'),
      /metadata is invalid/,
    );
  },
);

test(
  'installer ZIP retains executable modes and confined links, and protects an existing checksum target',
  { skip: macOnly, timeout: 60000 },
  async (context) => {
    const { createBundleArchive } = await import('../installation/archive.mjs');
    const directory = await temporary(context);
    const bundle = await fixtureBundle(directory);

    await writeFile(path.join(bundle, 'linked.txt'), 'retained contents');
    await symlink('linked.txt', path.join(bundle, 'relative-link'));
    await seal(bundle);
    const archive = await createBundleArchive(bundle);

    assert.ok(archive.bytes > 0);
    assert.equal(digest(await readFile(archive.file)), archive.sha256);
    const extracted = path.join(directory, 'extracted');

    await mkdir(extracted);
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive.file, extracted], { timeout: 30000 });
    const restored = path.join(extracted, path.basename(bundle));

    await verifyBundle(restored);
    assert.equal((await lstat(path.join(restored, 'relative-link'))).isSymbolicLink(), true);
    assert.equal(
      execFileSync(path.join(restored, 'runtime/node'), ['--version'], { encoding: 'utf8' }).trim(),
      process.version,
    );
    const protectedFile = path.join(directory, 'protected-checksum.txt');

    await writeFile(protectedFile, 'personal data');
    await rm(archive.file + '.sha256');
    await symlink(protectedFile, archive.file + '.sha256');
    await writeFile(path.join(bundle, 'linked.txt'), 'updated contents');
    await seal(bundle);
    await assert.rejects(createBundleArchive(bundle), /linked or non-regular/);
    assert.equal(await readFile(protectedFile, 'utf8'), 'personal data');
    assert.equal(digest(await readFile(archive.file)), archive.sha256);
  },
);

test(
  'reinstall preserves custom state without its environment variable and respects explicit overrides',
  { skip: macOnly },
  async (context) => {
    const { registeredLauncherDetails } = await import('../installation/launcher-check.mjs');
    const directory = await temporary(context);
    const bundle = await fixtureBundle(directory);
    const home = path.join(directory, 'home');
    const destination = path.join(home, 'Miter');
    const custom = path.join(home, "custom state's folder");
    const saved = process.env.MITTER_HOME;

    delete process.env.MITTER_HOME;
    context.after(() => {
      if (saved === undefined) {
        delete process.env.MITTER_HOME;
      } else {
        process.env.MITTER_HOME = saved;
      }
    });
    await mkdir(custom, { recursive: true });
    await writeFile(path.join(custom, 'keep.txt'), 'existing state');
    const first = await installLocalBundle({ bundle, destination, home, dataHome: custom });
    const launcher = path.join(first.destination, 'bin/miter-host');

    await installLocalBundle({ bundle, destination, home });
    assert.equal(registeredLauncherDetails(await readFile(launcher, 'utf8')).dataDirectory, custom);
    await writeFile(path.join(destination, '.miter-installation.json'), '{');
    await installLocalBundle({ bundle, destination, home });
    assert.equal(registeredLauncherDetails(await readFile(launcher, 'utf8')).dataDirectory, custom);
    const other = path.join(home, 'explicit-state');

    await installLocalBundle({ bundle, destination, home, dataHome: other });
    assert.equal(registeredLauncherDetails(await readFile(launcher, 'utf8')).dataDirectory, other);
    await installLocalBundle({ bundle, destination, home, dataHome: '' });
    assert.equal(
      registeredLauncherDetails(await readFile(launcher, 'utf8')).dataDirectory,
      path.join(home, '.mitter'),
    );
    assert.equal(await readFile(path.join(custom, 'keep.txt'), 'utf8'), 'existing state');
    assert.deepEqual(await readdir(custom), ['keep.txt']);
  },
);

test(
  'first managed install preserves recognized source registration state and refuses conflicting locations',
  { skip: macOnly },
  async (context) => {
    const { launcherSource, registrationPaths, registrationManifest } =
      await import('../installation/registration.mjs');
    const { registeredLauncherDetails } = await import('../installation/launcher-check.mjs');
    const directory = await temporary(context);
    const bundle = await fixtureBundle(directory);
    const home = path.join(directory, 'home');
    const destination = path.join(home, 'Miter');
    const custom = path.join(home, 'old-custom-state');
    const sourceRoot = path.join(directory, 'old-checkout');
    const paths = registrationPaths({
      platform: 'darwin',
      home,
      root: sourceRoot,
      dataHome: custom,
      browser: 'chrome',
      nativeHost: identity.nativeHost,
    });
    const source = launcherSource({
      ...paths,
      platform: 'darwin',
      root: sourceRoot,
      nodeExecutable: '/old/runtime/node',
      portable: false,
    });
    const saved = process.env.MITTER_HOME;

    delete process.env.MITTER_HOME;
    context.after(() => {
      if (saved === undefined) {
        delete process.env.MITTER_HOME;
      } else {
        process.env.MITTER_HOME = saved;
      }
    });
    await mkdir(paths.installDirectory, { recursive: true });
    await mkdir(paths.manifestDirectory, { recursive: true });
    await writeFile(paths.launcher, source, { mode: 0o700 });
    await writeFile(paths.manifestPath, JSON.stringify(registrationManifest(identity, paths.launcher)));
    const installed = await installLocalBundle({ bundle, destination, home });
    const managedLauncher = path.join(installed.destination, 'bin/miter-host');

    assert.equal(registeredLauncherDetails(await readFile(managedLauncher, 'utf8')).dataDirectory, custom);
    const originalManaged = await readFile(managedLauncher);
    const other = path.join(home, 'different-state');

    await writeFile(
      paths.launcher,
      launcherSource({
        ...paths,
        dataDirectory: other,
        platform: 'darwin',
        root: sourceRoot,
        nodeExecutable: '/old/runtime/node',
        portable: false,
      }),
    );
    await writeFile(paths.manifestPath, JSON.stringify(registrationManifest(identity, paths.launcher)));
    const originalManifest = await readFile(paths.manifestPath);

    await assert.rejects(installLocalBundle({ bundle, destination, home }), /safely preserve/);
    assert.deepEqual(await readFile(managedLauncher), originalManaged);
    assert.deepEqual(await readFile(paths.manifestPath), originalManifest);
    await installLocalBundle({ bundle, destination, home, dataHome: custom });
    assert.equal(registeredLauncherDetails(await readFile(managedLauncher, 'utf8')).dataDirectory, custom);
  },
);
