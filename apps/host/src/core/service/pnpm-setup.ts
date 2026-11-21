import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Store } from '../database.js';
import { existing } from '../workspace.js';

export const STARTER_VITE_VERSION = '8.3.8';

const dependencyGroup = z.object({ vite: z.string().optional() }).optional();
const viteManifest = z.object({ dependencies: dependencyGroup, devDependencies: dependencyGroup });

function hasInstallContext(root: string): boolean {
  if (['pnpm-lock.yaml', 'node_modules', '.npmrc'].some((name) => existsSync(path.join(root, name)))) {
    return true;
  }
  // A parent workspace owns the dependency-build policy for its packages.
  for (let directory = root; ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, 'pnpm-workspace.yaml'))) {
      return true;
    }
    if (directory === path.dirname(directory)) {
      return false;
    }
  }
}

export async function newViteInstallIssue(
  command: readonly string[],
  root: string,
  runId: string,
  store: Store,
): Promise<string | undefined> {
  if (command.length !== 2 || command[0] !== 'pnpm' || !['install', 'i'].includes(command[1] ?? '')) {
    return;
  }
  const change = store.fileChange(runId, 'package.json');
  if (!change || change.before !== null || change.status !== 'applied') {
    return;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(change.after);
  } catch {
    // Let pnpm diagnose an invalid manifest through the normal approval path.
    return;
  }
  const result = viteManifest.safeParse(manifest);
  if (!result.success) {
    return;
  }
  const version = result.data.devDependencies?.vite ?? result.data.dependencies?.vite;
  if (!version || !/^[~^]?v?[67](?:\.(?:\d+|x|\*)){0,2}$/.test(version)) {
    return;
  }
  if (hasInstallContext(root) || (await existing(root, 'package.json')).hash !== change.afterHash) {
    return;
  }
  return (
    'Setup has not run. This new Vite ' +
    version +
    ' manifest pulls in an esbuild install script that ' +
    'pnpm blocks by default. For a new app use vite "' +
    STARTER_VITE_VERSION +
    '". If this Vite major is ' +
    'required, keep it and write a project pnpm-workspace.yaml with allowBuilds: { esbuild: false } to ' +
    'use the platform binary. Then request pnpm install for approval. Preserve existing build permissions.'
  );
}
