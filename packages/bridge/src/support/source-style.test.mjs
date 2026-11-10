import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { checkSourceStandards } from '../../../../scripts/source-standards.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');

test('bridge and terminal source and tests use checked narrowing and explicit control flow', async () => {
  const result = await checkSourceStandards(root, [
    'packages/bridge/src',
    'packages/terminal/src',
    'packages/terminal/test',
  ]);

  assert.deepEqual(result.violations, []);
});
