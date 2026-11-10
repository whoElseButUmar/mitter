import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkSourceStandards, sourceFiles, sourceViolations } from '../source-standards.mjs';
import { reportSourceStandards } from '../check-source-standards.mjs';

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mitter-source-standards-'));

  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const directory of ['apps', 'packages', 'scripts']) {
    await mkdir(path.join(root, directory));
  }

  return {
    root,
    async write(filename, source) {
      const target = path.join(root, filename);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    },
  };
}

test('source checks reject unchecked types and assertions', () => {
  const cases = [
    ['type Value = any;', 'any'],
    ['interface Value { name: string; }', 'interface'],
    ['const value = input as string;', 'assertion'],
    ['const value = <string>input;', 'assertion'],
    ['input!.name;', 'assertion'],
    ['class Value { name!: string; }', 'assignment'],
    ['let name!: string;', 'assignment'],
    ['root.querySelector<HTMLButtonElement>("button");', 'assertion'],
    ['root.querySelectorAll<HTMLButtonElement>("button");', 'assertion'],
    ['node.closest<HTMLButtonElement>("button");', 'assertion'],
    ['const schema = z.custom<Value>();', 'schema'],
  ];

  for (const [source, rule] of cases) {
    const violations = sourceViolations(source, 'example.ts');

    assert.equal(violations.length, 1, source);
    assert.equal(violations[0].rule, rule, source);
    assert.equal(violations[0].file, 'example.ts');
  }
});

test('source checks reject ternaries and unbraced control flow', () => {
  const cases = [
    ['const value = ready ? first : second;', 'conditional'],
    ['if (ready) run();', 'braces'],
    ['if (ready) { run(); } else stop();', 'braces'],
    ['for (;;) run();', 'braces'],
    ['for (const value of values) run(value);', 'braces'],
    ['for (const key in values) run(key);', 'braces'],
    ['while (ready) run();', 'braces'],
    ['do run(); while (ready);', 'braces'],
  ];

  for (const [source, rule] of cases) {
    const violations = sourceViolations(source);

    assert.equal(violations.length, 1, source);
    assert.equal(violations[0].rule, rule, source);
  }
});

test('source checks accept literal const assertions, narrowing and braced branches', () => {
  const source = `
    type Value = { name: string };
    const state = { phase: 'idle' } as const;
    const value: unknown = input;

    if (typeof value === 'string') {
      run(value);
    } else if (value === null) {
      stop();
    } else {
      wait();
    }

    const button = root.querySelector('button');

    if (button instanceof HTMLButtonElement) {
      button.focus();
    }

    for (const item of items) {
      run(item);
    }
  `;

  assert.deepEqual(sourceViolations(source), []);
  assert.deepEqual(sourceViolations('const view = <button>Save</button>;', 'example.tsx'), []);
});

test('source checks inspect syntax rather than strings and comments', () => {
  const source = `
    // interface Value { anything: any } if (ready) run();
    const example = 'input as string; input!; ready ? first : second;';
    const pattern = /interface|any/;
  `;

  assert.deepEqual(sourceViolations(source), []);
  assert.equal(sourceViolations('const value = ;')[0].rule, 'syntax');
  assert.equal(sourceViolations('const value = 1;\n\nconst other = ;')[0].line, 3);
  assert.equal(sourceViolations('const value = 1;\rconst other = ;')[0].line, 2);
  assert.equal(sourceViolations('const value = 1;\r\nconst other = input as string;')[0].line, 2);
  assert.deepEqual(sourceViolations('const schema = z.custom<Value>(isValue);'), []);
  assert.equal(sourceViolations('const value = 1;\n\nconst other = input as string;')[0].line, 3);
});

test('source checks reject Zod any through namespace, computed and named imports', () => {
  for (const source of [
    'const valueSchema = z.any();',
    'const valueSchema = z["any"]();',
    'import { z as schema } from "zod"; const valueSchema = schema.any();',
    'import * as schema from "zod/mini"; const valueSchema = schema.any();',
    'import { any as unchecked } from "zod/mini"; const valueSchema = unchecked();',
  ]) {
    const violations = sourceViolations(source);

    assert.equal(violations.length, 1, source);
    assert.equal(violations[0].rule, 'schema-any', source);
  }

  assert.deepEqual(sourceViolations('const valueSchema = z.unknown();'), []);
});

