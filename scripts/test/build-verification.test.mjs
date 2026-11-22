import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { sourceManifest } from '../check-security-policy.mjs';
import { FONT_FILE, validateBundledFont } from '../prepare-font.mjs';
import { fontSourceSchema, FONT_URL } from '../fonts/contracts.mjs';
import { fontFixtureBytes } from '../fonts/test-fixture.mjs';
import { moduleReferences } from '../module-imports.mjs';
import { buildVerificationSchema } from '../build/contracts.mjs';
import { previewSandboxBanner, previewSandboxBundle } from '../build/preview-sandbox.mjs';
import { nativeManifestSchema } from '../installation/contracts.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const version = '1.2.3-rc.1';
const identity = {
  name: 'Mitter',
  key: 'YWJj',
  extensionId: 'lkhibglpipabmpokebebeanofnkocccd',
  nativeHost: 'ai.mitter.host',
};
const bridgeBytes = Buffer.from(
  'globalThis.channel = "fixture-channel"; globalThis.reader = "fixture-reader";\n',
);
const skillAssets = [
  'skills/caveman/SKILL.md',
  'skills/caveman/LICENSE',
  'skills/no-ai-slop/SKILL.md',
  'skills/no-ai-slop/eval.md',
  'skills/no-ai-slop/LICENSE',
  'skills/ponytail/SKILL.md',
  'skills/ponytail/LICENSE',
  'skills/NOTICE.md',
];

async function ownedFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const filename = path.join(relative, entry.name);
    files.push(filename);
    // The fixture borrows node_modules through a symlink. Its package-manager
    // state and other tests' temporary files are not build assets owned here.
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      files.push(...(await ownedFiles(root, filename)));
    }
  }
  return files.sort();
}

async function fixtureDirectory(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mitter-build-verification-'));

  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await symlink(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');

  return {
    root,
    async write(filename, bytes) {
      const target = path.join(root, filename);

      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    },
    async copySource(filename) {
      const target = path.join(root, filename);

      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(repositoryRoot, filename), target);
    },
    async copyScript(filename) {
      const target = path.join(root, 'scripts', filename);

      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(repositoryRoot, 'scripts', filename), target);
    },
  };
}

async function verificationFixture(context) {
  const fixture = await fixtureDirectory(context);
  const scripts = [
    'verify-build.mjs',
    'prepare-font.mjs',
    'atomic-config.mjs',
    'check-security-policy.mjs',
    'check-bundle-imports.mjs',
    'check-extension-boundaries.mjs',
    'module-imports.mjs',
    'build/contracts.mjs',
    'build/preview-sandbox.mjs',
    'fonts/contracts.mjs',
    'installation/contracts.mjs',
    'installation/bootstrap.mjs',
    'helpers/runtime.mjs',
  ];

  for (const filename of scripts) {
    await fixture.copyScript(filename);
  }

  const manifest = {
    ...(await sourceManifest(repositoryRoot)),
    version: '1.2.3',
    version_name: version,
    key: identity.key,
  };
  const output = 'apps/extension/.output/chrome-mv3';
  const fontBytes = fontFixtureBytes();
  const terminalFont = validateBundledFont(fontBytes);
  const recordedFont = fontSourceSchema.parse({
    file: FONT_FILE,
    source: FONT_URL,
    nerdFonts: 'v3.4.0',
    firaCode: '6.2',
    ...terminalFont,
  });

  await fixture.write('package.json', JSON.stringify({ version, type: 'module' }));
  await fixture.write('brand/extension-identity.json', JSON.stringify(identity));
  await fixture.write(output + '/manifest.json', JSON.stringify(manifest));
  await fixture.write(
    'dist/packages/bridge/src/page-transport.js',
    'export const PAGE_CHANNEL = "fixture-channel"; export const PAGE_READER = "fixture-reader";',
  );
  await fixture.write(
    'dist/packages/protocol/src/index.js',
    'export const APP_VERSION = "' + version + '"; export const BUILD_ID = "abcdef0123456789";',
  );

  for (const filename of [
    'apps/host/src/native.js',
    'apps/host/src/cli.js',
    'apps/inference/src/worker.js',
  ]) {
    await fixture.write(
      'dist/' + filename,
      'throw new Error("Verification must not launch this entrypoint.");',
    );
  }

  for (const [filename, bytes] of [
    ['mitter-page.js', bridgeBytes],
    ['preview-sandbox.html', '<script src="preview-sandbox.js"></script>\n'],
    [
      'preview-sandbox.js',
      previewSandboxBanner + '\n(function () { "use strict"; globalThis.previewFixture = true; })();\n',
    ],
  ]) {
    await fixture.write('apps/extension/public/' + filename, bytes);
    await fixture.write(output + '/' + filename, bytes);
  }

  for (const filename of skillAssets) {
    const source = 'apps/extension/public/' + filename;

    await fixture.copySource(source);
    const bytes = await readFile(path.join(fixture.root, source));
    await fixture.write(output + '/' + filename, bytes);
  }

  for (const filename of ['sidepanel.html', 'workspace.html', 'file.html']) {
    await fixture.write(output + '/' + filename, '<!doctype html>\n');
  }

  await fixture.write(output + '/background.js', 'globalThis.backgroundFixture = "abcdef0123456789";\n');
  await fixture.write(output + '/fonts/' + FONT_FILE, fontBytes);
  await fixture.write(output + '/fonts/OFL.txt', 'Copyright fixture\nSIL OPEN FONT LICENSE Version 1.1\n');
  await fixture.write(output + '/fonts/FONT-SOURCE.json', JSON.stringify(recordedFont));

  const moduleUrl = pathToFileURL(path.join(fixture.root, 'scripts/verify-build.mjs'));
  const { verifyBuild } = await import(moduleUrl.href);

  return { ...fixture, manifest, output, terminalFont, verifyBuild };
}

