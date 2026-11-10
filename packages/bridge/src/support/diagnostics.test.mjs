import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';
const { Diagnostics, redactDebug } = await import('../diagnostics.ts');

test('diagnostics redact credentials, bound entries and return defensive copies without resetting IDs', () => {
  const changes = [];
  const diagnostics = new Diagnostics((entries) => changes.push(entries), 2);
  const secret = 'Bearer abc.def password="hidden" api_key=hidden sk-abcdefghijkl ghp_abcdefghijkl';
  assert.equal(
    redactDebug(secret),
    'Bearer [redacted] password="[redacted]" api_key=[redacted] [redacted] [redacted]',
  );
  diagnostics.add('first', secret, 1);
  diagnostics.add('second', 'x'.repeat(5000), 2);
  diagnostics.add('third', 'Kept', 3);
  assert.deepEqual(
    diagnostics.read().map((entry) => entry.id),
    [2, 3],
  );
  assert.equal(diagnostics.read()[0].message.length, 4000);
  changes.at(-1)[0].message = 'Mutated';
  assert.equal(diagnostics.read()[0].message.length, 4000);
  diagnostics.clear();
  diagnostics.add('fourth', 'Kept', 4);
  assert.equal(diagnostics.read()[0].id, 4);
});
