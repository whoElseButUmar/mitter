import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const directory = path.dirname(fileURLToPath(import.meta.url));
const extensionRequire = createRequire(path.resolve(directory, '../../package.json'));
const pluginRequire = createRequire(extensionRequire.resolve('vite-plugin-solid'));
const babel = pluginRequire('@babel/core');
const solidPreset = pluginRequire('babel-preset-solid');
const reactiveRuntime = extensionRequire.resolve('solid-js/dist/solid.js');
const temporaryDirectory = await mkdtemp(path.join(directory, '.bundled-'));
const outputs = [];

try {
  for (const name of [
    'helpers',
    'render',
    'lifecycle',
    'workspace',
    'ownership',
    'appearance',
    'terminal-runs',
    'project-workflows',
    'shipping',
    'start-cleanup',
    'setup',
    'tooltip',
  ]) {
    const reactive =
      name === 'lifecycle' ||
      name === 'workspace' ||
      name === 'ownership' ||
      name === 'appearance' ||
      name === 'terminal-runs' ||
      name === 'project-workflows' ||
      name === 'shipping' ||
      name === 'setup' ||
      name === 'start-cleanup';
    const bundle = await rolldown({
      input: path.join(directory, name + '.test.mjs'),
      platform: 'node',
      resolve: {
        conditionNames: ['solid', 'import', 'node', 'default'],
      },
      external: (source) => {
        if (source.startsWith('node:') || source === 'zod') {
          return true;
        }
        return !reactive && (source === 'solid-js' || source === 'solid-js/web');
      },
      plugins: [
        {
          name: 'solid-ui-tests',
          resolveId(source) {
            if (reactive && source === 'solid-js') {
              return reactiveRuntime;
            }
          },
          async transform(source, id) {
            if (!id.endsWith('.tsx') && !id.endsWith('.jsx')) {
              return;
            }
            const result = await babel.transformAsync(source, {
              filename: id,
              babelrc: false,
              configFile: false,
              parserOpts: { plugins: ['typescript', 'jsx'] },
              presets: [[solidPreset, { generate: 'ssr', hydratable: false }]],
            });
            if (!result?.code) {
              throw new Error('Solid test compilation produced no code: ' + id);
            }
            return { code: result.code };
          },
        },
      ],
    });
    const output = path.join(temporaryDirectory, name + '.test.mjs');
    try {
      await bundle.write({ file: output, format: 'esm', codeSplitting: false });
      outputs.push(output);
    } finally {
      await bundle.close();
    }
  }

  const result = spawnSync(process.execPath, ['--test', ...outputs], {
    stdio: 'inherit',
    timeout: 120000,
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