function runFixtureNode(fixture, args, environment = process.env) {
  return spawnSync(process.execPath, args, {
    cwd: fixture.root,
    env: environment,
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
  });
}

test('build verification succeeds without changing assets and preserves its report shape', async (context) => {
  const fixture = await verificationFixture(context);
  const fontFile = path.join(fixture.root, fixture.output, 'fonts', FONT_FILE);
  const originalFont = await readFile(fontFile);
  const originalFiles = await ownedFiles(fixture.root);
  const result = await fixture.verifyBuild(fixture.root);

  assert.deepEqual(result, {
    version,
    extensionId: identity.extensionId,
    terminalFont: fixture.terminalFont,
    bundleModulesChecked: 3,
    pageSHA256: createHash('sha256').update(bridgeBytes).digest('hex'),
  });
  assert.deepEqual(buildVerificationSchema.parse(result), result);
  assert.deepEqual(await ownedFiles(fixture.root), originalFiles);
  assert.deepEqual(await readFile(fontFile), originalFont);
});

test('build verification rejects a same-version helper and background built from different sources', async (context) => {
  const fixture = await verificationFixture(context);
  await fixture.write(
    fixture.output + '/background.js',
    'globalThis.backgroundFixture = "fedcba9876543210";',
  );
  await assert.rejects(fixture.verifyBuild(fixture.root), /different build IDs/);
});

test('build verification rejects missing or empty host entrypoints without executing them', async (context) => {
  const fixture = await verificationFixture(context);

  for (const filename of [
    'apps/host/src/native.js',
    'apps/host/src/cli.js',
    'apps/inference/src/worker.js',
  ]) {
    const relative = 'dist/' + filename;
    const original = await readFile(path.join(fixture.root, relative));

    await rm(path.join(fixture.root, relative));
    await assert.rejects(fixture.verifyBuild(fixture.root), /Missing or empty build asset:.*dist/);
    await fixture.write(relative, '');
    await assert.rejects(fixture.verifyBuild(fixture.root), /Missing or empty build asset:.*dist/);
    await fixture.write(relative, original);
  }
});

