import assert from 'node:assert/strict';
import { test } from 'node:test';
import './test-source-loader.mjs';

const { promptResultSchema, handoffSeenResultSchema, replyAdmissionResultSchema } =
  await import('./rpc-results.ts');
const { replyIssueSchema } = await import('../../../protocol/src/validation.ts');
const canonical = await import('../../../protocol/src/rpc.ts');
const { z } = await import('zod');

const issue = {
  stage: 'precondition',
  code: 'BASE_UNAVAILABLE',
  message: 'Read the file again before editing.',
  field: 'base',
  actionIndex: 0,
};

test('RPC prompt and report results preserve exact strings without coercion', () => {
  for (const prompt of ['', '  exact prompt\n', 'control\u0000text']) {
    assert.equal(promptResultSchema.parse(prompt), prompt);
  }
  for (const prompt of [undefined, null, 1, {}, ['prompt']]) {
    assert.equal(promptResultSchema.safeParse(prompt).success, false);
  }
});

test('RPC receipt results require an explicit boolean instead of truthy or missing data', () => {
  for (const seen of [true, false]) {
    assert.deepEqual(handoffSeenResultSchema.parse({ seen }), { seen });
  }
  for (const result of [undefined, null, {}, { seen: 'false' }, { seen: 0 }]) {
    assert.equal(handoffSeenResultSchema.safeParse(result).success, false);
  }
});

test('RPC admission results validate shared issues and require rejection feedback', () => {
  assert.deepEqual(replyAdmissionResultSchema.parse({ valid: true }), { valid: true });
  assert.deepEqual(replyAdmissionResultSchema.parse({ valid: false, issue }), {
    valid: false,
    issue: replyIssueSchema.parse(issue),
  });
  assert.equal('issue' in replyAdmissionResultSchema.parse({ valid: true }), false);
  for (const result of [
    undefined,
    null,
    {},
    { valid: 'true' },
    { valid: false },
    { valid: true, issue: { ...issue, stage: 'execution' } },
    { valid: false, issue: { ...issue, code: 1 } },
    { valid: false, issue: { ...issue, message: null } },
    { valid: false, issue: { ...issue, field: 0 } },
    { valid: false, issue: { ...issue, actionIndex: -1 } },
    { valid: false, issue: { ...issue, actionIndex: 0.5 } },
  ]) {
    assert.equal(replyAdmissionResultSchema.safeParse(result).success, false);
  }
});

test('RPC result aliases are the canonical schemas, not competing projections', () => {
  assert.equal(promptResultSchema, canonical.promptResultSchema);
  assert.equal(handoffSeenResultSchema, canonical.handoffSeenResultSchema);
  assert.equal(replyAdmissionResultSchema, canonical.replyValidationResultSchema);
});

function assertDescribed(schema) {
  assert.ok(schema.description.length > 10);
  if (schema instanceof z.ZodObject) {
    for (const field of Object.values(schema.shape)) {
      assert.ok(field.description.length > 10);
    }
  }
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      assertDescribed(option);
    }
  }
}

test('RPC result schemas and their fields have simple English descriptions', () => {
  for (const schema of [promptResultSchema, handoffSeenResultSchema, replyAdmissionResultSchema]) {
    assertDescribed(schema);
  }
});
