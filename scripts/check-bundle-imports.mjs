import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { moduleReferences, isFrameworkSpecifier } from './module-imports.mjs';

/** Extension pages have no external package loader. Refuse an output that
 * "fixes" resolution by leaving Solid/WXT imports for the browser to load. */
export async function checkBundleImports(output) {
  const failures = [];
  let checked = 0;

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(filename);
        continue;
      }

      if (!/\.[cm]?js$/.test(filename)) {
        continue;
      }

      const source = await readFile(filename, 'utf8');

      checked++;

      for (const reference of moduleReferences(source, filename)) {
        if (reference.typeOnly) {
          continue;
        }

        if (isFrameworkSpecifier(reference.specifier)) {
          failures.push(
            `${path.relative(output, filename)}:${reference.line}: unbundled ${reference.specifier}`,
          );
        }

        if (reference.specifier.startsWith('./') || reference.specifier.startsWith('../')) {
          const moduleUrl = new URL(reference.specifier, pathToFileURL(filename));
          const moduleFile = fileURLToPath(moduleUrl);
          const relativeFile = path.relative(output, moduleFile);
          const location = `${path.relative(output, filename)}:${reference.line}`;

          if (
            relativeFile === '..' ||
            relativeFile.startsWith('..' + path.sep) ||
            path.isAbsolute(relativeFile)
          ) {
            failures.push(location + ': module escapes extension output: ' + reference.specifier);
            continue;
          }

          try {
            await readFile(moduleFile);
          } catch {
            failures.push(location + ': missing local module: ' + reference.specifier);
          }
        }
      }
    }
  }

  await walk(output);

  if (failures.length > 0) {
    throw new Error(
      'Unbundled framework dependency or missing module in extension output:\n' + failures.join('\n'),
    );
  }

  return { checked };
}