test('build verification rejects missing script and stylesheet references in packaged pages', async (context) => {
  const fixture = await verificationFixture(context);
  const page = fixture.output + '/sidepanel.html';

  await fixture.write(page, '<script type="module" src="/chunks/panel.js"></script>');
  await assert.rejects(fixture.verifyBuild(fixture.root), /Missing packaged page asset:.*chunks\/panel.js/);
  await fixture.write(fixture.output + '/chunks/panel.js', 'export const panel = true;');
  await fixture.write(page, '<link rel="stylesheet" href="./assets/panel.css?version=1#theme">');
  await assert.rejects(fixture.verifyBuild(fixture.root), /Missing packaged page asset:.*assets\/panel.css/);
  await fixture.write(fixture.output + '/assets/panel.css', 'body { color: black; }');
  await fixture.verifyBuild(fixture.root);
});

test('verification CLI reports an actionable failure when the compiled bridge is absent', async (context) => {
  const fixture = await verificationFixture(context);

  await rm(path.join(fixture.root, 'dist/packages/bridge/src/page-transport.js'));
  const result = runFixtureNode(fixture, ['scripts/verify-build.mjs']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Build verification failed:.*page-transport/);
  assert.doesNotMatch(result.stderr, /node:internal/);
});

test('build verification validates compiled transport constants before using them', async (context) => {
  for (const source of [
    'export const PAGE_CHANNEL = 1; export const PAGE_READER = "fixture-reader";',
    'export const PAGE_CHANNEL = "fixture-channel"; export const PAGE_READER = null;',
    'export const PAGE_CHANNEL = ""; export const PAGE_READER = "fixture-reader";',
    'export const PAGE_CHANNEL = "fixture-channel"; export const PAGE_READER = "";',
  ]) {
    const fixture = await verificationFixture(context);

    await fixture.write('dist/packages/bridge/src/page-transport.js', source);
    await assert.rejects(fixture.verifyBuild(fixture.root), /compiled page-transport constants are missing/);
  }
});

test('build verification rejects external and encoded traversal page assets without fetching', async (context) => {
  const fixture = await verificationFixture(context);

  for (const reference of ['https://example.com/code.js', '//example.com/code.js', '/..%2Foutside.js']) {
    await fixture.write(fixture.output + '/sidepanel.html', '<script src="' + reference + '"></script>');
    await assert.rejects(fixture.verifyBuild(fixture.root), /Packaged page asset escapes extension output/);
  }
});

test('build verification compares packaged bridge and sandbox assets byte for byte', async (context) => {
  const fixture = await verificationFixture(context);
  const changedBridge = Buffer.from(bridgeBytes);

  changedBridge[0] ^= 1;
  await fixture.write(fixture.output + '/mitter-page.js', changedBridge);
  await assert.rejects(fixture.verifyBuild(fixture.root), /chat page bridge is missing or stale/);
  await fixture.write(fixture.output + '/mitter-page.js', bridgeBytes);

  for (const filename of ['preview-sandbox.html', 'preview-sandbox.js']) {
    const original = await readFile(path.join(fixture.root, 'apps/extension/public', filename));
    const changed = Buffer.from(original);

    changed[0] ^= 1;
    await fixture.write(fixture.output + '/' + filename, changed);
    await assert.rejects(fixture.verifyBuild(fixture.root), /packaged preview sandbox is stale/);
    await fixture.write(fixture.output + '/' + filename, original);
  }

  for (const content of [
    'globalThis.reader = "fixture-reader";',
    'globalThis.channel = "fixture-channel";',
  ]) {
    await fixture.write('apps/extension/public/mitter-page.js', content);
    await fixture.write(fixture.output + '/mitter-page.js', content);
    await assert.rejects(fixture.verifyBuild(fixture.root), /chat page bridge is missing or stale/);
  }
});

test('build verification requires every bundled skill document and license to match its source', async (context) => {
  const fixture = await verificationFixture(context);

  for (const filename of skillAssets) {
    const bundled = fixture.output + '/' + filename;
    const original = await readFile(path.join(fixture.root, bundled));

    await rm(path.join(fixture.root, bundled));
    await assert.rejects(fixture.verifyBuild(fixture.root), (error) => {
      assert.match(error.message, /Missing or unreadable bundled skill asset/);
      assert.ok(error.message.includes(filename));
      assert.equal(error.cause?.code, 'ENOENT');

      return true;
    });

    await fixture.write(bundled, Buffer.concat([original, Buffer.from('\nStale bundled text.\n')]));
    await assert.rejects(fixture.verifyBuild(fixture.root), (error) => {
      assert.match(error.message, /packaged skill asset is stale/);
      assert.ok(error.message.includes(filename));

      return true;
    });
    await fixture.write(bundled, original);
  }

  await fixture.verifyBuild(fixture.root);
});

