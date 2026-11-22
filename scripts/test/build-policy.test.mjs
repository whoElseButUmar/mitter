import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';

import path from 'node:path';
import { test } from 'node:test';
import { checkBundleImports } from '../check-bundle-imports.mjs';
import { checkExtensionBoundaries } from '../check-extension-boundaries.mjs';
import { checkManifestSecurity, checkSecurityPolicy } from '../check-security-policy.mjs';
import { checkPreviewSandboxBundle, previewSandboxBanner } from '../build/preview-sandbox.mjs';

import {
  buildManifestSchema,
  buildPackageSchema,
  extensionPackageSchema,
  securityManifestSchema,
} from '../build/contracts.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

function approvedManifest() {
  return {
    permissions: [
      'nativeMessaging',
      'sidePanel',
      'storage',
      'clipboardWrite',
      'scripting',
      'fontSettings',
      'offscreen',
    ],
    optional_permissions: ['clipboardRead', 'notifications'],
    optional_host_permissions: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    sandbox: { pages: ['preview-sandbox.html'] },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'none'; frame-src 'self' blob:; connect-src 'self' blob:",
      sandbox:
        "sandbox allow-scripts; script-src 'self' 'unsafe-inline'; child-src 'self' blob: about:; object-src 'none'",
    },
  };
}

async function policyFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mitter-build-policy-'));

  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    async write(filename, source) {
      const target = path.join(root, filename);

      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    },
  };
}

test('build JSON schemas describe and validate only the metadata fields they consume', () => {
  assert.deepEqual(buildPackageSchema.parse({ version: '1.2.3-rc.1', scripts: {} }), {
    version: '1.2.3-rc.1',
  });

  for (const value of [null, [], {}, { version: 1 }, { version: 'latest' }]) {
    assert.equal(buildPackageSchema.safeParse(value).success, false);
  }

  assert.deepEqual(
    extensionPackageSchema.parse({
      name: '@mitter/extension',
      dependencies: { 'solid-js': '^1.0.0' },
      devDependencies: { 'vite-plugin-solid': '2.11.14' },
    }),
    {
      dependencies: { 'solid-js': '^1.0.0' },
      devDependencies: { 'vite-plugin-solid': '2.11.14' },
    },
  );

  for (const value of [
    null,
    [],
    { dependencies: [] },
    { dependencies: { runtime: 1 } },
    { devDependencies: { '../runtime': '1.0.0' } },
  ]) {
    assert.equal(extensionPackageSchema.safeParse(value).success, false);
  }

  const manifest = {
    ...approvedManifest(),
    version: '1.2.3',
    version_name: '1.2.3-rc.1',
    key: 'YWJj',
  };

  assert.equal(buildManifestSchema.safeParse(manifest).success, true);
  assert.equal(buildManifestSchema.safeParse({ ...manifest, version: 1 }).success, false);
  assert.equal(buildManifestSchema.safeParse({ ...manifest, key: 'invalid key' }).success, false);

  for (const schema of [
    buildPackageSchema,
    extensionPackageSchema,
    securityManifestSchema,
    buildManifestSchema,
  ]) {
    assert.equal(typeof schema.description, 'string');
  }
});

