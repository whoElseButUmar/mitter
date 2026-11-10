import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import * as protocol from '../src/index.ts';
import * as rpc from '../src/rpc.ts';
import { proposalEnvelopeSchema, referencedEditSchema } from '../src/proposal.ts';
import {
  codeSelectionSchema,
  followupSchema,
  followupSummarySchema,
  followupRequestSchema,
} from '../src/requests.ts';
import { replyIssueSchema } from '../src/validation.ts';
import { rewriteRequestSchema } from '../src/rewrite.ts';
import { taskBriefSchema } from '../src/task-brief.ts';
import { nativeFragmentSchema } from '../src/native-transfer.ts';

const worker = {
  id: 'w',
  projectId: 'p',
  name: 'Task',
  goal: 'Inspect',
  checks: [],
  mode: 'handoff',
  state: 'idle',
  queue: [],
  cursor: 0,
  runId: 'run',
  iteration: 0,
  maxIterations: 10,
  maxMinutes: 30,
  startedAt: 0,
  autoCommands: false,
  observations: [],
  repeatCount: 0,
  createdAt: 0,
};

test('original index runtime exports remain available alongside schemas', () => {
  for (const name of [
    'APP_VERSION',
    'VERSION',
    'MAX_FRAME',
    'MAX_TEXT',
    'EXTENSION_ID',
    'EXTENSION_ORIGIN',
    'NATIVE_HOST_NAME',
    'object',
    'text',
    'integer',
    'only',
    'id',
    'parseAction',
    'parseCheck',
    'parseChecks',
    'parseEnvelopeWith',
    'parseEnvelope',
    'parseRequest',
  ]) {
    assert.ok(Object.hasOwn(protocol, name), name);
  }

  assert.equal(protocol.APP_VERSION, '1.0.0-rc.21');
});

test('the public index exposes the same canonical RPC API and schemas', () => {
  for (const [name, value] of Object.entries(rpc)) {
    assert.equal(Reflect.get(protocol, name), value, name);
  }

  const source = protocol.parseRpcResult(protocol.coreRpcRegistry, 'worker.read', {
    content: '\ufeffliteral\r\n😀',
    hash: 'a'.repeat(64),
  });

  assert.equal(source.content, '\ufeffliteral\r\n😀');
});

test('exported serialized schemas and object fields have meaningful descriptions', () => {
  const schemas = [
    protocol.actionSchema,
    protocol.checkSchema,
    protocol.checksSchema,
    protocol.envelopeSchema,
    protocol.requestSchema,
    protocol.responseSchema,
    protocol.workerStateSchema,
    protocol.profileSchema,
    protocol.projectSchema,
    protocol.approvalSchema,
    protocol.taskBoundarySchema,
    protocol.taskControlSchema,
    protocol.completionRecordSchema,
    protocol.workerSchema,
    protocol.activitySchema,
    protocol.bridgeProgressSummarySchema,
    protocol.snapshotSchema,
    protocol.settingsSchema,
    proposalEnvelopeSchema,
    codeSelectionSchema,
    followupSchema,
    followupSummarySchema,
    followupRequestSchema,
    replyIssueSchema,
    rewriteRequestSchema,
    taskBriefSchema,
    nativeFragmentSchema,
  ];

  function check(schema) {
    assert.ok(schema instanceof z.ZodType);
    assert.ok(schema.description?.trim(), schema.constructor.name);

    if (schema instanceof z.ZodObject) {
      for (const [name, field] of Object.entries(schema.shape)) {
        assert.ok(field.description?.trim(), name);
      }
    }

    if (schema instanceof z.ZodUnion) {
      for (const option of schema.options) {
        check(option);
      }
    }
  }

  for (const schema of schemas) {
    check(schema);
  }
});

test('task boundaries require an exact run ID and a nonnegative integer epoch without defaults', () => {
  for (const boundary of [
    { runId: '', epoch: 0 },
    { runId: 'run_1', epoch: 2 },
  ]) {
    assert.deepEqual(protocol.taskBoundarySchema.parse(boundary), boundary);
  }
  for (const boundary of [
    undefined,
    null,
    {},
    { runId: 'run_1' },
    { epoch: 0 },
    { runId: 1, epoch: 0 },
    { runId: 'run_1', epoch: '0' },
    { runId: 'run_1', epoch: -1 },
    { runId: 'run_1', epoch: 0.5 },
    { runId: 'run_1', epoch: Number.MAX_SAFE_INTEGER + 1 },
    { runId: 'run_1', epoch: 0, extra: true },
  ]) {
    assert.equal(protocol.taskBoundarySchema.safeParse(boundary).success, false);
  }
});

