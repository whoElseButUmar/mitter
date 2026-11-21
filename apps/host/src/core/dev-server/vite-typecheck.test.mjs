import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runViteTypecheck } from './vite-typecheck.ts';

test(
  'the sandbox rejects a transpileable TypeScript error and accepts the corrected project',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'miter-ts-check-')));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const modules = path.join(cwd, 'node_modules');
    const manifest = createRequire(import.meta.url).resolve('typescript/package.json');
    // Miter uses TypeScript 7 for its own tests. Copy its compiler and platform package
    // into the disposable install so the sandbox can run without network or host-file access.
    const platformPackage = '@typescript/typescript-' + process.platform + '-' + process.arch;
    const native = createRequire(manifest).resolve(platformPackage + '/package.json');
    await mkdir(path.join(modules, '@typescript'), { recursive: true });
    await Promise.all([
      cp(path.dirname(manifest), path.join(modules, 'typescript'), { recursive: true }),
      cp(path.dirname(native), path.join(modules, platformPackage), { recursive: true }),
      writeFile(
        path.join(cwd, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ['main.ts'] }),
      ),
    ]);
    const main = path.join(cwd, 'main.ts');
    const options = {
      cwd,
      scratch: cwd,
      executable: await realpath(process.execPath),
      production: true,
      signal: new AbortController().signal,
    };
    await writeFile(main, 'export const quantity: number = "two";');
    await assert.rejects(runViteTypecheck(options, ['-b']), /TypeScript check failed[\s\S]*TS2322/);
    await writeFile(main, 'export const quantity: number = 2;');
    await runViteTypecheck(options, ['-b']);
    await runViteTypecheck(options, ['--project', 'tsconfig.json']);
  },
);
