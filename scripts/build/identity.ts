import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Hash runtime inputs before either compiler starts. Absolute paths and build
// times would give two copies of the same source different identities.
const directories = [
  'apps/extension/build',
  'apps/extension/entrypoints',
  'apps/extension/public',
  'apps/extension/src',
  'apps/host/src',
  'apps/inference/src',
  'packages/bridge/src',
  'packages/docs/src',
  'packages/protocol/src',
  'packages/terminal/src',
  'packages/ui/src',
];
const inputs = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.host.json',
  'apps/extension/package.json',
  'apps/extension/wxt.config.ts',
  'packages/docs/package.json',
  'packages/protocol/package.json',
  'scripts/build-page.mjs',
  'scripts/build/identity.ts',
  'scripts/build/stamp-host.mjs',
  'scripts/build/preview-sandbox.mjs',
];
const generated = new Set([
  'apps/extension/public/mitter-page.js',
  'apps/extension/public/preview-sandbox.js',
]);

export function computeBuildId(root: string): string {
  const files = [...inputs];
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) {
    files.push('pnpm-lock.yaml');
  }
  function collect(relative: string) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative + '/' + entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== 'test' && entry.name !== '__tests__') {
          collect(child);
        }
      } else if (
        entry.isFile() &&
        !generated.has(child) &&
        !/\.test\.[^.]+$/.test(entry.name) &&
        (relative.startsWith('apps/extension/public') ||
          /\.(?:tsx?|[cm]?js|html|css|json|svg)$/.test(entry.name))
      ) {
        files.push(child);
      }
    }
  }
  for (const dir of directories) {
    collect(dir);
  }
  const digest = createHash('sha256');
  for (const filename of files.sort()) {
    const content = readFileSync(path.join(root, filename));
    digest.update(filename).update('\0').update(String(content.length)).update('\0').update(content);
  }
  return digest.digest('hex').slice(0, 16);
}