test('constructor-declared exported schemas need their own description', () => {
  for (const source of [
    'export const valueSchema = z.object({});',
    'export const valueSchema = z.object({name: z.string().describe("A name.")});',
    'export const valueSchema = z.string().describe("");',
    'export const valueSchema = z.string().describe("   ");',
    'export const valueSchema = z.string().describe(`   `);',
    'export const valueSchema = z.object({}) satisfies z.ZodType;',
    'export const valueSchema = z.string().describe("A value.").optional();',
    'export const valueSchema = z.object({}).check(z.refine(isValue));',
    'const valueSchema = z.number(); export {valueSchema as countSchema};',
    'import { z as schema } from "zod/mini"; export const valueSchema = schema.object({});',
    'import { object as record } from "zod/mini"; export const valueSchema = record({});',
    'export const valueSchema = z.coerce.number();',
  ]) {
    const violations = sourceViolations(source);

    assert.equal(violations.length, 1, source);
    assert.equal(violations[0].rule, 'schema-description', source);
  }
});

test('schema descriptions accept Classic and Mini metadata without requiring duplicate aliases', () => {
  for (const source of [
    'export const valueSchema = z.object({}).describe("A saved value.");',
    'export const valueSchema = z.object({}).describe(`A saved value.`) satisfies z.ZodType;',
    'export const valueSchema = z.object({}).check(z.describe("A saved value."));',
    'export const valueSchema = z.object({}).check(z.refine(isValue), z.describe("A saved value."));',
    'import { z as schema } from "zod/mini"; export const valueSchema = schema.object({}).check(schema.describe("A saved value."));',
    'import { object, describe } from "zod/mini"; export const valueSchema = object({}).check(describe("A saved value."));',
    'export const valueSchema = canonicalValueSchema;',
    'export const valueSchema = canonicalValueSchema.extend({name: z.string()});',
    'export {valueSchema} from "./canonical.js";',
    'export type Value = z.infer<typeof valueSchema>;',
    'export const value = z.object({}).parse(input);',
    'export const controller = createController();',
    'const internalSchema = z.object({});',
  ]) {
    assert.deepEqual(sourceViolations(source), [], source);
  }
});

test('source discovery excludes regenerated files and does not follow symlinks', async (context) => {
  const files = await fixture(context);
  const included = [
    'apps/view/main.tsx',
    'apps/view/control.jsx',
    'packages/value.ts',
    'packages/module.mts',
    'packages/common.cts',
    'scripts/check.mjs',
    'scripts/helper.js',
    'scripts/common.cjs',
  ];

  for (const filename of included) {
    await files.write(filename, 'const value = 1;');
  }

  for (const filename of [
    'apps/extension/public/mitter-page.js',
    'apps/extension/public/preview-sandbox.js',
    'apps/extension/.output/bundle.js',
    'apps/extension/.wxt/generated.ts',
    'packages/node_modules/dependency/index.ts',
    'packages/dist/output.js',
    'scripts/.cache/cached.js',
    'scripts/.pnpm-store/dependency.js',
    'scripts/notes.md',
  ]) {
    await files.write(filename, 'this is not source');
  }

  await symlink(
    path.join(files.root, 'packages'),
    path.join(files.root, 'apps', 'linked-package'),
    'junction',
  );
  await symlink(path.join(files.root, 'packages', 'value.ts'), path.join(files.root, 'scripts', 'linked.ts'));

  const discovered = await sourceFiles(files.root);
  assert.deepEqual(
    discovered.map((filename) => path.relative(files.root, filename)),
    included.sort(),
  );

  const result = await checkSourceStandards(files.root);
  assert.deepEqual(result, { checked: included.length, violations: [] });

  const scripts = await checkSourceStandards(files.root, ['scripts']);
  assert.equal(scripts.checked, 3);
});

test('the repository report identifies offending files and fails without changing source', async (context) => {
  const files = await fixture(context);
  const messages = [];

  context.mock.method(console, 'log', (message) => messages.push(message));
  context.mock.method(console, 'error', (message) => messages.push(message));

  await files.write('packages/example.ts', 'const value = input as string;');

  assert.equal(await reportSourceStandards(files.root), false);
  assert.ok(messages.some((message) => message.startsWith('packages/example.ts:1:')));
  assert.ok(messages.some((message) => message.includes('1 violations in 1 files')));

  await files.write('packages/example.ts', 'const value: unknown = input;');
  messages.length = 0;

  assert.equal(await reportSourceStandards(files.root), true);
  assert.deepEqual(messages, ['Source standards passed: 1 files checked.']);
});
