import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { parseSync, Visitor } from 'rolldown/utils';
import { sourceFiles, sourceViolations } from '../../../../../scripts/source-standards.mjs';

const root = path.resolve(import.meta.dirname, '../../../../..');

test('service dispatch uses braced cases and validates persisted values', async () => {
  const files = await sourceFiles(root, ['apps/host/src/core/service']);
  files.push(path.join(root, 'apps/host/src/core/service.ts'));

  for (const filename of files) {
    const source = await readFile(filename, 'utf8');
    assert.deepEqual(sourceViolations(source, path.relative(root, filename)), []);
    const parsed = parseSync(filename, source);

    new Visitor({
      SwitchCase(node) {
        if (node.consequent.length > 0) {
          assert.equal(node.consequent.length, 1, filename + ': unbraced switch case');
          assert.equal(node.consequent[0].type, 'BlockStatement', filename + ': unbraced switch case');
        }
      },
      CallExpression(node) {
        if (node.callee.type === 'MemberExpression' && node.callee.property.name === 'get') {
          assert.ok(!node.typeArguments, filename + ': typed get without runtime validation');
        }
      },
    }).visit(parsed.program);
  }
});
