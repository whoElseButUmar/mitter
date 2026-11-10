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

function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      stdio: 'inherit',
      shell: windows,
    });

    child.once('error', reject);
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
      'Install dependencies and build Miter. --build-only skips native-host registration; ' +
        '--chromium registers with Chromium.',
    );

    return;
  }

  if (!supportsSetupNode(process.versions.node)) {
    console.error('Miter needs Node.js >=22.16.0.');
    process.exitCode = 1;

    return;
  }

  try {
    const project = readBootstrapProject(root);
    const packageManager = readPackageManager(project);
    let program = 'npx';

    if (windows) {
      program = 'npx.cmd';
    }

    function pnpm(...args) {
      return run(program, ['--yes', packageManager, ...args]);
    }

    await pnpm('install', '--no-frozen-lockfile');
    // pnpm owns dependency build consent. The user makes any pending selections.
    await pnpm('approve-builds');
    await pnpm('build');
    await run(process.execPath, ['scripts/prepare-terminal.mjs', '--repair']);

    if (!options.buildOnly) {
      const registrationArguments = ['scripts/register-host.mjs'];

      if (options.chromium) {
        registrationArguments.push('--chromium');
      }

      await run(process.execPath, registrationArguments);
    }

    console.log(
      'Build ready. Load or reload apps/extension/.output/chrome-mv3 in Chrome. ' +
        'Keep this folder in place after registration.',
    );
  } catch (error) {
    console.error('Setup stopped:', errorMessage(error));
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  await setup();
}
