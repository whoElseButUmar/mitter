import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FIXTURE_STYLESHEET_SLOT } from '../../apps/extension/test/browser/build.mjs';
import { parseContract } from '../helpers/runtime.mjs';
import { ownedTemporaryDirectory } from './chrome-native.mjs';
import { extensionIdSchema, packagedStylesheetsSchema } from './chrome-schemas.mjs';
import { evaluate } from './chrome-ui.mjs';

async function inspectStylesheets(chrome, session) {
  return parseContract(
    packagedStylesheetsSchema,
    await evaluate(
      chrome,
      session,
      `(() => {
        const stylesheets = [...document.querySelectorAll('link[rel~="stylesheet" i], style')].map(element => {
          if (!(element instanceof HTMLLinkElement)) {
            return { href: null, media: '', loaded: true, disabled: false };
          }
          return {
            href: element.href,
            media: element.media,
            loaded: element.sheet !== null,
            disabled: element.disabled || !!element.sheet?.disabled,
          };
        });
        return { url: location.href, stylesheets };
      })()`,
    ),
    'Invalid Chrome stylesheet observations. Expected loaded, enabled external stylesheets; inspect the release-check log.',
  );
}

function extensionURL(address, id) {
  let url;
  try {
    url = new URL(address);
  } catch (error) {
    throw new Error('Invalid packaged stylesheet URL. Rebuild the extension and inspect its page links.', {
      cause: error,
    });
  }

  if (url.protocol !== 'chrome-extension:' || url.host !== id || url.username || url.password) {
    throw new Error('Packaged styles must belong to the loaded extension, not another origin.');
  }

  return url;
}

async function regularAsset(filename, label) {
  try {
    await ownedTemporaryDirectory(path.dirname(filename));
    const identity = await lstat(filename);
    if (!identity.isFile() || identity.size === 0) {
      throw new Error('Expected a nonempty regular file, not a directory or symlink.');
    }
  } catch (error) {
    throw new Error(
      'Missing or unsafe ' + label + '. Rebuild the extension and use a fresh temporary copy.',
      {
        cause: error,
      },
    );
  }
}

function escapeAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export async function writePackagedFixture(chrome, session, directory, extensionId) {
  const { id } = parseContract(extensionIdSchema, { id: extensionId }, 'Invalid loaded extension identity.');
  const observation = await inspectStylesheets(chrome, session);
  const page = extensionURL(observation.url, id);
  if (page.pathname !== '/workspace.html' || page.search || page.hash) {
    throw new Error('Discover packaged styles on the original workspace page before replacing it.');
  }

  const root = await ownedTemporaryDirectory(directory);
  for (const stylesheet of observation.stylesheets) {
    const url = extensionURL(stylesheet.href, id);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch (error) {
      throw new Error('Invalid packaged stylesheet path encoding. Rebuild the extension.', { cause: error });
    }

    const filename = path.resolve(root, '.' + pathname);
    const relative = path.relative(root, filename);
    if (
      pathname.includes('\0') ||
      pathname.includes('\\') ||
      relative === '' ||
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('Packaged stylesheet paths must stay inside the temporary extension copy.');
    }
    await regularAsset(filename, 'packaged stylesheet');
  }

  const input = path.join(root, 'fixture.html');
  const output = path.join(root, 'workspace.html');
  await regularAsset(input, 'release fixture HTML');
  await regularAsset(output, 'packaged workspace HTML');
  const html = await readFile(input, 'utf8');
  if (html.split(FIXTURE_STYLESHEET_SLOT).length !== 2) {
    throw new Error('The CSS-free release fixture needs exactly one stylesheet slot. Rebuild the fixture.');
  }
  const links = observation.stylesheets.map(
    (stylesheet) =>
      '<link rel="stylesheet" href="' +
      escapeAttribute(stylesheet.href) +
      '" media="' +
      escapeAttribute(stylesheet.media) +
      '" />',
  );

  // Host RPC accepts only approved entrypoints. Replace only this disposable
  // workspace HTML; keep stylesheet URLs intact so imports and font URLs still resolve.
  await writeFile(output, html.replace(FIXTURE_STYLESHEET_SLOT, links.join('\n    ')), 'utf8');
  return observation;
}

export async function assertPackagedFixtureStylesheets(chrome, session, expected) {
  const observation = await inspectStylesheets(chrome, session);
  assert.equal(
    observation.url,
    expected.url + '?release-fixture=1',
    'Inspect only the owned release fixture.',
  );
  assert.deepEqual(
    observation.stylesheets,
    expected.stylesheets,
    'The release fixture must load only the packaged workspace stylesheets, in the same cascade order.',
  );
}