test('worker/snapshot schemas keep optional legacy records absent without new defaults', () => {
  const parsed = protocol.workerSchema.parse(worker);
  assert.deepEqual(parsed, worker);

  for (const name of ['completion', 'control', 'followups', 'pending', 'worktree', 'teamPaused']) {
    assert.equal(Object.hasOwn(parsed, name), false, name);
  }

  const snapshot = {
    protocol: protocol.VERSION,
    projects: [],
    workers: [worker],
    events: [],
    settings: {
      coderModelPath: '',
      contextSize: 8192,
      maxTokens: 2048,
      gpu: 'auto',
    },
    runtime: { node: 'ready', workflow: 'ready', models: 'ready' },
  };
  assert.deepEqual(protocol.snapshotSchema.parse(snapshot), snapshot);
  assert.equal(Object.hasOwn(protocol.snapshotSchema.parse(snapshot), 'bridgeProgress'), false);
  assert.equal(protocol.workerSchema.safeParse({ ...worker, unsupported: true }).success, false);
});

test('follow-up summaries compose into workers without loading request parsers or bridge modules', () => {
  const followup = {
    id: 'f',
    instruction: 'Continue',
    status: 'queued',
    createdAt: 1,
  };
  const parsed = protocol.workerSchema.parse({
    ...worker,
    followups: [followup],
  });
  assert.deepEqual(parsed.followups, [followup]);
  assert.equal(
    protocol.workerSchema.safeParse({
      ...worker,
      followups: [{ ...followup, status: 'other' }],
    }).success,
    false,
  );
});

test('referenced edits retain executable field validation and strict keys without accepting hashes', () => {
  const base = 'r_' + 'a'.repeat(16);
  const write = { type: 'write', path: '  a.ts  ', content: '  exact\n', base };
  const replace = { type: 'replace', path: 'a.ts', before: 'x', after: '', base };

  for (const edit of [write, replace]) {
    assert.deepEqual(referencedEditSchema.parse(edit), edit);
    assert.equal(referencedEditSchema.safeParse({ ...edit, expectedHash: 'a'.repeat(64) }).success, false);
    assert.equal(referencedEditSchema.safeParse({ ...edit, path: '' }).success, false);
    assert.equal(referencedEditSchema.safeParse({ ...edit, path: 'x'.repeat(1001) }).success, false);
    assert.equal(referencedEditSchema.safeParse({ ...edit, extra: true }).success, false);
  }

  assert.equal(
    referencedEditSchema.safeParse({ ...write, content: 'x'.repeat(protocol.MAX_TEXT) }).success,
    true,
  );
  assert.equal(
    referencedEditSchema.safeParse({ ...write, content: 'x'.repeat(protocol.MAX_TEXT + 1) }).success,
    false,
  );
  assert.equal(referencedEditSchema.safeParse({ ...write, content: '\u0000' }).success, false);
  assert.equal(referencedEditSchema.safeParse({ ...write, base: 'missing' }).success, true);
  assert.equal(referencedEditSchema.safeParse({ ...replace, base: 'missing' }).success, false);
  assert.equal(referencedEditSchema.safeParse({ ...replace, before: '' }).success, false);
  assert.equal(referencedEditSchema.safeParse({ ...replace, after: '\u0000' }).success, false);
});

test('strict proposal schema and executable schema remain distinct', () => {
  const proposal = {
    protocol: protocol.VERSION,
    id: 'batch',
    workerId: 'w',
    projectId: 'p',
    summary: 'Edit',
    actions: [{ type: 'write', path: 'a', content: '', base: 'r_' + 'a'.repeat(16) }],
  };
  assert.ok(proposalEnvelopeSchema.safeParse(proposal).success);
  assert.equal(protocol.envelopeSchema.safeParse(proposal).success, false);
  assert.equal(
    proposalEnvelopeSchema.safeParse({
      ...proposal,
      actions: [{ type: 'finish', summary: 'done' }, { type: 'diff' }],
    }).success,
    false,
  );
  assert.equal(proposalEnvelopeSchema.safeParse({ ...proposal, extra: true }).success, false);
});
