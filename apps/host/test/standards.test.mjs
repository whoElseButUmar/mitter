import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { parseSync, Visitor } from 'rolldown/utils';
import { checkSourceStandards, sourceFiles } from '../../../scripts/source-standards.mjs';
import { moduleReferences } from '../../../scripts/module-imports.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const directories = ['apps/host/src', 'apps/inference/src'];

test('host and inference use checked types and explicit NodeNext imports', async () => {
  const result = await checkSourceStandards(root, directories);
  assert.deepEqual(result.violations, []);

  for (const filename of await sourceFiles(root, directories)) {
    if (!filename.endsWith('.ts')) {
      continue;
    }

    const source = await readFile(filename, 'utf8');

    for (const reference of moduleReferences(source, filename)) {
      if (reference.specifier.startsWith('.')) {
        assert.ok(reference.specifier.endsWith('.js'), filename + ': ' + reference.specifier);
      }
    }

    const parsed = parseSync(filename, source);

    new Visitor({
      CallExpression(node) {
        if (node.callee.type === 'MemberExpression' && node.callee.object.name === 'z') {
          assert.notEqual(node.callee.property.name, 'custom', filename + ': use a validating schema');
        }
      },
    }).visit(parsed.program);
  }
});
