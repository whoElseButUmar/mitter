import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { type ProcessOptions, runStage } from './process.js';

/** The caller recognizes the build-script shape. Only the installed compiler runs in the build sandbox. */
export async function runViteTypecheck(options: Omit<ProcessOptions, 'args'>, flags: string[]) {
  const modules = path.join(options.cwd, 'node_modules');
  let compiler: string;
  try {
    const typescript = await realpath(path.join(modules, 'typescript'));
    compiler = await realpath(path.join(typescript, 'bin', 'tsc'));
    if (!typescript.startsWith(modules + path.sep) || !compiler.startsWith(typescript + path.sep)) {
      throw new Error('Unexpected TypeScript compiler path.');
    }
  } catch (cause) {
    throw new Error(
      'The build calls tsc. Declare typescript in the project dependencies so Miter can run its local compiler.',
      { cause },
    );
  }
  options.onOutput?.('Checking the production build with TypeScript.\n');
  await runStage({ ...options, args: [compiler, ...flags] }, 'TypeScript check', 180_000);
}
