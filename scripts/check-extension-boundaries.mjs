import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { moduleReferences, isFrameworkSpecifier } from './module-imports.mjs';
import { extensionPackageSchema } from './build/contracts.mjs';
import { errorMessage, isMainModule, parseJsonContract } from './helpers/runtime.mjs';

export async function checkExtensionBoundaries(root) {
  const config = await readFile(path.join(root, 'apps/extension/wxt.config.ts'), 'utf8');
  const background = await readFile(path.join(root, 'apps/extension/entrypoints/background.ts'), 'utf8');
  const packageText = await readFile(path.join(root, 'apps/extension/package.json'), 'utf8');
  const extensionPackage = parseJsonContract(
    extensionPackageSchema,
    packageText,
    'Invalid dependency declarations in apps/extension/package.json. Check the package names and version specifiers.',
  );
  const failures = [];

  if (
    extensionPackage.dependencies?.['@wxt-dev/module-solid'] ||
    extensionPackage.devDependencies?.['@wxt-dev/module-solid']
  ) {
    failures.push('Use the direct Solid Vite compiler, not the wrapper with a dependency postinstall.');
  }

  const compilerVersion = extensionPackage.devDependencies?.['vite-plugin-solid'];

  if (!compilerVersion || !/^\d+\.\d+\.\d+$/.test(compilerVersion)) {
    failures.push('Pin the direct Solid Vite compiler exactly.');
  }

  if (!/from\s+['"]vite-plugin-solid['"]/.test(config) || !/plugins\s*:\s*\[\s*solid\(\)\s*\]/.test(config)) {
    failures.push('The direct Solid Vite compiler must be registered, not merely declared.');
  }

  if (!/\bimports\s*:\s*false\b/.test(config)) {
    failures.push('WXT auto-imports must stay disabled.');
  }

  if (!/from\s+['"]wxt\/utils\/define-background['"]/.test(background)) {
    failures.push('background.ts must import defineBackground explicitly.');
  }

  if (
    !/['"]config:resolved['"]/.test(config) ||
    !config.includes('enforceExplicitImportPolicy(wxt.config.imports)')
  ) {
    failures.push('The final resolved auto-import catalog must be cleared after framework modules.');
  }

  if (!/dedupe\s*:\s*\[\s*['"]solid-js['"]/.test(config)) {
    failures.push('Use a single Solid runtime for the extension.');
  }

  let checked = 0;

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') {
          await walk(filename);
        }

        continue;
      }

      if (!/\.[cm]?[jt]sx?$/.test(filename)) {
        continue;
      }

      const source = await readFile(filename, 'utf8');

      checked++;

      for (const reference of moduleReferences(source, filename)) {
        if (isFrameworkSpecifier(reference.specifier)) {
          failures.push(
            `${path.relative(root, filename)}:${reference.line} must stay framework-independent; found ${reference.specifier}.`,
          );
        }
      }
    }
  }

  for (const packageName of ['ui', 'bridge', 'protocol', 'terminal']) {
    await walk(path.join(root, 'packages', packageName, 'src'));
  }

  if (failures.length > 0) {
    throw new Error('Extension source-boundary check failed:\n- ' + failures.join('\n- '));
  }

  return { checked };
}

if (isMainModule(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');

  try {
    const result = await checkExtensionBoundaries(root);

    console.log(
      `Extension source-boundary check passed: ${result.checked} shared modules; final auto-import policy configured.`,
    );
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
