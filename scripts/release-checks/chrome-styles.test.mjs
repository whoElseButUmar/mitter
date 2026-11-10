import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildChromeFixture } from './chrome-prepare.mjs';
import { FIXTURE_STYLESHEET_SLOT } from '../../apps/extension/test/browser/build.mjs';
import { packagedStylesheetsSchema } from './chrome-schemas.mjs';
import { assertPackagedFixtureStylesheets, writePackagedFixture } from './chrome-styles.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const workspaceURL = 'chrome-extension://' + extensionId + '/workspace.html';

function stylesheets() {
  return {
    url: workspaceURL,
    stylesheets: [
      {
        href: 'chrome-extension://' + extensionId + '/assets/shipped-a1.css?v=1&theme=dark',
        media: '',
        loaded: true,
        disabled: false,
      },
      {
        href: 'chrome-extension://' + extensionId + '/styles/nested/another-name.css',
        media: 'screen and (width > 280px)',
        loaded: true,
        disabled: false,
      },
    ],
  };
}

function driver(value) {
  const commands = [];
  const chrome = {
    async request(method, parameters, session) {
      commands.push({ method, parameters, session });
      assert.equal(method, 'Runtime.evaluate');
      return { result: { type: 'object', value } };
    },
  };
  return { chrome, commands };
}

async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mitter-packaged-css-test-'));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'assets'));
  await mkdir(path.join(directory, 'styles/nested'), { recursive: true });
  const original = '<!doctype html><title>Original packaged workspace</title>';
  const html =
    '<!doctype html><head>' +
    FIXTURE_STYLESHEET_SLOT +
    '</head><body><script type="module" src="./fixture.js"></script></body>';
  const staleCSS = '.task-layout{display:flex;flex-direction:column;flex:1;min-height:0}';
  await writeFile(path.join(directory, 'workspace.html'), original);
  await writeFile(path.join(directory, 'fixture.html'), html);
  await writeFile(path.join(directory, 'assets/shipped-a1.css'), staleCSS);
  await writeFile(path.join(directory, 'styles/nested/another-name.css'), '.terminal-dock{height:350px}');
  await writeFile(
    path.join(directory, 'fixture.css'),
    '.task-layout{flex:1 0 auto}.bridge-note{flex-wrap:wrap}',
  );
  return { directory, original, html, staleCSS };
}

test('release preparation emits no source stylesheet or link on a fresh temporary tree', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mitter-css-free-fixture-test-'));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const built = await buildChromeFixture(directory);
  assert.equal(built.style, undefined);
  await assert.rejects(lstat(path.join(directory, 'fixture.css')), { code: 'ENOENT' });
  const html = await readFile(built.html, 'utf8');
  assert.ok(html.includes(FIXTURE_STYLESHEET_SLOT));
  assert.doesNotMatch(html, /<link\b[^>]*stylesheet|<style\b/);
});

test('stylesheet observations are strict, loaded, enabled, and bounded', () => {
  const observation = stylesheets();
  assert.deepEqual(packagedStylesheetsSchema.parse(observation), observation);
  const first = observation.stylesheets[0];
  for (const changes of [
    { url: '' },
    { url: 'x'.repeat(4097) },
    { stylesheets: [] },
    { stylesheets: Array(33).fill(first) },
    { stylesheets: [{ ...first, href: null }] },
    { stylesheets: [{ ...first, href: '' }] },
    { stylesheets: [{ ...first, href: 'x'.repeat(4097) }] },
    { stylesheets: [{ ...first, media: 'x'.repeat(513) }] },
    { stylesheets: [{ ...first, loaded: false }] },
    { stylesheets: [{ ...first, loaded: 'true' }] },
    { stylesheets: [{ ...first, disabled: true }] },
    { stylesheets: [{ ...first, extra: true }] },
    { extra: true },
  ]) {
    assert.equal(packagedStylesheetsSchema.safeParse({ ...observation, ...changes }).success, false);
  }
});

test('packaged fixture retains stale shipped CSS, discovered names, URLs, media, and cascade order', async (context) => {
  const { directory, html, staleCSS } = await fixture(context);
  const observation = stylesheets();
  const { chrome, commands } = driver(observation);
  assert.deepEqual(
    await writePackagedFixture(chrome, 'packaged-session', directory, extensionId),
    observation,
  );
  const output = await readFile(path.join(directory, 'workspace.html'), 'utf8');
  assert.equal(
    output,
    html.replace(
      FIXTURE_STYLESHEET_SLOT,
      '<link rel="stylesheet" href="chrome-extension://' +
        extensionId +
        '/assets/shipped-a1.css?v=1&amp;theme=dark" media="" />\n    ' +
        '<link rel="stylesheet" href="chrome-extension://' +
        extensionId +
        '/styles/nested/another-name.css" media="screen and (width &gt; 280px)" />',
    ),
  );
  assert.equal(await readFile(path.join(directory, 'assets/shipped-a1.css'), 'utf8'), staleCSS);
  assert.equal(await readFile(path.join(directory, 'fixture.html'), 'utf8'), html);
  assert.doesNotMatch(output, /fixture\.css|flex:1 0 auto|<style\b/);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].session, 'packaged-session');
});