test('build verification rejects missing or empty skill sources and matching empty bundles', async (context) => {
  const fixture = await verificationFixture(context);

  for (const filename of skillAssets) {
    const source = 'apps/extension/public/' + filename;
    const bundled = fixture.output + '/' + filename;
    const original = await readFile(path.join(fixture.root, source));

    await rm(path.join(fixture.root, source));
    await assert.rejects(fixture.verifyBuild(fixture.root), /Missing or unreadable bundled skill asset/);
    await fixture.write(source, '');
    await assert.rejects(fixture.verifyBuild(fixture.root), /Empty bundled skill asset/);
    await fixture.write(bundled, '');
    await assert.rejects(fixture.verifyBuild(fixture.root), /Empty bundled skill asset/);
    await fixture.write(source, original);
    await assert.rejects(fixture.verifyBuild(fixture.root), /Empty bundled skill asset/);
    await fixture.write(bundled, original);
  }

  await fixture.verifyBuild(fixture.root);
});

test('verification rejects matching but non-generated, imported, or privileged preview assets', async (context) => {
  const fixture = await verificationFixture(context);

  for (const source of [
    '(function () { "use strict"; })();',
    previewSandboxBanner + '\nimport "zod";',
    previewSandboxBanner + '\n(function () { "use strict"; fetch("https://remote.test"); })();',
    previewSandboxBanner + '\n(function () { "use strict"; chrome.runtime.connect(); })();',
    previewSandboxBanner +
      '\n(function () { "use strict"; const scope = globalThis; scope.fetch("https://remote.test"); })();',
    previewSandboxBanner + '\n(function () { "use strict"; globalThis["Fun" + "ction"]("code"); })();',
    previewSandboxBanner + '\n(function () { "use strict"; globalThis[property]("code"); })();',
  ]) {
    await fixture.write('apps/extension/public/preview-sandbox.js', source);
    await fixture.write(fixture.output + '/preview-sandbox.js', source);
    await assert.rejects(fixture.verifyBuild(fixture.root), /preview sandbox/);
  }
});

test('build verification rejects version, identity and malformed JSON metadata mismatches', async (context) => {
  const fixture = await verificationFixture(context);

  for (const patch of [{ version: '2.0.0' }, { version_name: '1.2.3-rc.2' }]) {
    await fixture.write(fixture.output + '/manifest.json', JSON.stringify({ ...fixture.manifest, ...patch }));
    await assert.rejects(fixture.verifyBuild(fixture.root), /does not match source/);
  }

  await fixture.write(
    fixture.output + '/manifest.json',
    JSON.stringify({ ...fixture.manifest, key: undefined }),
  );
  await assert.rejects(fixture.verifyBuild(fixture.root), /stable extension key is missing/);
  await fixture.write(
    fixture.output + '/manifest.json',
    JSON.stringify({ ...fixture.manifest, key: 'ZGVm' }),
  );
  await assert.rejects(fixture.verifyBuild(fixture.root), /extension ID changed/);
  await fixture.write(fixture.output + '/manifest.json', JSON.stringify(fixture.manifest));
  await fixture.write(
    'brand/extension-identity.json',
    JSON.stringify({ ...identity, extensionId: 'invalid' }),
  );
  await assert.rejects(fixture.verifyBuild(fixture.root), /extensionId/);
  await fixture.write('brand/extension-identity.json', JSON.stringify(identity));
  await fixture.write('package.json', JSON.stringify({ version: 1 }));
  await assert.rejects(fixture.verifyBuild(fixture.root), /version/);
  await fixture.write('package.json', '{');
  await assert.rejects(fixture.verifyBuild(fixture.root), (error) => {
    assert.match(error.message, /Invalid source package version/);
    assert.ok(error.cause instanceof SyntaxError);

    return true;
  });
  await fixture.write('package.json', JSON.stringify({ version, type: 'module' }));
  await fixture.write('dist/packages/protocol/src/index.js', 'export const APP_VERSION = "0.0.0";');
  await assert.rejects(fixture.verifyBuild(fixture.root), /compiled native host is from a different version/);
});

