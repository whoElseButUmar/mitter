import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { digest } from '../installation/files.mjs';
import { downloadVerifiedAsset, selectAsset } from '../installation/npm/install.mjs';
import { createNpmInstaller } from '../installation/npm/package.mjs';
import { freshInstallEnvironment } from '../release-checks/fresh-install.mjs';

const releaseDirectory = 'https://example.com/releases/v1.0.0';
const asset = {
  directory: 'Miter-1.0.0-arm64-0123456789ab',
  url: releaseDirectory + '/Miter-1.0.0-arm64-0123456789ab.zip',
  bytes: 5,
  sha256: digest('miter'),
};

async function fixtureDirectory(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'miter-npm-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function zipFixture(parent, architecture, version = '1.0.0') {
  const file = { path: 'test-file', sha256: digest('test'), mode: 0o600 };
  const manifest = JSON.stringify({
    format: 1,
    version,
    platform: 'darwin',
    architecture,
    node: '26.5.1',
    files: [file],
  });
  const directory = `Miter-${version}-${architecture}-${digest(manifest).slice(0, 12)}`;
  const bundle = path.join(parent, directory);
  const zip = path.join(parent, directory + '.zip');
  await mkdir(bundle);
  await writeFile(path.join(bundle, 'bundle.json'), manifest);
  await writeFile(path.join(bundle, file.path), 'test');
  execFileSync('/usr/bin/zip', ['-q', '-r', zip, directory], { cwd: parent });
  await writeFile(zip + '.sha256', digest(await readFile(zip)) + '  ' + path.basename(zip) + '\n');
  return zip;
}

test('npm installer selects only a valid HTTPS asset for the running Mac', () => {
  const release = { version: '1.0.0', assets: { arm64: asset } };
  assert.equal(selectAsset(release, 'darwin', 'arm64'), asset);
  assert.throws(() => selectAsset(release, 'linux', 'arm64'), /requires.*Mac/);
  assert.throws(() => selectAsset(release, 'darwin', 'x64'), /no installer/);

  for (const invalid of [
    { bytes: -1 },
    { sha256: 'a' },
    { directory: '../somewhere' },
    { url: asset.url.replace('https:', 'http:') },
    { url: asset.url + '?redirect=true' },
    { url: releaseDirectory + '/wrong.zip' },
  ]) {
    assert.throws(
      () => selectAsset({ ...release, assets: { arm64: { ...asset, ...invalid } } }, 'darwin', 'arm64'),
      /invalid/,
    );
  }
});

test('npm installer checks streamed bytes and rejects truncated, changed, and oversized downloads', async (context) => {
  const directory = await fixtureDirectory(context);
  let response = 'miter';
  context.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    url: asset.url,
    body: new Response(response).body,
  }));

  const filename = path.join(directory, 'verified.zip');
  await downloadVerifiedAsset(asset, filename);
  assert.equal(await readFile(filename, 'utf8'), 'miter');

  for (const [bytes, error] of [
    ['mite', /published checksum/],
    ['miter2', /expected size/],
    ['mitez', /published checksum/],
  ]) {
    response = bytes;
    await assert.rejects(downloadVerifiedAsset(asset, path.join(directory, bytes + '.zip')), error);
  }
});

test(
  'npm package pins both Mac assets and npx runs its executable',
  { skip: process.platform !== 'darwin' },
  async (context) => {
    const directory = await fixtureDirectory(context);
    const [arm, intel] = await Promise.all([zipFixture(directory, 'arm64'), zipFixture(directory, 'x64')]);
    const output = path.join(directory, 'packages');
    const pkg = await createNpmInstaller({ releaseDirectory, archives: [arm, intel], output });
    const manifest = JSON.parse(
      execFileSync('/usr/bin/tar', ['-xOf', pkg, 'package/release.json'], { encoding: 'utf8' }),
    );
    const readme = execFileSync('/usr/bin/tar', ['-xOf', pkg, 'package/README.md'], { encoding: 'utf8' });
    assert.equal(readme, await readFile(new URL('../installation/npm/README.md', import.meta.url), 'utf8'));
    assert.equal(manifest.version, '1.0.0');
    assert.deepEqual(Object.keys(manifest.assets), ['arm64', 'x64']);

    for (const [architecture, zip] of [
      ['arm64', arm],
      ['x64', intel],
    ]) {
      assert.equal(manifest.assets[architecture].url, releaseDirectory + '/' + path.basename(zip));
      const bytes = await readFile(zip);
      assert.equal(manifest.assets[architecture].sha256, digest(bytes));
      assert.equal(manifest.assets[architecture].bytes, bytes.length);
    }

    const env = freshInstallEnvironment(directory);
    await mkdir(env.HOME);
    await mkdir(env.TMPDIR);
    const help = execFileSync('npx', ['--yes', '--offline', '--package=' + pkg, 'miter-install', '--help'], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.match(help, /Usage: npx miter-install@latest/);

    const revised = await createNpmInstaller({
      releaseDirectory,
      archives: [arm, intel],
      output,
      npmVersion: '1.0.1',
    });
    const revisedMetadata = JSON.parse(
      execFileSync('/usr/bin/tar', ['-xOf', revised, 'package/package.json'], { encoding: 'utf8' }),
    );
    const revisedRelease = JSON.parse(
      execFileSync('/usr/bin/tar', ['-xOf', revised, 'package/release.json'], { encoding: 'utf8' }),
    );
    assert.equal(revisedMetadata.version, '1.0.1');
    assert.deepEqual(revisedRelease, manifest);
    await assert.rejects(
      createNpmInstaller({ releaseDirectory, archives: [arm], output, npmVersion: '../unsafe' }),
      /valid npm package version/,
    );

    const differentVersion = await zipFixture(directory, 'x64', '1.0.1');
    await assert.rejects(
      createNpmInstaller({ releaseDirectory, archives: [arm, differentVersion], output }),
      /same Miter version/,
    );
    await assert.rejects(
      createNpmInstaller({ releaseDirectory, archives: [arm, arm], output }),
      /one ZIP per architecture/,
    );
    await writeFile(arm + '.sha256', 'changed checksum');
    await assert.rejects(
      createNpmInstaller({ releaseDirectory, archives: [arm], output }),
      /does not match the checksum/,
    );
  },
);