test('browser inspection reports actual link readiness and rejects inline styles rather than omitting them', async (context) => {
  const { directory } = await fixture(context);
  const observation = stylesheets();
  class Link {
    constructor(value) {
      this.href = value.href;
      this.media = value.media;
      this.disabled = value.disabled;
      this.sheet = null;
      if (value.loaded) {
        this.sheet = { disabled: value.disabled };
      }
    }
  }
  const elements = observation.stylesheets.map((value) => new Link(value));
  const chrome = {
    async request(method, parameters, session) {
      assert.equal(method, 'Runtime.evaluate');
      assert.equal(session, 'packaged-session');
      const result = runInNewContext(parameters.expression, {
        HTMLLinkElement: Link,
        location: { href: workspaceURL },
        document: {
          querySelectorAll(selector) {
            assert.equal(selector, 'link[rel~="stylesheet" i], style');
            return elements;
          },
        },
      });
      return { result: { type: 'object', value: JSON.parse(JSON.stringify(result)) } };
    },
  };
  assert.deepEqual(
    await writePackagedFixture(chrome, 'packaged-session', directory, extensionId),
    observation,
  );
  elements[0].sheet = null;
  await assert.rejects(
    writePackagedFixture(chrome, 'packaged-session', directory, extensionId),
    /stylesheet observations/,
  );
  elements[0].sheet = { disabled: true };
  await assert.rejects(
    writePackagedFixture(chrome, 'packaged-session', directory, extensionId),
    /stylesheet observations/,
  );
  elements[0].sheet = { disabled: false };
  elements.push({});
  await assert.rejects(
    writePackagedFixture(chrome, 'packaged-session', directory, extensionId),
    /stylesheet observations/,
  );
});

test('stylesheet attributes cannot inject another HTML attribute or element', async (context) => {
  const { directory } = await fixture(context);
  const observation = stylesheets();
  observation.stylesheets[0].media = 'screen" onload="bad()"><style>bad</style>&';
  const { chrome } = driver(observation);
  await writePackagedFixture(chrome, 'packaged-session', directory, extensionId);
  const output = await readFile(path.join(directory, 'workspace.html'), 'utf8');
  assert.ok(
    output.includes('media="screen&quot; onload=&quot;bad()&quot;&gt;&lt;style&gt;bad&lt;/style&gt;&amp;"'),
  );
  assert.doesNotMatch(output, /<style\b|" onload="/);
});

test('foreign and escaping stylesheet URLs are rejected before replacing the workspace', async (context) => {
  const { directory, original } = await fixture(context);
  for (const href of [
    'not a URL',
    'https://example.invalid/style.css',
    'file:///tmp/style.css',
    'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/assets/style.css',
    'chrome-extension://user@' + extensionId + '/assets/shipped-a1.css',
    'chrome-extension://' + extensionId + '/assets/%2e%2e%2f%2e%2e%2foutside.css',
    'chrome-extension://' + extensionId + '/assets/%00.css',
    'chrome-extension://' + extensionId + '/assets/%5c..%5coutside.css',
    'chrome-extension://' + extensionId + '/assets/%ZZ.css',
    'chrome-extension://' + extensionId + '/',
  ]) {
    const observation = stylesheets();
    observation.stylesheets[0].href = href;
    const { chrome } = driver(observation);
    await assert.rejects(
      writePackagedFixture(chrome, 'packaged-session', directory, extensionId),
      /stylesheet|Packaged styles/,
    );
    assert.equal(await readFile(path.join(directory, 'workspace.html'), 'utf8'), original);
  }
});

test('missing, empty, directory, and symlink stylesheet assets cannot be used', async (context) => {
  const { directory, original } = await fixture(context);
  await writeFile(path.join(directory, 'assets/empty.css'), '');
  await mkdir(path.join(directory, 'assets/directory.css'));
  await symlink(path.join(directory, 'fixture.css'), path.join(directory, 'assets/linked.css'));
  await symlink(path.join(directory, 'assets'), path.join(directory, 'linked-assets'));
  for (const pathname of [
    '/assets/missing.css',
    '/assets/empty.css',
    '/assets/directory.css',
    '/assets/linked.css',
    '/linked-assets/shipped-a1.css',
  ]) {
    const observation = stylesheets();
    observation.stylesheets[0].href = 'chrome-extension://' + extensionId + pathname;
    const { chrome } = driver(observation);
    await assert.rejects(
      writePackagedFixture(chrome, 'packaged-session', directory, extensionId),
      /unsafe packaged stylesheet/,
    );
    assert.equal(await readFile(path.join(directory, 'workspace.html'), 'utf8'), original);
  }
});

