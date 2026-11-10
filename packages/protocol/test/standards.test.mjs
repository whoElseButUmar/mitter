import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { checkSourceStandards, sourceFiles } from '../../../scripts/source-standards.mjs';
import { moduleReferences } from '../../../scripts/module-imports.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const sourceDirectory = path.join(root, 'packages/protocol/src');

test('protocol source and tests use checked types and explicit control flow', async () => {
  const result = await checkSourceStandards(root, ['packages/protocol']);

  assert.deepEqual(result.violations, []);
});

test('protocol module dependencies are acyclic and never import host, bridge or UI', async () => {
  const files = await sourceFiles(root, ['packages/protocol/src']);
  const modules = new Set(files);
  const graph = new Map();

  for (const filename of files) {
    const imports = [];
    const source = await readFile(filename, 'utf8');

    for (const reference of moduleReferences(source, filename)) {
      if (reference.specifier === 'zod') {
        continue;
      }

      assert.ok(reference.specifier.startsWith('.'), reference.specifier);
      const target = path.resolve(path.dirname(filename), reference.specifier.replace(/\.js$/, '.ts'));
      assert.ok(modules.has(target), filename + ' -> ' + target);
      imports.push(target);
    }

    graph.set(filename, imports);
  }

  const completed = new Set();

  function visit(filename, ancestors) {
    const chain = ancestors.concat(filename).map((name) => path.relative(sourceDirectory, name));
    assert.equal(ancestors.includes(filename), false, chain.join(' -> '));

    if (completed.has(filename)) {
      return;
    }

    for (const target of graph.get(filename)) {
      visit(target, ancestors.concat(filename));
    }

    completed.add(filename);
  }

  for (const filename of files) {
    visit(filename, []);
  }
});