test('build verification retains empty-asset and unbundled-framework checks', async (context) => {
  const fixture = await verificationFixture(context);

  for (const filename of ['sidepanel.html', 'workspace.html', 'file.html', 'background.js']) {
    const original = await readFile(path.join(fixture.root, fixture.output, filename));

    await fixture.write(fixture.output + '/' + filename, '');
    await assert.rejects(fixture.verifyBuild(fixture.root), /Empty extension asset/);
    await fixture.write(fixture.output + '/' + filename, original);
  }

  await fixture.write(fixture.output + '/background.js', 'import "solid-js/web";');
  await assert.rejects(fixture.verifyBuild(fixture.root), /Unbundled framework dependency/);
});

test('verification and font CLIs retain success, failure and import-only behavior', async (context) => {
  const fixture = await verificationFixture(context);
  const beforeImport = await readdir(fixture.root, { recursive: true });
  const imported = runFixtureNode(fixture, [
    '--input-type=module',
    '-e',
    `
    for (const filename of ${JSON.stringify([
      'prepare-font.mjs',
      'verify-build.mjs',
      'check-security-policy.mjs',
      'check-extension-boundaries.mjs',
      'check-bundle-imports.mjs',
      'module-imports.mjs',
    ])}) {
      await import('./scripts/' + filename);
    }
  `,
  ]);

  assert.equal(imported.error, undefined);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  assert.deepEqual(await readdir(fixture.root, { recursive: true }), beforeImport);

  const verified = runFixtureNode(fixture, ['scripts/verify-build.mjs']);

  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Build verified: Miter 1.2.3-rc.1/);

  const prepared = runFixtureNode(
    fixture,
    [
      'scripts/prepare-font.mjs',
      '--file=' + path.join(fixture.root, fixture.output, 'fonts', FONT_FILE),

      '--license=' + path.join(fixture.root, fixture.output, 'fonts/OFL.txt'),
    ],
    {
      ...process.env,
      MITER_FONT_FILE: '/missing-environment-font.ttf',
      MITER_FONT_LICENSE: '/missing-environment-license.txt',
      MITER_FONT_SHA256: '',
    },
  );

  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /Prepared one local terminal font: FiraCode Nerd Font Mono/);

  for (const args of [['--file=/first.ttf', '--file=/second.ttf'], ['--fiel=/missing.ttf'], ['--file=']]) {
    const rejected = runFixtureNode(fixture, ['scripts/prepare-font.mjs', ...args]);

    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Usage:|Invalid font input/);
    assert.equal(rejected.stdout, '');
    assert.doesNotMatch(rejected.stderr, /invalid_type|Download failed/);
  }

  const failedFont = runFixtureNode(fixture, ['scripts/prepare-font.mjs', '--file=/missing-font.ttf']);

  assert.equal(failedFont.status, 1);
  assert.match(failedFont.stderr, /Font provisioning failed:.*ENOENT/);
  assert.match(failedFont.stderr, /For an offline build, set MITER_FONT_FILE/);
  await fixture.write(fixture.output + '/preview-sandbox.js', '// stale');

  const failedBuild = runFixtureNode(fixture, ['scripts/verify-build.mjs']);

  assert.equal(failedBuild.status, 1);
  assert.match(failedBuild.stderr, /Build verification failed:.*preview-sandbox.js/);
});

