import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  parseSetupArguments,
  readBootstrapProject,
  readPackageManager,
  supportsSetupNode,
} from './installation/bootstrap.mjs';
import { errorMessage, isMainModule } from './helpers/runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';

function run(program, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      stdio: 'inherit',
      shell: windows,
      env: environment,
    });

    child.once('error', (error) => {
      if (error.code === 'ENOENT' && (program === 'npx' || program === 'npx.cmd')) {
        reject(
          new Error('npx was not found. Install Node.js 26 or newer with npm/npx, then rerun setup.', {
            cause: error,
          }),
        );

        return;
      }

      reject(error);
    });
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${program} exited ${code}`));
      }
    });
  });
}

async function setup() {
  let options;

  try {
    options = parseSetupArguments(process.argv.slice(2));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;

    return;
  }

  if (options.help) {
    console.log(
      'Install dependencies, build and install Miter in a stable local folder (macOS, Node.js 26+). ' +
        '--build-only builds the source without installing; --chromium uses Chromium; ' +
        '--destination=PATH chooses the managed install folder.',
    );

    return;
  }

  if (!supportsSetupNode(process.versions.node)) {
    console.error(
      'Miter needs Node.js 26 or newer, including its automatic app checks. Upgrade Node, then rerun node scripts/setup.mjs.',
    );
    process.exitCode = 1;

    return;
  }

  if (!options.buildOnly && process.platform !== 'darwin') {
    console.error(
      'The managed installer and automatic app checks currently require macOS. Use --build-only for a source build on this platform.',
    );
    process.exitCode = 1;

    return;
  }

  let step = 'Read installation settings';
  let packageManager;

  try {
    const project = readBootstrapProject(root);
    packageManager = readPackageManager(project);
    let program = 'npx';

    if (windows) {
      program = 'npx.cmd';
    }

    function pnpm(...args) {
      return run(program, ['--yes', packageManager, ...args], {
        ...process.env,
        PNPM_CONFIG_STRICT_DEP_BUILDS: 'true',
      });
    }

    step = 'Install approved dependencies';
    console.log('[1/4] ' + step + ' with ' + packageManager);
    // Checked-in allowBuilds owns consent. Unknown scripts stop installation;
    // setup must never approve them implicitly or open an unconditional prompt.
    await pnpm('install', '--no-frozen-lockfile');
    step = 'Build and verify production assets';
    console.log('[2/4] ' + step);
    await pnpm('build');
    step = 'Prepare the native terminal';
    console.log('[3/4] ' + step);
    await run(process.execPath, ['scripts/prepare-terminal.mjs', '--repair']);

    if (options.buildOnly) {
      console.log('[4/4] Source build ready. No native host was registered.');
      console.log('Extension folder: ' + path.join(root, 'apps/extension/.output/chrome-mv3'));
    } else {
      step = 'Verify and install a stable local copy';
      console.log('[4/4] ' + step);
      const { createLocalBundle } = await import('./installation/bundle.mjs');
      const { installLocalBundle, printInstalled } = await import('./installation/install.mjs');
      const bundle = await createLocalBundle(root);
      const result = await installLocalBundle({
        bundle,
        destination: options.destination,
        chromium: options.chromium,
      });

      printInstalled(result);
      console.log('Reusable local installer: ' + path.join(bundle, 'Install Miter.command'));
    }
  } catch (error) {
    console.error('Setup stopped: ' + step + ': ' + errorMessage(error));

    if (step === 'Install approved dependencies') {
      console.error(
        'Check the package-manager error above. If it reports unreviewed build scripts, review those named packages with npx --yes ' +
          packageManager +
          ' approve-builds, then rerun setup. Existing allowBuilds permissions were not broadened by setup.',
      );
    } else {
      console.error('Fix the reported step, then rerun node scripts/setup.mjs with the same options.');
    }
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  await setup();
}
