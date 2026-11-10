import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/utils';

// node:test runs the real sources using the project's existing transformer.
// Native stripping cannot handle parameter properties in bridge dependencies.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ERR_MODULE_NOT_FOUND' ||
        !specifier.startsWith('.') ||
        !specifier.endsWith('.js')
      ) {
        throw error;
      }
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) {
      return nextLoad(url, context);
    }
    const filename = fileURLToPath(url);
    const source = readFileSync(filename, 'utf8');
    const result = transformSync(filename, source, { target: 'es2023' });

    if (result.errors.length > 0) {
      throw new AggregateError(result.errors, 'Could not transform ' + url);
    }

    return { format: 'module', source: result.code, shortCircuit: true };
  },
});
