import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { hasErrorCode } from '../types.js';
import { installDependencies } from './install.js';
import type { Framework } from './project.js';

const exactVersion = z
  .object({
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/)
      .describe('Exact installed compiler release.'),
  })
  .describe('Compiler release used to select its official WebAssembly binding.');

type Binding = { name: string; version: string; wasm: string };

export async function quarantinedCompiler(native: string, name: string, signal: AbortSignal) {
  // Registry binaries downloaded under Chrome can inherit Gatekeeper quarantine.
  // Inspect the OS marker before trying to load native code or triggering verification.
  try {
    await promisify(execFile)('/usr/bin/xattr', ['-p', 'com.apple.quarantine', native], {
      signal,
      timeout: 5_000,
      env: { LC_ALL: 'C' },
      maxBuffer: 8192,
    });
    return true;
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 1 &&
      /No such xattr/i.test(error.message)
    ) {
      return false;
    }
    throw new Error('Could not inspect macOS quarantine for the managed ' + name + ' compiler.', {
      cause: error,
    });
  }
}

async function compiler(
  name: string,
  nativePackage: string,
  wasm: string,
  directory: string,
  cwd: string,
  signal: AbortSignal,
): Promise<Binding | undefined> {
  let native: string;
  try {
    native = await fs.realpath(createRequire(path.join(directory, 'package.json')).resolve(nativePackage));
  } catch (error) {
    if (hasErrorCode(error, 'MODULE_NOT_FOUND') || hasErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  if (!native.startsWith(path.join(cwd, 'node_modules') + path.sep) || !native.endsWith('.node')) {
    return;
  }
  if (!(await quarantinedCompiler(native, name, signal))) {
    return;
  }
  const manifest = exactVersion.parse(
    JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')),
  );
  return { name, version: manifest.version, wasm };
}

async function dependencyDirectory(frameworkPath: string, name: string, cwd: string) {
  const direct = path.join(path.dirname(frameworkPath), name);
  try {
    const directory = await fs.realpath(direct);
    if (!directory.startsWith(path.join(cwd, 'node_modules') + path.sep)) {
      throw new Error('A framework compiler must belong to the managed install.');
    }
    return directory;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
}

export async function prepareCompilerBindings(
  framework: Framework,
  scratch: string,
  cwd: string,
  signal: AbortSignal,
  onOutput?: (text: string) => void,
) {
  const frameworkPath = await fs.realpath(path.join(cwd, 'node_modules', framework));
  const bindings: Binding[] = [];
  if (framework === 'vite') {
    const rolldown = await dependencyDirectory(frameworkPath, 'rolldown', cwd);
    if (rolldown) {
      const binding = await compiler(
        'rolldown',
        '@rolldown/binding-darwin-' + process.arch,
        '@rolldown/binding-wasm32-wasi',
        rolldown,
        cwd,
        signal,
      );
      if (binding) {
        bindings.push(binding);
      }
    }
    const lightning = await dependencyDirectory(frameworkPath, 'lightningcss', cwd);
    if (lightning) {
      const binding = await compiler(
        'lightningcss',
        'lightningcss-darwin-' + process.arch,
        'lightningcss-wasm',
        lightning,
        cwd,
        signal,
      );
      if (binding) {
        bindings.push(binding);
      }
    }
  } else {
    const binding = await compiler(
      'next',
      '@next/swc-darwin-' + process.arch,
      '@next/swc-wasm-nodejs',
      frameworkPath,
      cwd,
      signal,
    );
    if (binding) {
      bindings.push(binding);
    }
  }
  const names = bindings.map((b) => b.wasm + '@' + b.version);
  if (!bindings.length) {
    return { names, webpack: false, forceWasi: false, preload: undefined };
  }
  const auxiliary = path.join(scratch, 'portable');
  const modules = path.join(auxiliary, 'install', 'node_modules');
  await Promise.all(
    ['home', 'tmp', 'install'].map((d) =>
      fs.mkdir(path.join(auxiliary, d), { recursive: true, mode: 0o700 }),
    ),
  );
  await installDependencies(
    auxiliary,
    JSON.stringify({
      name: 'miter-framework-compilers',
      version: '0.0.0',
      private: true,
      dependencies: Object.fromEntries(bindings.map((b) => [b.wasm, b.version])),
    }),
    undefined,
    signal,
    onOutput,
  );
  const hooks: string[] = [];
  let webpack = false;
  for (const binding of bindings) {
    const installed = await fs.realpath(path.join(modules, binding.wasm));
    if (!installed.startsWith(modules + path.sep)) {
      throw new Error('The portable compiler must belong to the private install.');
    }
    const release = exactVersion.parse(
      JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8')),
    );
    if (release.version !== binding.version) {
      throw new Error('The portable compiler version differs from the locked framework.');
    }
    if (binding.name === 'lightningcss') {
      // Lightning CSS distributes its equivalent JS API as a separate package, with
      // different require/import entries. Resolve only its bare specifier for this runtime.
      const entry = createRequire(path.join(auxiliary, 'install', 'package.json')).resolve(binding.wasm);
      hooks.push(
        'if(specifier==="lightningcss") return {url:' +
          JSON.stringify(pathToFileURL(entry).href) +
          ',shortCircuit:true};',
      );
      continue;
    }
    let target = path.join(cwd, 'node_modules', binding.wasm);
    if (binding.name === 'next') {
      // Next's own fallback loader looks in <next>/wasm/@next/swc-wasm-nodejs.
      target = path.join(frameworkPath, 'wasm', binding.wasm);
      webpack = true;
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      await fs.symlink(installed, target, 'dir');
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }
  }
  let preload: string | undefined;
  if (hooks.length) {
    preload = path.join(scratch, 'portable-compilers.cjs');
    const source = [
      'const { registerHooks } = require("node:module");',
      'registerHooks({resolve(specifier, context, next) {',
      ...hooks,
      'return next(specifier, context);',
      '}});',
    ].join('\n');
    await fs.writeFile(preload, source, { flag: 'wx', mode: 0o600 });
  }
  return { names, webpack, forceWasi: bindings.some((binding) => binding.name === 'rolldown'), preload };
}