test('only the loaded extension’s original workspace can supply styles', async (context) => {
  const { directory, original } = await fixture(context);
  const invalidIdentity = driver(stylesheets());
  await assert.rejects(
    writePackagedFixture(invalidIdentity.chrome, 'packaged-session', directory, 'bad-id'),
    /identity/,
  );
  assert.equal(invalidIdentity.commands.length, 0);
  for (const url of [
    'https://example.invalid/workspace.html',
    'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/workspace.html',
    'chrome-extension://' + extensionId + '/fixture.html',
    workspaceURL + '?release-fixture=1',
    workspaceURL + '#changed',
  ]) {
    const { chrome } = driver({ ...stylesheets(), url });
    await assert.rejects(
      writePackagedFixture(chrome, 'packaged-session', directory, extensionId),
      /Packaged styles|original workspace/,
    );
    assert.equal(await readFile(path.join(directory, 'workspace.html'), 'utf8'), original);
  }
});

test('missing or duplicate fixture slots and symlink HTML are rejected without changing their targets', async (context) => {
  const { directory, original } = await fixture(context);
  for (const html of ['<title>No slot</title>', FIXTURE_STYLESHEET_SLOT.repeat(2)]) {
    await writeFile(path.join(directory, 'fixture.html'), html);
    const { chrome } = driver(stylesheets());
    await assert.rejects(
      writePackagedFixture(chrome, 'packaged-session', directory, extensionId),
      /exactly one stylesheet slot/,
    );
    assert.equal(await readFile(path.join(directory, 'workspace.html'), 'utf8'), original);
  }
  await rm(path.join(directory, 'fixture.html'));
  await symlink(path.join(directory, 'workspace.html'), path.join(directory, 'fixture.html'));
  const { chrome } = driver(stylesheets());
  await assert.rejects(
    writePackagedFixture(chrome, 'packaged-session', directory, extensionId),
    /unsafe release fixture HTML/,
  );
  await rm(path.join(directory, 'fixture.html'));
  await writeFile(path.join(directory, 'fixture.html'), FIXTURE_STYLESHEET_SLOT);
  await rm(path.join(directory, 'workspace.html'));
  await symlink(path.join(directory, 'fixture.css'), path.join(directory, 'workspace.html'));
  const sourceCSS = await readFile(path.join(directory, 'fixture.css'), 'utf8');
  await assert.rejects(
    writePackagedFixture(chrome, 'packaged-session', directory, extensionId),
    /unsafe packaged workspace HTML/,
  );
  assert.equal(await readFile(path.join(directory, 'fixture.css'), 'utf8'), sourceCSS);
});

test('fixture loading must retain the exact packaged sheets and reject source fallback or changed order', async () => {
  const expected = stylesheets();
  const fixtureObservation = { ...expected, url: workspaceURL + '?release-fixture=1' };
  await assertPackagedFixtureStylesheets(driver(fixtureObservation).chrome, 'fixture-session', expected);
  const source = {
    href: 'chrome-extension://' + extensionId + '/fixture.css',
    media: '',
    loaded: true,
    disabled: false,
  };
  for (const changes of [
    { url: workspaceURL },
    { url: 'https://example.invalid/workspace.html?release-fixture=1' },
    { stylesheets: [source] },
    { stylesheets: [...expected.stylesheets, source] },
    { stylesheets: [...expected.stylesheets].reverse() },
    { stylesheets: [expected.stylesheets[0]] },
    { stylesheets: expected.stylesheets.map((sheet) => ({ ...sheet, media: 'print' })) },
  ]) {
    await assert.rejects(
      assertPackagedFixtureStylesheets(
        driver({ ...fixtureObservation, ...changes }).chrome,
        'fixture-session',
        expected,
      ),
      assert.AssertionError,
    );
  }
  const unloaded = expected.stylesheets.map((sheet) => ({ ...sheet, loaded: false }));
  await assert.rejects(
    assertPackagedFixtureStylesheets(
      driver({ ...fixtureObservation, stylesheets: unloaded }).chrome,
      'fixture-session',
      expected,
    ),
    /stylesheet observations/,
  );
});
