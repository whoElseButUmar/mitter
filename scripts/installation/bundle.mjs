import { readFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyBuild } from '../verify-build.mjs';
import { verifyBundle, verifyPackagedRuntime } from './verification.mjs';

import { errorMessage, isMainModule } from '../helpers/runtime.mjs';
import { supportsSetupNode } from './bootstrap.mjs';
import { installedPackageSchema } from './contracts.mjs';
import { bundleManifestSchema } from './bundle-contracts.mjs';
import { copyDependencies } from './dependencies.mjs';
import { canonicalDestination, copyTree, digest, inside, inventory, rejectLinks } from './files.mjs';

export async function buildLocalBundle({ root, output }) {
  if (process.platform !== 'darwin' || !supportsSetupNode(process.versions.node)) {
    throw new Error('Local install bundles require macOS and Node.js 26 or newer.');
  }

  root = await canonicalDestination(root);
  output = await canonicalDestination(output);

  if (
    inside(output, root) ||
    (inside(root, output) && !inside(path.join(root, '.cache'), output)) ||
    output.includes('\0')
  ) {
    throw new Error('Bundle output must not replace the source checkout or any parent directory.');
  }

  const project = installedPackageSchema.parse(
    JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')),
  );

  await verifyBuild(root);
  await mkdir(output, { recursive: false, mode: 0o700 });
  let complete = false;

  try {
    for (const file of [
      'dist',
      'brand',
      'apps/extension/public',
      'apps/extension/.output/chrome-mv3',
      'package.json',
      'LICENSE',
      'THIRD_PARTY.md',
    ]) {
      await copyTree(path.join(root, file), path.join(output, file));
    }

    await copyTree(path.join(root, 'scripts'), path.join(output, 'scripts'), {
      exclude: new Set(['test', 'release-checks']),
      include: (relative) => !relative.endsWith('.test.mjs') && relative !== 'fonts/test-fixture.mjs',
    });

    await copyTree(process.execPath, path.join(output, 'runtime/node'));
    const license = process.env.MITER_NODE_LICENSE || path.resolve(process.execPath, '../../LICENSE');

    try {
      await copyTree(license, path.join(output, 'runtime/LICENSE'));
    } catch (error) {
      throw new Error(
        'The installed Node license was not found. Set MITER_NODE_LICENSE to this Node distribution’s LICENSE file, then recreate the bundle.',
        { cause: error },
      );
    }
    const dependencies = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).dependencies;

    await copyDependencies(root, output, Object.keys(dependencies));
    verifyPackagedRuntime(output);
    const nodeHash = digest(await readFile(path.join(output, 'runtime/node')));
    const launcher =
      '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\n' +
      `printf '%s  %s\\n' '${nodeHash}' 'runtime/node' | /usr/bin/shasum -a 256 -c - >/dev/null\n` +
      'exec ./runtime/node scripts/installation/install.mjs "$@"\n';

    await writeFile(path.join(output, 'Install Miter.command'), launcher, { mode: 0o700 });
    const manifest = bundleManifestSchema.parse({
      format: 1,
      version: project.version,
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      files: await inventory(output),
    });

    await writeFile(path.join(output, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o600,
    });
    await verifyBundle(output);
    complete = true;

    return output;
  } finally {
    if (!complete) {
      await rm(output, { recursive: true, force: true });
    }
  }
}

export async function createLocalBundle(root) {
  const parent = path.join(root, '.cache/installers');

  await rejectLinks(parent, root);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, '.building-'));
  const output = path.join(staging, 'Miter');

  try {
    await buildLocalBundle({ root, output });
    const { manifest, release } = await verifyBundle(output);
    const final = path.join(parent, `Miter-${manifest.version}-${process.arch}-${release.slice(0, 12)}`);

    try {
      await rename(output, final);
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') {
        throw error;
      }

      await verifyBundle(final);
    }

    return final;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  try {
    if (process.argv.length !== 2) {
      throw new Error('Usage: node scripts/installation/bundle.mjs');
    }

    const output = await createLocalBundle(path.resolve(import.meta.dirname, '../..'));

    console.log('Creating and checking the installer ZIP…');
    const { createBundleArchive } = await import('./archive.mjs');
    const archive = await createBundleArchive(output);

    console.log('Installer ZIP: ' + archive.file + ' (' + Math.ceil(archive.bytes / 1024 / 1024) + ' MiB)');
    console.log('SHA-256: ' + archive.sha256);
    console.log('Verified local macOS bundle: ' + output);
    console.log('Install or update: open ' + path.join(output, 'Install Miter.command'));
    console.log('Built for this Mac architecture. No signing or notarization is included.');
  } catch (error) {
    console.error('Bundle creation stopped: ' + errorMessage(error));
    process.exitCode = 1;
  }
}