test('security policy preserves exact permissions and optional website access', () => {
  const manifest = approvedManifest();
  const original = structuredClone(manifest);

  assert.deepEqual(checkManifestSecurity(manifest), {
    permissions: 7,
    optionalPermissions: 2,
    websiteAccess: 'optional',
    remoteExtensionCode: false,
  });
  assert.deepEqual(manifest, original);

  const expansions = [
    { permissions: [...manifest.permissions, 'tabs'] },
    { permissions: [...manifest.permissions, 'storage'] },
    { permissions: manifest.permissions.slice(1) },
    {
      optional_permissions: [...manifest.optional_permissions, 'fontSettings'],
    },
    { optional_permissions: [...manifest.optional_permissions, 'tabs'] },
    {
      optional_permissions: [...manifest.optional_permissions, 'notifications'],
    },
    { optional_permissions: ['notifications'] },
    {
      optional_host_permissions: [...manifest.optional_host_permissions, 'https://example.com/*'],
    },
    {
      optional_host_permissions: [...manifest.optional_host_permissions, 'https://chatgpt.com/*'],
    },
    { optional_host_permissions: ['https://chatgpt.com/*'] },
    { host_permissions: ['https://chatgpt.com/*'] },
    { externally_connectable: {} },
    {
      content_scripts: [{ matches: ['https://chatgpt.com/*'], js: ['inject.js'] }],
    },
    { sandbox: { pages: [] } },
  ];

  for (const patch of expansions) {
    assert.throws(() => {
      checkManifestSecurity({ ...manifest, ...patch });
    });
  }

  for (const malformed of [
    null,
    [],
    { ...manifest, permissions: 'storage' },
    { ...manifest, permissions: [1] },
  ]) {
    assert.throws(() => {
      checkManifestSecurity(malformed);
    });
  }
});

test('security policy rejects unsafe CSP directives, duplicates and sandbox privileges', () => {
  const manifest = approvedManifest();
  const extensionPolicy = manifest.content_security_policy.extension_pages;
  const invalidPolicies = [
    extensionPolicy + "; script-src 'self'",
    extensionPolicy.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
    extensionPolicy.replace("object-src 'none'", "object-src 'self'"),
    extensionPolicy.replace("frame-src 'self' blob:", 'frame-src https://example.com'),
    extensionPolicy.replace("connect-src 'self' blob:", 'connect-src https://example.com'),
    extensionPolicy.replace("connect-src 'self' blob:", ''),
  ];

  for (const extensionPages of invalidPolicies) {
    assert.throws(() => {
      checkManifestSecurity({
        ...manifest,
        content_security_policy: {
          ...manifest.content_security_policy,
          extension_pages: extensionPages,
        },
      });
    }, /Duplicate CSP directive|Unsafe .* policy/);
  }

  assert.throws(() => {
    checkManifestSecurity({ ...manifest, content_security_policy: {} });
  }, /Missing extension CSP/);
  assert.throws(() => {
    checkManifestSecurity({
      ...manifest,
      content_security_policy: {
        ...manifest.content_security_policy,
        sandbox: 'sandbox allow-scripts allow-same-origin;',
      },
    });
  }, /Unexpected preview sandbox privileges/);
});

test('static security checks reject remote scripts without executing the source config', async (context) => {
  const fixture = await policyFixture(context);

  await fixture.write(
    'apps/extension/wxt.config.ts',
    "throw new Error('Do not execute'); export default { manifest: " +
      JSON.stringify(approvedManifest()) +
      ' };',
  );
  await fixture.write('apps/extension/public/preview.html', '<script src="preview.js"></script>');
  await fixture.write('apps/extension/public/ignored.js', 'not a page');
  assert.equal((await checkSecurityPolicy(fixture.root)).staticPagesChecked, 1);

  for (const source of [
    'https://example.com/code.js',
    '//example.com/code.js',
    'data:text/javascript,alert(1)',
  ]) {
    await fixture.write('apps/extension/public/preview.html', '<script src="' + source + '"></script>');
    await assert.rejects(checkSecurityPolicy(fixture.root), /Remote script in extension page: preview.html/);
  }
});

test('bundle checks recurse through all JavaScript variants and reject runtime framework imports', async (context) => {
  const fixture = await policyFixture(context);

  await fixture.write('page.js', '// import "solid-js";\nconst example = "wxt";');
  await fixture.write('nested/page.mjs', 'export const value = 1;');
  await fixture.write('nested/page.cjs', 'const value = require("node:path");');
  await fixture.write('ignored.json', 'not JavaScript');
  assert.deepEqual(await checkBundleImports(fixture.root), { checked: 3 });

  for (const source of [
    'import "solid-js/web";',
    'export * from "wxt";',
    'import("@wxt-dev/module-solid");',
    'require(`#imports`);',
  ]) {
    await fixture.write('nested/page.mjs', '// first line\n' + source);
    await assert.rejects(checkBundleImports(fixture.root), /nested\/page.mjs:2: unbundled/);
  }

  await fixture.write('nested/page.mjs', 'import {');
  await assert.rejects(checkBundleImports(fixture.root), /Cannot inspect/);
});

