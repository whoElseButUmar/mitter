/** Test only: inspect the current host API without generating or replacing dist files. */
import { registerHooks } from 'node:module';
import { transformSync } from 'rolldown/utils';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const distRoot = path.join(root, 'dist') + path.sep;
const sourceRoots = [path.join(root, 'apps/host/src'), path.join(root, 'packages/protocol/src')];

function isHostSource(file) {
  return sourceRoots.some((directory) => {
    return file.startsWith(directory + path.sep);
  });
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && (specifier.startsWith('.') || specifier.startsWith('file:'))) {
      const resolvedUrl = new URL(specifier, context.parentURL);
      let file = fileURLToPath(resolvedUrl);

      if (file.startsWith(distRoot)) {
        file = path.join(root, file.slice(distRoot.length));
      }

      if (isHostSource(file) && file.endsWith('.js')) {
        const source = file.slice(0, -3) + '.ts';

        if (existsSync(source)) {
          return { url: pathToFileURL(source).href, shortCircuit: true };
        }
      }
    }

    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) {
      return nextLoad(url, context);
    }

    const file = fileURLToPath(url);

    if (file.endsWith('.ts') && isHostSource(file)) {
      const transformed = transformSync(file, readFileSync(file, 'utf8'));

      return { format: 'module', source: transformed.code, shortCircuit: true };
    }

    return nextLoad(url, context);
  },
});
