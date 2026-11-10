import { readFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { atomicConfig, configTransaction } from './atomic-config.mjs';
import { extensionIdentitySchema } from './installation/contracts.mjs';
import {
  launcherSource,
  parseRegistrationArguments,
  registrationManifest,
  registrationPaths,
  registryArguments,
} from './installation/registration.mjs';
import { errorMessage, hasErrorCode, isMainModule, parseJsonContract } from './helpers/runtime.mjs';

async function registerHost() {
  const root = path.resolve(import.meta.dirname, '..');
  const options = parseRegistrationArguments(process.argv.slice(2));

  if (options.help) {
    console.log(
      'Usage: node scripts/register-host.mjs [--chromium] [--portable] [--remove] [--manifest-dir=PATH]',
    );

    return;
  }

  const serializedIdentity = await readFile(path.join(root, 'brand/extension-identity.json'), 'utf8');
  const identity = parseJsonContract(
    extensionIdentitySchema,
    serializedIdentity,
    'Invalid extension identity. Restore brand/extension-identity.json before native host registration.',
  );
  const paths = registrationPaths({
    ...options,
    root,
    platform: process.platform,
    home: os.homedir(),
    dataHome: process.env.MITTER_HOME,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    nativeHost: identity.nativeHost,
  });
  const manifest = registrationManifest(identity, paths.launcher);

  const files = [paths.manifestPath];

  if (!options.remove) {
    try {
      const { verifyBuild } = await import('./verify-build.mjs');
      await verifyBuild(root);
    } catch (error) {
      throw new Error(
        'Build verification failed before registration. Run pnpm build, then pnpm verify:build.',
        {
          cause: error,
        },
      );
    }

    await mkdir(paths.installDirectory, { recursive: true, mode: 0o700 });
    await mkdir(paths.manifestDirectory, { recursive: true });
    files.unshift(paths.launcher);
  }

  await configTransaction(files, async () => {
    if (!options.remove) {
      // Fail before registering a nonexistent build.
      await readFile(paths.hostScript);
      const source = launcherSource({
        ...paths,
        platform: process.platform,
        nodeExecutable: process.execPath,
        root,
        portable: options.portable,
      });

      await atomicConfig(paths.launcher, source, 0o700);
    }

    if (options.remove) {
      try {
        await unlink(paths.manifestPath);
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          throw error;
        }
      }
    } else {
      const serializedManifest = JSON.stringify(manifest, null, 2) + '\n';

      await atomicConfig(paths.manifestPath, serializedManifest, 0o600);
    }

    if (process.platform === 'win32' && !options.manifestDirectory) {
      const args = registryArguments(
        options.browser,
        identity.nativeHost,
        paths.manifestPath,
        options.remove,
      );
      const result = spawnSync('reg', args, { stdio: 'inherit', shell: false });

      if (result.error || result.status !== 0) {
        throw new Error('Windows native-host registry update failed.');
      }
    }
  });

  let action = 'Registered';

  if (options.remove) {
    action = 'Removed';
  }

  console.log(`${action} ${identity.nativeHost} for ${options.browser}.`);
  console.log('Manifest:', paths.manifestPath);
  console.log('Extension ID:', identity.extensionId);

  if (!options.remove) {
    console.log('Next: Chrome → Extensions → Developer mode → Load unpacked');
    console.log(path.join(root, 'apps/extension/.output/chrome-mv3'));
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await registerHost();
  } catch (error) {
    console.error('Host registration stopped:', errorMessage(error));
    process.exitCode = 1;
  }
}