test('bundle verification rejects missing local chunks and confined-path escapes', async (context) => {
  const fixture = await policyFixture(context);

  for (const source of [
    'import "./missing.js";',
    'export * from "./missing.js";',
    'import(`./missing.js`);',
  ]) {
    await fixture.write('page.js', source);
    await assert.rejects(checkBundleImports(fixture.root), /missing local module/);
  }

  await fixture.write('page.js', 'import "./chunks/panel.js?version=1#panel";');
  await fixture.write('chunks/panel.js', 'export const panel = true;');
  assert.deepEqual(await checkBundleImports(fixture.root), { checked: 2 });

  await fixture.write('page.js', 'import "../outside.js";');
  await assert.rejects(checkBundleImports(fixture.root), /module escapes extension output/);
});

test('generated preview assets remain strict classic IIFEs with no runtime modules or privilege expansion', () => {
  const wrap = (body) => previewSandboxBanner + '\n(function () { "use strict"; ' + body + ' })();';
  assert.doesNotThrow(() =>
    checkPreviewSandboxBundle(
      wrap('const literal = "import solid-js; chrome.runtime; https://remote.test";'),
    ),
  );
  assert.doesNotThrow(() =>
    checkPreviewSandboxBundle(previewSandboxBanner + '\n"use strict"; (function () {})();'),
  );

  for (const source of [
    'globalThis.preview = true;',
    previewSandboxBanner + '\nconst outside = true;',
    previewSandboxBanner + '\n(function () {})();',
    wrap('') + '\nconst outside = true;',
    previewSandboxBanner + '\nimport "zod";',
    wrap('import("https://remote.test/code.js");'),
    wrap('import("./local-runtime.js");'),
    wrap('import.meta.url;'),
    wrap('require("solid-js");'),
    wrap('eval("code");'),
    wrap('new Function("code");'),
    wrap('const F = Function; new F("code");'),
    wrap('const execute = eval; execute("code");'),
    wrap('Reflect.construct(Function, ["code"]);'),
    wrap('(0, eval)("code");'),
    wrap('fetch("https://remote.test");'),
    wrap('window.fetch("https://remote.test");'),
    wrap('globalThis["fetch"]("https://remote.test");'),
    wrap('importScripts("https://remote.test/code.js");'),
    wrap('chrome.runtime.connect();'),
    wrap('globalThis["chrome"].runtime.connect();'),
    wrap('new XMLHttpRequest();'),
    wrap('new WebSocket("wss://remote.test");'),
    wrap('new Worker("worker.js");'),
  ]) {
    assert.throws(() => checkPreviewSandboxBundle(source));
  }

  assert.throws(() => checkPreviewSandboxBundle(previewSandboxBanner + '\n(function ('), /Cannot inspect/);
});

test('preview artifact checks reject aliased API properties and hidden global names without banning computed data', () => {
  const wrap = (body) => previewSandboxBanner + '\n(function () { "use strict"; ' + body + ' })();';

  for (const body of [
    'const scope = globalThis; scope.fetch("https://remote.test");',
    'const scope = window; scope["fe" + "tch"]("https://remote.test");',
    'const scope = self; scope["ch" + "rome"].runtime.connect();',
    'const scope = globalThis; scope["Fun" + ("ct" + "ion")]("code");',
    'globalThis["Fun" + "ction"]("code");',
    'globalThis[`Function`]("code");',
    'const scope = {}; scope["Web" + "Socket"]("wss://remote.test");',
    'const scope = globalThis; scope.importScripts("https://remote.test/code.js");',
    'const load = fetch; load("https://remote.test");',
    'const { fetch: load } = globalThis; load("https://remote.test");',
    'globalThis[property]("code");',
    'window[chooseProperty()]("code");',
    '(self)[property]("code");',
    'globalThis["Fun" + suffix]("code");',
    'globalThis[`Fun${suffix}`]("code");',
    'globalThis[0];',
  ]) {
    assert.throws(() => checkPreviewSandboxBundle(wrap(body)));
  }

  for (const body of [
    'const data = { html: "literal" }; const key = "html"; data[key];',
    'const data = { html: "literal" }; const prefix = "ht"; data[prefix + "ml"];',
    'const data = { html: "literal" }; data["ht" + "ml"];',
    'globalThis["JS" + "ON"].stringify({ html: "literal" });',
    'const text = "scope.fetch; globalThis[Fun + ction]";',
  ]) {
    assert.doesNotThrow(() => checkPreviewSandboxBundle(wrap(body)));
  }
});

