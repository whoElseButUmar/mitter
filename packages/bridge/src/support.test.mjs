import assert from 'node:assert/strict';
import { test } from 'node:test';
import './runner/test-source-loader.mjs';

const { NativeRequestTimeout } = await import('./native-request.ts');

test('native timeout errors retain their transport-specific identity and message', () => {
  const error = new NativeRequestTimeout('worker.import');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'NativeRequestTimeout');
  assert.equal(error.code, 'NATIVE_REQUEST_TIMEOUT');
  assert.equal(error.method, 'worker.import');
  assert.equal(error.message, 'worker.import acknowledgement timed out. The outcome is not confirmed.');
});
