import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import { InferenceQueue } from '../src/inference.js';
import { modelOutputSchema, modelResponseSchema, parseModelOutput } from '../src/protocol.js';

const settings = { coderModelPath: '', contextSize: 8192, maxTokens: 2048, gpu: 'auto' };
const request = { id: 'request', method: 'propose', input: 'literal prompt', settings };

test('malformed inference requests are rejected before invoking the model driver', async () => {
  const calls = [];
  const responses = [];
  const queue = new InferenceQueue(
    {
      async propose(input) {
        calls.push(input);
        return input;
      },
    },
    (response) => responses.push(modelResponseSchema.parse(response)),
    (error) => {
      throw error;
    },
  );

  for (const message of [
    null,
    { ...request, id: 12 },
    { ...request, method: 'execute' },
    { ...request, input: { text: 'unchecked' } },
    { ...request, settings: { ...settings, contextSize: '8192' } },
    { ...request, settings: { ...settings, maxTokens: 8192 } },
    { ...request, settings: { ...settings, gpu: true } },
    { ...request, extra: true },
  ]) {
    await queue.submit(message);
  }

  assert.deepEqual(calls, []);
  assert.equal(responses.length, 6);
  assert.ok(responses.every((response) => response.id === request.id && response.ok === false));
  await queue.submit(request);
  assert.deepEqual(calls, ['literal prompt']);
  assert.equal(responses.at(-1).result, 'literal prompt');
});

test('non-string driver results produce checked failures without coercion and do not poison the IPC queue', async () => {
  const responses = [];
  let result;
  let coerced = 0;
  const queue = new InferenceQueue(
    { propose: async () => result },
    (response) => responses.push(modelResponseSchema.parse(response)),
    (error) => {
      throw error;
    },
  );

  for (const invalid of [
    undefined,
    null,
    12,
    {},
    {
      toString: () => {
        coerced++;
        return 'unchecked';
      },
    },
  ]) {
    result = invalid;
    await queue.submit(request);
    assert.deepEqual(responses.at(-1), {
      id: request.id,
      ok: false,
      error: 'Local model returned invalid text. No actions were proposed.',
    });
  }

  result = '\ufeff  {"summary":"literal"}\r\n';
  await queue.submit(request);
  assert.deepEqual(responses.at(-1), { id: request.id, ok: true, result });
  assert.equal(coerced, 0);
});

test('model text contracts preserve empty and byte-exact output and retain validation diagnostics as causes', () => {
  assert.equal(typeof modelOutputSchema.description, 'string');

  for (const literal of ['', '\ufeff\r\n  source  ', '$&`\\\n界']) {
    assert.equal(parseModelOutput(literal), literal);
    assert.equal(modelResponseSchema.parse({ id: 'literal', ok: true, result: literal }).result, literal);
  }

  assert.throws(
    () => parseModelOutput({ text: 'must not be coerced' }),
    (error) => {
      assert.equal(error.message, 'Local model returned invalid text. No actions were proposed.');
      assert.ok(error.cause instanceof ZodError);
      return true;
    },
  );
});
