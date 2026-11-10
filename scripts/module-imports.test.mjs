import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { moduleReferences, isFrameworkSpecifier } from './module-imports.mjs';
import { sourceManifest } from './check-security-policy.mjs';

test('module inspection distinguishes runtime imports from types and quoted examples', () => {
  const source = [
    'import type { Component } from "solid-js";',
    'import { type Config } from "wxt";',
    'import value, { type Config } from "mixed";',
    'export { type Component } from "types";',
    'export * from "runtime";',
    'import legacy = require("legacy");',
    'const lazy = import("lazy");',
    'const loaded = require(`loaded`);',
    '// import "comment";',
    'const example = "import fake from \'example\'";',
    'import(`dynamic-${name}`);',
  ].join('\n');

  assert.deepEqual(moduleReferences(source), [
    { specifier: 'solid-js', typeOnly: true, line: 1 },
    { specifier: 'wxt', typeOnly: true, line: 2 },
    { specifier: 'mixed', typeOnly: false, line: 3 },
    { specifier: 'types', typeOnly: true, line: 4 },
    { specifier: 'runtime', typeOnly: false, line: 5 },
    { specifier: 'legacy', typeOnly: false, line: 6 },
    { specifier: 'lazy', typeOnly: false, line: 7 },
    { specifier: 'loaded', typeOnly: false, line: 8 },
  ]);

  assert.throws(() => {
    moduleReferences('import {', 'broken.ts');
  }, /Cannot inspect/);
});

test('module inspection retains side effects, mixed exports and CRLF line numbers', () => {
  const source = [
    'import "solid-js/web";',
    'import {} from "wxt";',
    'export {} from "empty";',
    'export { value, type Config } from "mixed";',
    'export type * from "types";',
    'import type legacy = require("legacy-types");',
    'import(`literal`);',
    'require(name);',
    'loader.require("method");',
    'import("prefix-" + name);',
  ].join('\r\n');

  assert.deepEqual(moduleReferences(source), [
    { specifier: 'solid-js/web', typeOnly: false, line: 1 },
    { specifier: 'wxt', typeOnly: false, line: 2 },
    { specifier: 'empty', typeOnly: false, line: 3 },
    { specifier: 'mixed', typeOnly: false, line: 4 },
    { specifier: 'types', typeOnly: true, line: 5 },
    { specifier: 'legacy-types', typeOnly: true, line: 6 },
    { specifier: 'literal', typeOnly: false, line: 7 },
  ]);
});

test('framework specifiers include subpaths and generated imports but not similar names', () => {
  for (const specifier of [
    'solid-js',
    'solid-js/web',
    'wxt',
    'wxt/utils/define-background',
    '@wxt-dev/module-solid',
    '#imports',
    '#imports/generated',
  ]) {
    assert.equal(isFrameworkSpecifier(specifier), true, specifier);
  }

  for (const specifier of [
    'solid-js-extra',
    'wxt-extra',
    '@wxt-dev-extra/module-solid',
    '#imports-extra',
    './solid-js',
    'node:path',
  ]) {
    assert.equal(isFrameworkSpecifier(specifier), false, specifier);
  }
});

async function manifestFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'miter-manifest-'));
  const directory = path.join(root, 'apps/extension');

  await mkdir(directory, { recursive: true });
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    write(source) {
      return writeFile(path.join(directory, 'wxt.config.ts'), source);
    },
  };
}

test('manifest inspection reads literal values through TypeScript syntax without executing code', async (context) => {
  const fixture = await manifestFixture(context);

  await fixture.write(`
    throw new Error('This file must not execute');
    export default {
      manifest: ({ name: 'Miter', enabled: true, permissions: ['storage'], icons: { 16: 'icon.png' } } as const),
    };
  `);

  assert.deepEqual(await sourceManifest(fixture.root), {
    name: 'Miter',
    enabled: true,
    permissions: ['storage'],
    icons: { 16: 'icon.png' },
  });
});

test('manifest inspection rejects dynamic fields, duplicate fields, and ambiguous manifests', async (context) => {
  const fixture = await manifestFixture(context);
  const invalidSources = [
    'export default { manifest: { ...settings } };',
    'export default { manifest: { name: getName() } };',
    "export default { manifest: { ['name']: 'Miter' } };",
    "export default { manifest: { name: 'One', name: 'Two' } };",
    "export default { manifest: { get name() { return 'Miter'; } } };",
    'export default { manifest: {}, other: { manifest: {} } };',
    'export default { manifest: { permissions: [permission] } };',
    'export default { manifest: { permissions: [,] } };',
    'export default { manifest: { name: `dynamic-${name}` } };',
    'export default { manifest: {',
  ];

  for (const source of invalidSources) {
    await fixture.write(source);
    await assert.rejects(sourceManifest(fixture.root));
  }
});
