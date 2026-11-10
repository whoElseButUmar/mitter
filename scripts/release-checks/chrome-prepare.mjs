import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { buildBrowserFixture } from '../../apps/extension/test/browser/build.mjs';
import { ownedTemporaryDirectory } from './chrome-native.mjs';

const root = path.resolve(import.meta.dirname, '../..');

// Run copy and compilation in one bounded child; timeout cleanup cannot race unfinished file writes.
async function prepare(directory) {
  const temporary = await ownedTemporaryDirectory(directory);
  const extension = path.join(temporary, 'extension');

  for (const name of ['home', 'tmp']) {
    await mkdir(path.join(temporary, name), { mode: 0o700 });
  }

  await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (filename) => {
      if ((await lstat(filename)).isSymbolicLink()) {
        throw new Error(
          'Packaged extension contains a symlink; refusing to copy external files: ' + filename,
        );
      }

      return true;
    },
  });

  await buildChromeFixture(extension);
}

export async function buildChromeFixture(directory) {
  // The live check supplies the packaged workspace's loaded stylesheets later.
  const fixture = await buildBrowserFixture(directory, { includeSourceStyles: false });

  const bundle = await rolldown({
    input: path.join(root, 'scripts/release-checks/chrome-preview-fixture.mjs'),
    platform: 'browser',
  });
  try {
    await bundle.write({
      file: path.join(directory, 'chrome-preview-fixture.js'),
      format: 'esm',
      codeSplitting: false,
    });
  } finally {
    await bundle.close();
  }

  const html = await readFile(fixture.html, 'utf8');
  if (!html.includes('</body>')) {
    throw new Error('The disposable browser fixture is missing its closing body tag.');
  }
  await writeFile(
    fixture.html,
    html.replace('</body>', '<script type="module" src="./chrome-preview-fixture.js"></script>\n  </body>'),
    'utf8',
  );

  return fixture;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) {
      throw new Error('Chrome preparation needs exactly one caller-owned temporary directory.');
    }

    await prepare(process.argv[2]);
  } catch (error) {
    console.error('Chrome preparation failed:', error);
    process.exitCode = 1;
  }
}
