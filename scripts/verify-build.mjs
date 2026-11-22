/** Fail setup before host registration if extension/host/page assets disagree. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { verifyBundledFont } from './prepare-font.mjs';
import { checkManifestSecurity } from './check-security-policy.mjs';
import { checkBundleImports } from './check-bundle-imports.mjs';
import { checkPreviewSandboxBundle } from './build/preview-sandbox.mjs';
import { buildPackageSchema, buildManifestSchema, buildVerificationSchema } from './build/contracts.mjs';
import { extensionIdentitySchema } from './installation/contracts.mjs';
import { errorMessage, isMainModule, parseJsonContract } from './helpers/runtime.mjs';

export async function verifyBuild(root) {
  const packageText = await readFile(path.join(root, 'package.json'), 'utf8');
  const sourcePackage = parseJsonContract(
    buildPackageSchema,
    packageText,
    'Invalid source package version in package.json. Check the release version before rebuilding.',
  );
  const output = path.join(root, 'apps/extension/.output/chrome-mv3');
  const manifestText = await readFile(path.join(output, 'manifest.json'), 'utf8');
  const manifest = parseJsonContract(
    buildManifestSchema,
    manifestText,
    'Invalid built extension manifest. Run pnpm build before registration.',
  );
  const releaseVersion = sourcePackage.version.split('-')[0];
  const prereleaseVersionMismatch =
    sourcePackage.version.includes('-') && manifest.version_name !== sourcePackage.version;

  if (manifest.version !== releaseVersion || prereleaseVersionMismatch) {
    throw new Error(
      `Extension ${manifest.version} does not match source ${sourcePackage.version}. Rebuild before registration.`,
    );
  }

  checkManifestSecurity(manifest);

  const identityText = await readFile(path.join(root, 'brand/extension-identity.json'), 'utf8');
  const identity = parseJsonContract(
    extensionIdentitySchema,
    identityText,
    'Invalid extensionId or key in brand/extension-identity.json. Restore the stable identity before rebuilding.',
  );

  if (!manifest.key) {
    throw new Error('The stable extension key is missing.');
  }

  const publicKeyDigest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex');
  const extensionId = publicKeyDigest.slice(0, 32).replace(/[0-9a-f]/g, (digit) => {
    return String.fromCharCode(97 + parseInt(digit, 16));
  });

  if (extensionId !== identity.extensionId) {
    throw new Error('The extension ID changed. Host registration must not use a different origin.');
  }

  for (const permission of ['scripting', 'nativeMessaging', 'storage', 'sidePanel']) {
    if (!manifest.permissions.includes(permission)) {
      throw new Error(`Required permission missing: ${permission}`);
    }
  }

  const transportUrl = pathToFileURL(path.join(root, 'dist/packages/bridge/src/page-transport.js'));
  let transport;

  try {
    transport = await import(transportUrl.href);
  } catch (error) {
    throw new Error('The compiled page-transport module is unavailable. Run pnpm build.', { cause: error });
  }

  const { PAGE_CHANNEL, PAGE_READER } = transport;

  if (
    typeof PAGE_CHANNEL !== 'string' ||
    typeof PAGE_READER !== 'string' ||
    PAGE_CHANNEL.length === 0 ||
    PAGE_READER.length === 0
  ) {
    throw new Error('The compiled page-transport constants are missing. Run pnpm build.');
  }

  const bundledPage = await readFile(path.join(output, 'mitter-page.js'));
  const sourcePage = await readFile(path.join(root, 'apps/extension/public/mitter-page.js'));

  if (
    !bundledPage.equals(sourcePage) ||
    !bundledPage.includes(Buffer.from(PAGE_CHANNEL)) ||
    !bundledPage.includes(Buffer.from(PAGE_READER))
  ) {
    throw new Error('The packaged chat page bridge is missing or stale. Rebuild the extension.');
  }

  if (!manifest.sandbox?.pages?.includes('preview-sandbox.html')) {
    throw new Error('The isolated preview sandbox is missing from the manifest.');
  }

  for (const filename of ['preview-sandbox.html', 'preview-sandbox.js']) {
    const bundledAsset = await readFile(path.join(output, filename));
    const sourceAsset = await readFile(path.join(root, 'apps/extension/public', filename));

    if (!bundledAsset.equals(sourceAsset)) {
      throw new Error('The packaged preview sandbox is stale: ' + filename);
    }

    if (filename === 'preview-sandbox.js') {
      checkPreviewSandboxBundle(bundledAsset.toString('utf8'), filename);
    }
  }

  for (const filename of [
    'skills/caveman/SKILL.md',
    'skills/caveman/LICENSE',
    'skills/no-ai-slop/SKILL.md',
    'skills/no-ai-slop/eval.md',
    'skills/no-ai-slop/LICENSE',
    'skills/ponytail/SKILL.md',
    'skills/ponytail/LICENSE',
    'skills/NOTICE.md',
  ]) {
    let bundledAsset;
    let sourceAsset;

    try {
      bundledAsset = await readFile(path.join(output, filename));
      sourceAsset = await readFile(path.join(root, 'apps/extension/public', filename));
    } catch (error) {
      throw new Error('Missing or unreadable bundled skill asset: ' + filename + '. Run pnpm build.', {
        cause: error,
      });
    }

    if (bundledAsset.length === 0 || sourceAsset.length === 0) {
      throw new Error('Empty bundled skill asset: ' + filename + '. Restore its source, then rebuild.');
    }

    if (!bundledAsset.equals(sourceAsset)) {
      throw new Error('The packaged skill asset is stale: ' + filename + '. Run pnpm build.');
    }
  }

  for (const filename of [
    'sidepanel.html',
    'workspace.html',
    'file.html',
    'preview-sandbox.html',
    'background.js',
  ]) {
    const asset = await readFile(path.join(output, filename));

    if (asset.length === 0) {
      throw new Error(`Empty extension asset: ${filename}`);
    }

    if (filename.endsWith('.html')) {
      const references = asset
        .toString('utf8')
        .matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi);

      for (const reference of references) {
        const assetUrl = new URL(reference[1], 'https://extension.invalid/' + filename);
        const assetFile = path.resolve(output, '.' + decodeURIComponent(assetUrl.pathname));
        const relativeFile = path.relative(output, assetFile);

        if (
          assetUrl.origin !== 'https://extension.invalid' ||
          relativeFile === '..' ||
          relativeFile.startsWith('..' + path.sep) ||
          path.isAbsolute(relativeFile)
        ) {
          throw new Error('Packaged page asset escapes extension output: ' + reference[1]);
        }

        try {
          await readFile(assetFile);
        } catch (error) {
          throw new Error('Missing packaged page asset: ' + relativeFile + '. Run pnpm build.', {
            cause: error,
          });
        }
      }
    }
  }

  for (const filename of [
    'dist/apps/host/src/native.js',
    'dist/apps/host/src/cli.js',
    'dist/apps/inference/src/worker.js',
  ]) {
    let asset;

    try {
      asset = await readFile(path.join(root, filename));
    } catch (error) {
      throw new Error('Missing or empty build asset: ' + filename + '. Run pnpm build.', { cause: error });
    }

    if (asset.length === 0) {
      throw new Error('Missing or empty build asset: ' + filename + '. Run pnpm build.');
    }
  }

  const protocolUrl = pathToFileURL(path.join(root, 'dist/packages/protocol/src/index.js'));
  const protocol = await import(protocolUrl.href);

  if (protocol.APP_VERSION !== sourcePackage.version) {
    throw new Error('The compiled native host is from a different version.');
  }

  const terminalFont = await verifyBundledFont(output);
  const bundledImports = await checkBundleImports(output);

  const background = await readFile(path.join(output, 'background.js'), 'utf8');
  if (
    typeof protocol.BUILD_ID !== 'string' ||
    !/^[a-f0-9]{16}$/.test(protocol.BUILD_ID) ||
    !background.includes(protocol.BUILD_ID)
  ) {
    throw new Error(
      'The extension and local helper have different build IDs. Run pnpm build to rebuild them together.',
    );
  }

  return buildVerificationSchema.parse({
    version: sourcePackage.version,
    extensionId,
    terminalFont,
    bundleModulesChecked: bundledImports.checked,
    pageSHA256: createHash('sha256').update(bundledPage).digest('hex'),
  });
}

if (isMainModule(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');

  try {
    const result = await verifyBuild(root);

    console.log(
      `Build verified: Miter ${result.version}; host, extension ID and packaged page bridge match.`,
    );
  } catch (error) {
    console.error('Build verification failed:', errorMessage(error));
    process.exitCode = 1;
  }
}
