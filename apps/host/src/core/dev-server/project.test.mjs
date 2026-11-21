import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectDevProject, snapshotDevProject } from './project.js';
import { readPreviewBytes, snapshotApp } from '../preview/snapshot.js';
import { previewStartResultSchema } from '../../../../../packages/protocol/src/rpc/preview.js';

async function fixture(t, manifest) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'miter-dev-project-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  return root;
}

test('fresh package projects preserve source and lock identity without passing executable install configuration', async (t) => {
  const root = await fixture(t, {
    scripts: { dev: 'vite --port 5174', postinstall: 'run-project-hook' },
    devDependencies: { vite: '^8.0.0' },
    pnpm: { pnpmfile: './hook.cjs' },
  });
  await Promise.all(
    ['.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml', '.env.local'].map((name) =>
      writeFile(path.join(root, name), 'private project configuration'),
    ),
  );
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'main.ts'), 'export default 1');
  const signal = new AbortController().signal;
  const first = await snapshotDevProject(root, signal);
  assert.equal(await detectDevProject(root), 'vite');
  assert.deepEqual([...first.files.keys()].sort(), ['package.json', 'pnpm-lock.yaml', 'src/main.ts']);
  assert.deepEqual(JSON.parse(first.installManifest), {
    name: 'miter-preview',
    version: '0.0.0',
    private: true,
    devDependencies: { vite: '^8.0.0' },
  });
  await writeFile(path.join(root, '.npmrc'), 'new private value');
  assert.equal((await snapshotDevProject(root, signal)).fingerprint, first.fingerprint);
  await writeFile(path.join(root, 'src', 'main.ts'), 'export default 2');
  assert.notEqual((await snapshotDevProject(root, signal)).fingerprint, first.fingerprint);
});

test('framework preview includes the public ARD manifest and keeps other hidden files private', async (t) => {
  const root = await fixture(t, { scripts: { dev: 'vite' }, dependencies: { vite: '8.3.4' } });
  const manifest = 'public/.well-known/ard.json';
  const directory = path.join(root, 'public/.well-known');
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(root, '.well-known'));
  await writeFile(path.join(root, manifest), '{"version":"1"}');
  await writeFile(path.join(directory, 'private.json'), 'private');
  await writeFile(path.join(directory, '.settings.json'), 'private');
  await writeFile(path.join(root, '.well-known/ard.json'), 'private');
  const signal = new AbortController().signal;
  const snapshot = await snapshotDevProject(root, signal);
  assert.deepEqual([...snapshot.files.keys()].sort(), ['package.json', manifest]);
  assert.equal(snapshot.files.get(manifest).toString(), '{"version":"1"}');

  await writeFile(path.join(root, manifest), '{"version":"2"}');
  assert.notEqual((await snapshotDevProject(root, signal)).fingerprint, snapshot.fingerprint);
  await rm(path.join(root, manifest));
  await symlink(path.join(directory, 'private.json'), path.join(root, manifest));
  await assert.rejects(snapshotDevProject(root, signal), /symbolic link/);
});

test('framework startup rejects shell syntax and dependency sources outside the registry', async (t) => {
  const root = await fixture(t, {
    scripts: { dev: 'vite && other-command' },
    devDependencies: { vite: '^8.0.0' },
  });
  await assert.rejects(detectDevProject(root), /Put framework options/);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: { dev: 'next dev --webpack' },
      dependencies: { next: 'file:../another-project' },
    }),
  );
  assert.equal(await detectDevProject(root), 'next');
  await assert.rejects(snapshotDevProject(root, new AbortController().signal), /public registry/);
});

