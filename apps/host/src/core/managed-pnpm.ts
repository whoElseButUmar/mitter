import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Resolve Miter's pinned native pnpm independently of Chrome's PATH and the target project. */
export function managedPnpmExecutable(): string {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('Managed development servers require the macOS Miter helper.');
  }
  const hostRequire = createRequire(import.meta.url);
  const packageRequire = createRequire(hostRequire.resolve('pnpm/package.json'));
  return realpathSync(packageRequire.resolve('@pnpm/exe.darwin-' + process.arch + '/pnpm'));
}
