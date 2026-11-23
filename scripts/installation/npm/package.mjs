import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorMessage, isMainModule, parseContract } from '../../helpers/runtime.mjs';
import { bundleManifestSchema } from '../bundle-contracts.mjs';
import { installedPackageSchema } from '../contracts.mjs';
import { digest, rejectLinks } from '../files.mjs';

const usage =
  'Usage: pnpm bundle:npm [--npm-version=VERSION] HTTPS_RELEASE_DIRECTORY BUNDLE.zip [BUNDLE.zip]';
const versionOption = '--npm-version=';
const projectRoot = path.resolve(import.meta.dirname, '../../..');

function releaseDirectoryUrl(directory) {
  const url = new URL(directory);

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Provide an HTTPS release directory without credentials, query, or fragment.');
  }

  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }

  return url;
}

async function readReleaseAsset(archive, releaseDirectory) {
  archive = await realpath(archive);
  const filename = path.basename(archive);
  const directory = path.basename(archive, '.zip');

  if (!/^Miter-[A-Za-z0-9.+-]+-(?:arm64|x64)-[a-f0-9]{12}\.zip$/.test(filename)) {
    throw new Error('Choose a ZIP created by pnpm bundle:local: ' + archive);
  }

  const archiveStat = await stat(archive);

  if (!archiveStat.isFile()) {
    throw new Error('Choose a regular installer ZIP: ' + archive);
  }

  const manifest = execFileSync('/usr/bin/unzip', ['-p', archive, directory + '/bundle.json'], {
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const { architecture, version } = bundleManifestSchema.parse(JSON.parse(manifest.toString('utf8')));
  const expectedDirectory = `Miter-${version}-${architecture}-${digest(manifest).slice(0, 12)}`;

  if (directory !== expectedDirectory) {
    throw new Error('The installer ZIP name does not match its bundle metadata: ' + archive);
  }

  const hash = createHash('sha256');
  let bytes = 0;

  for await (const chunk of createReadStream(archive)) {
    bytes += chunk.length;
    hash.update(chunk);
  }

  const sha256 = hash.digest('hex');
  const checksum = await readFile(archive + '.sha256', 'utf8');

  if (bytes !== archiveStat.size || checksum !== sha256 + '  ' + filename + '\n') {
    throw new Error('The installer ZIP does not match the checksum from pnpm bundle:local: ' + archive);
  }

  return {
    architecture,
    version,
    asset: {
      directory,
      url: new URL(encodeURIComponent(filename), releaseDirectory).href,
      bytes,
      sha256,
    },
  };
}

export async function createNpmInstaller({ releaseDirectory, archives, output, npmVersion }) {
  if (archives.length < 1 || archives.length > 2) {
    throw new Error(usage);
  }

  const base = releaseDirectoryUrl(releaseDirectory);
  const release = { version: undefined, assets: {} };

  for (const archive of archives) {
    const { architecture, version, asset } = await readReleaseAsset(archive, base);
    release.version ??= version;

    if (release.version !== version || Object.hasOwn(release.assets, architecture)) {
      throw new Error('Choose one ZIP per architecture, all from the same Miter version.');
    }

    release.assets[architecture] = asset;
  }

  const version = parseContract(
    installedPackageSchema.shape.version,
    npmVersion ?? release.version,
    'Choose a valid npm package version.',
  );
  const staging = await mkdtemp(path.join(os.tmpdir(), 'miter-npm-package-'));

  try {
    const packageJson = {
      name: 'miter-install',
      version,
      description: 'Install or update the Miter workspace and local helper on macOS.',
      license: 'MIT',
      repository: { type: 'git', url: 'git+https://github.com/whoElseButUmar/mitter.git' },
      type: 'module',
      bin: { 'miter-install': 'install.mjs' },
      engines: { node: '>=22' },
      files: ['install.mjs', 'release.json', 'README.md', 'LICENSE'],
    };

    await writeFile(path.join(staging, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
    await writeFile(path.join(staging, 'release.json'), JSON.stringify(release, null, 2) + '\n');
    await copyFile(path.join(import.meta.dirname, 'install.mjs'), path.join(staging, 'install.mjs'));
    await copyFile(path.join(import.meta.dirname, 'README.md'), path.join(staging, 'README.md'));
    await copyFile(path.join(projectRoot, 'LICENSE'), path.join(staging, 'LICENSE'));
    await mkdir(output, { recursive: true });
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', output], {
      cwd: staging,
      timeout: 30000,
      stdio: 'pipe',
    });
    const artifact = path.join(output, `miter-install-${version}.tgz`);

    if (!(await stat(artifact)).isFile()) {
      throw new Error('npm did not produce the installer tarball.');
    }

    return artifact;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let npmVersion;

    if (args[0]?.startsWith(versionOption)) {
      npmVersion = args.shift().slice(versionOption.length);
    }

    const [releaseDirectory, ...archives] = args;

    if (releaseDirectory === '--help') {
      console.log(usage);
    } else {
      if (!releaseDirectory) {
        throw new Error(usage);
      }

      const output = path.join(projectRoot, '.cache/npm');
      await rejectLinks(output, projectRoot);
      const artifact = await createNpmInstaller({ releaseDirectory, archives, output, npmVersion });
      console.log('npm installer package: ' + artifact);
    }
  } catch (error) {
    console.error('npm package creation stopped. ' + errorMessage(error));
    process.exitCode = 1;
  }
}