test('only plain TypeScript and Vite build scripts opt in to a compiler check', async (t) => {
  const root = await fixture(t, { scripts: { dev: 'vite' }, devDependencies: { vite: '8.3.8' } });
  for (const [build, expected] of [
    ['tsc -b && vite build', ['-b']],
    ['tsc --noEmit && vite build', ['--noEmit']],
    ['tsc && vite build', []],
    ['tsc -p tsconfig.json && vite build', ['--project', 'tsconfig.json']],
    ['tsc --project ./tsconfig.json && vite build', ['--project', 'tsconfig.json']],
    ['tsc -p ./tsconfig.json && vite build', ['--project', 'tsconfig.json']],
    ['tsc --project tsconfig.json && vite build', ['--project', 'tsconfig.json']],
    ['tsc -p ../tsconfig.json && vite build', undefined],
    ['tsc --project custom.json && vite build', undefined],
    ['tsc -p tsconfig.json --watch && vite build', undefined],
    ['vite build', undefined],
    ['tsc --watch && vite build', undefined],
    ['tsc && vite build && another-command', undefined],
    ['echo tsc && vite build', undefined],
  ]) {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite', build }, devDependencies: { vite: '8.3.8' } }),
    );
    const snapshot = await snapshotDevProject(root, new AbortController().signal);
    assert.deepEqual(snapshot.viteTypecheckArgs, expected, build);
  }
});

async function files(directory, total, extension) {
  await mkdir(directory, { recursive: true });
  for (let start = 0; start < total; start += 40) {
    const count = Math.min(40, total - start);
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        writeFile(path.join(directory, String(start + index) + extension), 'data'),
      ),
    );
  }
}

test('framework snapshots count included sources, prune ignored directories and retain larger ordinary assets', async (t) => {
  const root = await fixture(t, { scripts: { dev: 'vite' }, dependencies: { vite: '8.3.4' } });
  await files(path.join(root, 'src'), 300, '.js');
  await files(path.join(root, 'logs'), 2001, '.log');
  const deep = '/nested'.repeat(12);
  for (const dir of ['vendor', '.cache', 'out', 'cache']) {
    await files(path.join(root, dir + deep), 1, '.js');
  }
  await files(path.join(root, 'src', 'cache'), 1, '.ts');
  await mkdir(path.join(root, 'public'));
  const asset = path.join(root, 'public', 'atlas.webp');
  await writeFile(asset, '');
  await truncate(asset, 9 * 1024 * 1024);
  await writeFile(path.join(root, 'index.html'), '<title>Atlas</title><img src="./public/atlas.webp">');
  const signal = new AbortController().signal;
  const snapshot = await snapshotDevProject(root, signal);
  assert.equal(snapshot.files.size, 304);
  assert.equal(snapshot.files.get('public/atlas.webp').length, 9 * 1024 * 1024);
  assert.ok(snapshot.files.has('src/cache/0.ts'));
  await assert.rejects(snapshotApp(root, signal), /at most 8 MiB/);
  const id = 'a'.repeat(32);
  const result = {
    framework: 'vite',
    previewId: id,
    url: 'http://miter-' + id + '.localhost:40123/' + id + '/index.html',
    files: snapshot.files.size,
    bytes: snapshot.bytes,
    idleTimeoutMs: 1800000,
    detail: 'Running',
  };
  assert.deepEqual(previewStartResultSchema.parse(result), result);
  const { framework, ...staticResult } = result;
  assert.equal(framework, 'vite');
  assert.equal(previewStartResultSchema.safeParse(staticResult).success, false);
  assert.equal(previewStartResultSchema.safeParse({ ...result, files: 2001 }).success, false);
  assert.equal(
    previewStartResultSchema.safeParse({ ...result, bytes: 128 * 1024 * 1024 + 1 }).success,
    false,
  );
  await truncate(asset, 32 * 1024 * 1024 + 1);
  await assert.rejects(readPreviewBytes(root, 'public/atlas.webp', 32 * 1024 * 1024), /at most 32 MiB/);
  await assert.rejects(snapshotDevProject(root, signal), /at most 32 MiB/);
});

test('framework snapshot rejects a project that exceeds the included-source count before installing', async (t) => {
  const root = await fixture(t, { scripts: { dev: 'next dev' }, dependencies: { next: '16.4.6' } });
  await files(path.join(root, 'src'), 2000, '.tsx');
  await assert.rejects(
    snapshotDevProject(root, new AbortController().signal),
    /up to 2000 included source files/,
  );
});