test('shared boundaries reject both type and runtime framework imports and retain compiler safeguards', async (context) => {
  const fixture = await policyFixture(context);
  const configSource = await readFile(path.join(repositoryRoot, 'apps/extension/wxt.config.ts'), 'utf8');
  const config = configSource.replace(/^\s*\/\/.*$/gm, '');
  const packageMetadata = {
    devDependencies: { 'vite-plugin-solid': '2.11.14' },
  };
  const sharedFilename = 'packages/ui/src/component.ts';

  await fixture.write('apps/extension/wxt.config.ts', config);
  await fixture.write('apps/extension/package.json', JSON.stringify(packageMetadata));
  await fixture.write(
    'apps/extension/entrypoints/background.ts',
    "import { defineBackground } from 'wxt/utils/define-background';",
  );

  for (const packageName of ['ui', 'bridge', 'protocol', 'terminal']) {
    await fixture.write('packages/' + packageName + '/src/component.ts', 'export const value = 1;');
  }

  await fixture.write('packages/ui/src/node_modules/ignored.ts', 'not valid source');
  assert.deepEqual(await checkExtensionBoundaries(fixture.root), {
    checked: 4,
  });

  for (const source of ['import type { Component } from "solid-js";', 'export * from "#imports";']) {
    await fixture.write(sharedFilename, source);
    await assert.rejects(checkExtensionBoundaries(fixture.root), /must stay framework-independent/);
  }

  await fixture.write(sharedFilename, 'export const value = 1;');
  await fixture.write(
    'apps/extension/package.json',
    JSON.stringify({
      ...packageMetadata,
      dependencies: { '@wxt-dev/module-solid': '1.1.0' },
    }),
  );
  await assert.rejects(checkExtensionBoundaries(fixture.root), /direct Solid Vite compiler, not the wrapper/);
  await fixture.write(
    'apps/extension/package.json',
    JSON.stringify({ devDependencies: { 'vite-plugin-solid': '^2.11.14' } }),
  );
  await assert.rejects(checkExtensionBoundaries(fixture.root), /Pin the direct Solid Vite compiler exactly/);
  await fixture.write('apps/extension/package.json', JSON.stringify(packageMetadata));

  for (const [pattern, replacement, expectedError] of [
    ['imports: false', 'imports: true', /auto-imports must stay disabled/],
    ['plugins: [solid()]', 'plugins: []', /compiler must be registered/],
    [
      'enforceExplicitImportPolicy(wxt.config.imports)',
      'ignorePolicy(wxt.config.imports)',
      /catalog must be cleared/,
    ],
    ["dedupe: ['solid-js']", 'dedupe: []', /single Solid runtime/],
  ]) {
    assert.ok(config.includes(pattern), 'Fixture must contain ' + pattern);
    await fixture.write('apps/extension/wxt.config.ts', config.replace(pattern, replacement));
    await assert.rejects(checkExtensionBoundaries(fixture.root), expectedError);
  }

  await fixture.write('apps/extension/wxt.config.ts', config);
  await fixture.write('apps/extension/entrypoints/background.ts', 'export const background = {};');
  await assert.rejects(checkExtensionBoundaries(fixture.root), /import defineBackground explicitly/);
});