test('direct registration verifies a complete fixture and only writes its isolated destinations', async (context) => {
  const fixture = await verificationFixture(context);

  await fixture.copyScript('register-host.mjs');
  await fixture.copyScript('installation/registration.mjs');
  await fixture.copyScript('installation/terminal-command.mjs');
  const manifestDirectory = path.join(fixture.root, 'manifests');
  const home = path.join(fixture.root, 'home');
  await mkdir(home);
  const environment = { ...process.env, HOME: home, MITTER_HOME: path.join(fixture.root, 'state') };
  const registered = runFixtureNode(
    fixture,
    ['scripts/register-host.mjs', '--portable', '--manifest-dir=' + manifestDirectory],
    environment,
  );

  assert.equal(registered.error, undefined);
  assert.equal(registered.status, 0, registered.stderr);
  assert.match(registered.stdout, /Registered ai.mitter.host/);
  const manifestFile = path.join(manifestDirectory, identity.nativeHost + '.json');
  const manifest = nativeManifestSchema.parse(JSON.parse(await readFile(manifestFile, 'utf8')));

  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://' + identity.extensionId + '/']);
  assert.equal(manifest.type, 'stdio');
  assert.match(await readFile(manifest.path, 'utf8'), /--portable/);
  assert.deepEqual(await readdir(manifestDirectory), [identity.nativeHost + '.json']);

  const removed = runFixtureNode(
    fixture,
    ['scripts/register-host.mjs', '--remove', '--manifest-dir=' + manifestDirectory],
    environment,
  );

  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(await readdir(manifestDirectory), []);
  assert.match(await readFile(manifest.path, 'utf8'), /--portable/);
});

async function sandboxSourceFixture(context) {
  const fixture = await fixtureDirectory(context);
  await fixture.write('package.json', JSON.stringify({ type: 'module' }));

  for (const filename of ['entry.ts', 'sandbox.ts', 'tsconfig.json']) {
    await fixture.copySource('apps/extension/src/preview-sandbox/' + filename);
  }

  await fixture.copySource('packages/ui/src/preview/sandbox-messages.ts');

  return fixture;
}

test('isolated sandbox compilation embeds schemas without eval, runtime imports, remote access, or emitted source artifacts', async (context) => {
  const fixture = await sandboxSourceFixture(context);
  const source = await previewSandboxBundle(fixture.root);
  assert.ok(source.startsWith(previewSandboxBanner));
  assert.deepEqual(moduleReferences(source, 'preview-sandbox.js'), []);
  await assert.rejects(readFile(path.join(fixture.root, 'apps/extension/public/preview-sandbox.js')), {
    code: 'ENOENT',
  });

  const attempts = [];
  const disabledFunction = new Proxy(Function, {
    apply() {
      attempts.push('call');
      throw new Error('Dynamic code is forbidden.');
    },
    construct() {
      attempts.push('construct');
      throw new Error('Dynamic code is forbidden.');
    },
  });
  const ready = [];
  const frames = [];
  const receivers = [];
  const parent = { postMessage: (...args) => ready.push(args) };
  const window = {
    parent,
    document: {
      createElement() {
        const attributes = {};

        return {
          setAttribute: (name, value) => {
            attributes[name] = value;
          },
          attributes,
        };
      },
      body: { replaceChildren: (frame) => frames.push(frame) },
    },
    addEventListener(type, receive) {
      assert.equal(type, 'message');
      receivers.push(receive);
    },
    removeEventListener() {},
  };
  runInNewContext(
    source,
    { window, Function: disabledFunction },
    {
      codeGeneration: { strings: false, wasm: false },
      timeout: 5000,
    },
  );
  assert.equal(ready.length, 1);
  assert.equal(ready[0][0].kind, 'miter.preview.ready');
  assert.equal(ready[0][1], '*');
  assert.equal(receivers.length, 1);
  assert.deepEqual(attempts, []);
  const receive = receivers[0];
  receive({ source: {}, origin: 'null', data: { kind: 'miter.preview', html: 'foreign' } });

  for (const data of [
    null,
    undefined,
    [],
    {},
    { kind: 'miter.preview', html: null },
    { kind: 'miter.preview', html: 'x'.repeat(36000001) },
    { kind: 'miter.preview', html: '😀'.repeat(18000001) },
    { kind: 'miter.preview', html: '😀'.repeat(18000000) + 'x' },
  ]) {
    receive({ source: parent, data });
  }

  assert.deepEqual(frames, []);
  const html = '\ufeff<p>Literal 😀</p>\r\n<script>unchanged();</script>\r\n';
  receive({ source: parent, origin: 'null', data: { kind: 'miter.preview', html } });
  receive({ source: parent, data: { kind: 'miter.preview', html: 'replay' } });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].attributes.sandbox, 'allow-scripts');
  assert.equal(frames[0].referrerPolicy, 'no-referrer');
  assert.ok(frames[0].srcdoc.endsWith(html));
  assert.match(frames[0].srcdoc, /connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'/);
  assert.deepEqual(attempts, []);
});

