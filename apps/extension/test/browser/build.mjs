import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDirectory = path.resolve(fixtureDirectory, '../..');
const extensionRequire = createRequire(path.join(extensionDirectory, 'package.json'));
const pluginRequire = createRequire(extensionRequire.resolve('vite-plugin-solid'));
const babel = pluginRequire('@babel/core');
const solidPreset = pluginRequire('babel-preset-solid');
const runtimeAliases = new Map([
  ['solid-js', extensionRequire.resolve('solid-js/dist/solid.js')],
  ['solid-js/web', extensionRequire.resolve('solid-js/web/dist/web.js')],
]);

export const FIXTURE_STYLESHEET_SLOT = '<!-- Release fixture stylesheets -->';

export async function buildBrowserFixture(directory, { includeSourceStyles = true, buildId } = {}) {
  await mkdir(directory, { recursive: true });
  const html = path.join(directory, 'fixture.html');
  const script = path.join(directory, 'fixture.js');
  let style;
  let stylesheetMarkup = FIXTURE_STYLESHEET_SLOT;
  const bundle = await rolldown({
    input: path.join(fixtureDirectory, 'browser.fixture.tsx'),
    platform: 'browser',
    ...(buildId && { transform: { define: { __MITER_BUILD_ID__: JSON.stringify(buildId) } } }),
    plugins: [
      {
        name: 'solid-browser-fixture',
        resolveId(source) {
          return runtimeAliases.get(source);
        },
        async transform(source, id) {
          if (!id.endsWith('.tsx')) {
            return;
          }
          const result = await babel.transformAsync(source, {
            filename: id,
            babelrc: false,
            configFile: false,
            parserOpts: { plugins: ['typescript', 'jsx'] },
            presets: [[solidPreset, { generate: 'dom', hydratable: false }]],
          });
          if (!result?.code) {
            throw new Error('Solid DOM compilation produced no code: ' + id);
          }
          return { code: result.code };
        },
      },
    ],
  });
  try {
    await bundle.write({ file: script, format: 'esm', codeSplitting: false });
  } finally {
    await bundle.close();
  }

  if (includeSourceStyles) {
    style = path.join(directory, 'fixture.css');
    const styles = await Promise.all([
      readFile(path.join(extensionDirectory, 'src/style.css'), 'utf8'),
      readFile(path.join(extensionDirectory, 'src/terminal.css'), 'utf8'),
    ]);
    await writeFile(style, styles.join('\n\n'), 'utf8');
    stylesheetMarkup = '<link rel="stylesheet" href="./fixture.css" />';
  }
  await writeFile(
    html,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Miter live UI fixture</title>
    ${stylesheetMarkup}
  </head>
  <body>
    <main>
      <h1>Miter live UI fixture</h1>
      <button id="fixture-open-project" type="button">Open project fixture</button>
      <div id="fixture-root"></div>
    </main>
    <script type="module" src="./fixture.js"></script>
  </body>
</html>
`,
    'utf8',
  );
  return { html, script, style };
}
