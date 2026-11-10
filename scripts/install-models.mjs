import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  readBootstrapProject,
  readModelRuntimePackages,
  readPackageManager,
} from './installation/bootstrap.mjs';
import { errorMessage, isMainModule } from './helpers/runtime.mjs';

function installModels() {
  const argumentsList = process.argv.slice(2);

  if (argumentsList.length > 1 || argumentsList.some((argument) => argument !== '--help')) {
    console.error('Usage: node scripts/install-models.mjs [--help]');
    process.exitCode = 1;

    return;
  }

  if (argumentsList.includes('--help')) {
    console.log(
      'Install optional local inference libraries (not model weights). ' +
        'This changes package.json and the lockfile and requires network access.',
    );

    return;
  }

  try {
    const root = path.resolve(import.meta.dirname, '..');
    const project = readBootstrapProject(root);
    const packageManager = readPackageManager(project);
    const packages = readModelRuntimePackages(project);
    const args = ['--yes', packageManager, 'add', '--workspace-root', '--save-optional', ...packages];
    const windows = process.platform === 'win32';
    let program = 'npx';

    if (windows) {
      program = 'npx.cmd';
    }

    console.log(
      'Installing local inference libraries (not model weights). ' +
        'This changes package.json and the lockfile. Network access is required for this installation only.',
    );
    const child = spawn(program, args, {
      cwd: root,
      stdio: 'inherit',
      shell: windows,
    });

    child.on('error', (error) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;

      if (code === 0) {
        console.log(
          'Run node scripts/doctor.mjs to check the optional libraries. ' +
            'Then configure your own local GGUF file path in Mitter.',
        );
      }
    });
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  installModels();
}