test('sandbox compilation confines application modules to its entry and shared schema without framework code', async (context) => {
  for (const extra of [
    ['packages/ui/src/unrelated.ts', '../../../../packages/ui/src/unrelated.ts'],
    ['packages/protocol/src/unrelated.ts', '../../../../packages/protocol/src/unrelated.ts'],
  ]) {
    const fixture = await sandboxSourceFixture(context);
    await fixture.write(extra[0], 'export const unexpected = "outside";');
    await fixture.write(
      'apps/extension/src/preview-sandbox/entry.ts',
      'import { unexpected } from "' + extra[1] + '"; globalThis.unexpected = unexpected;',
    );
    await assert.rejects(previewSandboxBundle(fixture.root), /escaped the isolated preview sandbox build/);
  }

  const escaped = await sandboxSourceFixture(context);
  await escaped.write('outside/unrelated.ts', 'export const unexpected = "symlink escape";');
  await symlink(
    path.join(escaped.root, 'outside/unrelated.ts'),
    path.join(escaped.root, 'apps/extension/src/preview-sandbox/escaped.ts'),
  );
  await escaped.write(
    'apps/extension/src/preview-sandbox/entry.ts',
    'import { unexpected } from "./escaped.ts"; globalThis.unexpected = unexpected;',
  );
  await assert.rejects(previewSandboxBundle(escaped.root), /escaped the isolated preview sandbox build/);

  for (const dependency of [
    'solid-js',
    'wxt',
    'zod',
    'zod/v4/mini',
    'zod/compile',
    'https://remote.test/runtime.js',
  ]) {
    const fixture = await sandboxSourceFixture(context);
    await fixture.write('apps/extension/src/preview-sandbox/entry.ts', 'import "' + dependency + '";');
    await assert.rejects(previewSandboxBundle(fixture.root), /unsupported dependency/);
  }
});

test('page packaging retains its isolated browser IIFE and CLI/import execution', async (context) => {
  const fixture = await fixtureDirectory(context);

  for (const filename of ['build-page.mjs', 'build/preview-sandbox.mjs', 'module-imports.mjs']) {
    await fixture.copyScript(filename);
  }

  for (const filename of ['entry.ts', 'sandbox.ts', 'tsconfig.json']) {
    await fixture.copySource('apps/extension/src/preview-sandbox/' + filename);
  }

  await fixture.copySource('packages/ui/src/preview/sandbox-messages.ts');
  await fixture.write('package.json', JSON.stringify({ type: 'module' }));
  await fixture.write('dist/packages/bridge/src/value.js', 'export const value = "fixture-value";');
  await fixture.write(
    'dist/packages/bridge/src/page-entry.js',
    'import { value } from "./value.js"; globalThis.bridgeFixture = value;',
  );

  for (const args of [
    ['scripts/build-page.mjs'],
    ['--input-type=module', '-e', 'await import("./scripts/build-page.mjs");'],
  ]) {
    const built = runFixtureNode(fixture, args);

    assert.equal(built.error, undefined);
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stdout, /Packaged persistent page bridge \(\d+ bytes\)/);
    assert.match(built.stdout, /Packaged isolated preview sandbox \(\d+ bytes\)/);

    const bundled = await readFile(path.join(fixture.root, 'apps/extension/public/mitter-page.js'), 'utf8');
    const sandbox = {};

    assert.ok(bundled.startsWith('/* Generated by scripts/build-page.mjs. Source: packages/bridge/src. */'));
    assert.deepEqual(moduleReferences(bundled, 'mitter-page.js'), []);
    runInNewContext(bundled, sandbox);
    assert.equal(sandbox.bridgeFixture, 'fixture-value');
    assert.equal(Object.hasOwn(sandbox, 'value'), false);
    const preview = await readFile(
      path.join(fixture.root, 'apps/extension/public/preview-sandbox.js'),
      'utf8',
    );
    assert.ok(preview.startsWith(previewSandboxBanner));
    assert.deepEqual(moduleReferences(preview, 'preview-sandbox.js'), []);
    assert.deepEqual(await previewSandboxBundle(fixture.root), preview);
  }
});
