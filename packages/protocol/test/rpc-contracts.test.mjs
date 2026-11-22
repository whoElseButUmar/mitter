import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseSync, Visitor } from 'rolldown/utils';
import { z, ZodError } from 'zod';
import {
  coreRpcRegistry,
  createRpcRegistry,
  isRpcMethod,
  parseRpcParams,
  parseRpcResult,
  RpcResultValidationError,
  assetChunkSchema,
  changedFilesSchema,
  fileReviewSchema,
  fileTextSchema,
  folderPickerResultSchema,
  healthSchema,
  historyResultSchema,
  stateBackupSchema,
  teamSchema,
} from '../src/rpc.js';
import { DEFAULT_SETTINGS } from '../src/model-settings.js';
import { followupRequestSchema } from '../src/requests.js';

const progressSchema = z
  .literal('owner-progress')
  .describe('A synthetic feature-owned progress contract for composition tests.');
const loadSchema = z
  .literal('owner-load')
  .describe('A synthetic feature-owned progress-load contract for composition tests.');
const registry = createRpcRegistry({
  progressInput: progressSchema,
  progressResult: progressSchema,
  progressLoadResult: loadSchema,
});
const hash = 'a'.repeat(64);
const task = { workerId: 'worker_1' };
const projectRequest = { projectId: 'project_1' };
const followupRequest = { id: 'followup_1', instruction: 'Keep existing work.', autoStart: false };
const profile = {
  id: 'check_1',
  label: 'Check',
  program: '/usr/bin/node',
  args: ['check.cjs'],
  timeoutMs: 5000,
};
const project = { id: 'project_1', name: 'Project', root: '/project', profiles: [profile], revision: 1 };
const worker = {
  id: 'worker_1',
  projectId: project.id,
  name: 'Task',
  goal: 'Keep existing work.',
  checks: [],
  mode: 'handoff',
  state: 'idle',
  queue: [],
  cursor: 0,
  runId: 'run_1',
  iteration: 0,
  maxIterations: 8,
  maxMinutes: 15,
  startedAt: 0,
  autoCommands: false,
  observations: [],
  repeatCount: 0,
  createdAt: 1,
};
const backup = {
  format: 'miter-state-backup/1',
  id: 'state-20261011T123456789Z-12345678-1234-4123-8123-123456789abc',
  createdAt: 1,
  appVersion: '1.0.0-rc.27',
  schemaVersion: 1,
  reason: 'manual',
  bytes: 4096,
  sha256: hash,
};
const activity = { id: 2, workerId: worker.id, time: 1, kind: 'user', message: 'Kept.' };
const history = { events: [activity], hasMore: true, before: 2 };
const source = { content: '\ufeffliteral\r\n界 $&  ', hash };
const review = {
  path: 'file.txt',
  beforeHash: 'missing',
  afterHash: hash,
  currentHash: hash,
  conflict: false,
  status: 'applied',
  kind: 'created',
  diff: {
    lines: [{ kind: 'add', text: '\ufeffliteral\r', newLine: 1 }],
    additions: 1,
    deletions: 0,
    truncated: false,
    simplified: false,
  },
  canRestore: true,
  warning: 'Retained warning.',
};
const team = {
  peers: [{ id: 'worker_2', name: 'Peer', state: 'paused', branch: 'task/peer', held: 'Waiting for Task.' }],
  messages: [
    {
      id: 'message_1',
      projectId: project.id,
      from: worker.id,
      to: 'worker_2',
      message: 'Context.',
      time: 1,
      kind: 'message',
    },
  ],
};
const health = {
  version: '1.0.0-rc.27',
  protocol: 'mitter/1',
  node: 'v26.0.0',
  platform: 'darwin',
  architecture: 'arm64',
  workflow: 'xstate',
  database: { ok: true, schema: 1, bytes: 4096 },
  tasks: { total: 1, active: 0, finished: 0, stopped: 1 },
  attention: [{ id: worker.id, name: worker.name, state: 'paused', reason: 'Stopped.' }],
  backups: [backup],
  dataDirectory: '/private/state',
  limits: { savedProjects: 50, savedTasks: 200, previewBytes: 25165824 },
  notice: 'Private state only.',
};
const followup = {
  ...followupRequest,
  workerId: worker.id,
  status: 'queued',
  createdAt: 1,
  baseRunId: worker.runId,
  selection: { path: 'file.txt', hash, start: 0, end: 2, text: '界\r' },
  activatedAt: 2,
  finishedAt: 3,
  error: 'Retained detail.',
};
const rollback = { restored: 1, warning: 'Command side effects were not reversed.' };
const control = { stopped: true, ready: false, epoch: 1, operationId: 'stop_1' };
const readPath = { ...task, path: 'file.txt' };
const workflow = { id: 'flow_1', name: 'Create a card', verifyAfterRestart: true };
const workflowTarget = { ...projectRequest, id: workflow.id };
const workflowState = { recording: false, workflows: [workflow] };
const fixtures = {
  'workflow.list': [projectRequest, workflowState],
  'workflow.record': [projectRequest, { ...workflowState, recording: true }],
  'workflow.expect': [projectRequest, { ...workflowState, recording: true }],
  'workflow.save': [{ ...projectRequest, name: workflow.name, verifyAfterRestart: true }, workflowState],
  'workflow.cancel': [projectRequest, workflowState],
  'workflow.replay': [
    workflowTarget,
    { recording: false, workflows: [{ ...workflow, lastResult: { ok: true, detail: 'Passed.' } }] },
  ],
  'workflow.delete': [workflowTarget, { recording: false, workflows: [] }],
  state: [
    {},
    {
      protocol: 'mitter/1',
      projects: [project],
      workers: [worker],
      events: [activity],
      settings: DEFAULT_SETTINGS,
      runtime: { version: '1.0.0-rc.27', node: 'v26.0.0', workflow: 'xstate', models: 'Not loaded' },
    },
  ],
  'system.health': [{}, health],
  'project.appRuns': [projectRequest, { runs: [] }],
  'worker.previewStatus': [task, { preview: null }],
  'worker.previewStart': [
    task,
    {
      previewId: 'b'.repeat(32),
      url: 'http://miter-' + 'a'.repeat(32) + '.localhost:45000/' + 'b'.repeat(32) + '/index.html',
      files: 3,
      bytes: 2048,
      idleTimeoutMs: 1800000,
      detail: 'Temporary static preview only.',
    },
  ],
  'worker.previewStop': [{ ...task, previewId: 'b'.repeat(32) }, { stopped: true }],
  'system.readiness': [
    {},
    {
      version: 1,
      node: 'v26.0.0',
      platform: 'darwin',
      architecture: 'arm64',
      webChecks: { status: 'ready', detail: 'Required checks are available.' },
      checks: {
        source: { status: 'ready', detail: 'Source checking is available.' },
        domain: { status: 'ready', detail: 'Runtime prerequisites are available.' },
        browser: { status: 'unavailable', detail: 'Rendered browser verification is not provided.' },
      },
      notice: 'Prerequisites only; no tests ran.',
    },
  ],
  'system.backups': [{}, [backup]],
  'system.backup': [{}, backup],
  'system.verifyBackup': [{ id: backup.id }, backup],
  'project.pickFolder': [{}, { root: '/project', cancelled: false }],
  'project.reveal': [projectRequest, { opened: true }],
  'project.read': [{ ...projectRequest, path: 'file.txt' }, source],
  'project.context': [
    { ...projectRequest, save: true, mission: 'Goal', conventions: 'Rules' },
    { mission: 'Goal', conventions: 'Rules' },
  ],
  'project.rename': [{ ...projectRequest, name: 'Renamed' }, project],
  'project.add': [{ root: project.root, name: project.name }, project],
  'project.create': [{ parentRoot: '/projects', folderName: 'New project', name: project.name }, project],
  'project.profile': [{ ...projectRequest, profile }, project],
  'worker.create': [{ ...projectRequest, mode: 'handoff', goal: worker.goal }, worker],
  'settings.update': [{ settings: {} }, DEFAULT_SETTINGS],
  'worker.steerValidate': [
    { ...task, request: followupRequest },
    { valid: true, alreadyApplied: false },
  ],
  'worker.stop': [{ ...task, id: control.operationId }, control],
  'worker.steer': [
    { ...task, request: followupRequest },
    { ...control, stopped: false, ready: true, operationId: followupRequest.id },
  ],
  'worker.continueFresh': [task, { ready: true, epoch: 1 }],
  'worker.reveal': [task, { opened: true }],
  'worker.read': [readPath, source],
  'worker.browse': [task, { root: '/project', files: ['file.txt'] }],
  'worker.asset': [
    readPath,
    { path: 'file.txt', mime: 'text/plain', size: 2, offset: 0, stamp: hash, data: 'YQ0=', eof: true },
  ],
  'worker.openFile': [{ ...readPath, application: 'vscode' }, { opened: true }],
  'worker.followups': [task, [followup]],
  'worker.followup': [{ ...task, request: followupRequest }, followup],
  'worker.followupCancel': [{ ...task, id: followup.id }, { cancelled: true }],
  'worker.followupActivate': [task, { activated: true, id: followup.id }],
  'worker.team': [task, team],
  'worker.teamMessage': [
    { ...task, id: 'message_1', message: 'Context.', to: 'worker_2' },
    { ok: true, note: 'Saved.' },
  ],
  'worker.bridgeLoad': [task, 'owner-load'],
  'worker.bridgeSave': [{ ...task, progress: 'owner-progress' }, 'owner-progress'],
  'worker.bridgeExtend': [{ ...task, confirm: true }, 'owner-progress'],
  'worker.rename': [{ ...task, name: 'Renamed' }, worker],
  'worker.prompt': [task, '\ufeffliteral prompt\r\n'],
  'worker.history': [{ ...task, before: 3 }, history],
  'worker.report': [task, '\ufeffliteral report\r\n'],
  'worker.handoffSeen': [{ ...task, envelopeId: 'envelope_1' }, { seen: true }],
  'worker.change': [readPath, review],
  'worker.syntax': [
    readPath,
    { path: 'file.txt', hash, ok: true, code: 0, details: 'Parsed.', scope: 'Syntax only.' },
  ],
  'worker.restoreFile': [{ ...readPath, expectedHash: hash, confirm: true }, rollback],
  'worker.files': [task, [{ path: 'file.txt', status: 'applied', bytes: 12 }]],
  'worker.validateReply': [{ ...task, text: ' {"literal":"\\r\\n界"} ' }, { valid: true }],
  'worker.import': [
    { ...task, text: ' {"literal":"\\r\\n界"} ', reconcile: true },
    { queued: true, acknowledged: true },
  ],
  'worker.run': [
    { ...task, envelopeId: 'envelope_1', envelopeHash: hash },
    { started: true, acknowledged: true, state: 'paused' },
  ],
  'worker.resume': [task, { started: true }],
  'worker.pause': [task, { stopping: false, completed: true }],
  'worker.cancel': [task, { stopping: true }],
  'worker.approve': [{ ...task, token: 'approval_1', approve: true, trustRun: false }, { approved: true }],
  'worker.setupDecision': [
    { ...task, expectedRun: { runId: 'run_1', epoch: 0 }, token: 'approval_1', decision: 'manual' },
    { accepted: true, sessionId: 'session_1' },
  ],
  'worker.skip': [{ ...task, confirm: true }, { skipped: true }],
  'worker.rollback': [{ ...task, confirm: true }, rollback],
  'worker.accept': [
    { ...task, confirm: true },
    { accepted: false, alreadyComplete: true },
  ],
};

function schemaError(error) {
  assert.ok(error.cause instanceof ZodError);
  return true;
}

function describedFields(schema, label) {
  assert.equal(typeof schema.description, 'string', label);

  if (schema.shape) {
    for (const [name, field] of Object.entries(schema.shape)) {
      describedFields(field, label + '.' + name);
    }
  }

  if (schema.element) {
    describedFields(schema.element, label + '[]');
  }

  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    for (const option of schema.options) {
      describedFields(option, label + '.variant');
    }
  }
}

test('the composed registry exactly covers every Service handler operation', async () => {
  const source = await readFile(new URL('../../../apps/host/src/core/service.ts', import.meta.url), 'utf8');
  const parsed = parseSync('service.ts', source);
  assert.deepEqual(parsed.errors, []);
  const handled = new Set();
  let handler;

  new Visitor({
    MethodDefinition(node) {
      if (node.key.type === 'Identifier' && node.key.name === 'receive') {
        handler = node.value.body;
      }
    },
  }).visit(parsed.program);
  assert.ok(handler, 'Service.receive is the result-validated handler boundary.');

  new Visitor({
    SwitchCase(node) {
      if (node.test?.type === 'Literal' && typeof node.test.value === 'string') {
        handled.add(node.test.value);
      }
    },
    BinaryExpression(node) {
      if (
        node.operator === '===' &&
        node.left.type === 'Identifier' &&
        node.left.name === 'method' &&
        node.right.type === 'Literal' &&
        typeof node.right.value === 'string'
      ) {
        handled.add(node.right.value);
      }
    },
  }).visit(handler);
  assert.ok(handled.size > 40);
  assert.deepEqual(Object.keys(registry).sort(), [...handled].sort());
  assert.deepEqual(Object.keys(fixtures).sort(), [...handled].sort());
});

test('every registered operation validates a real request and complete result, and rejects malformed containers/results', () => {
  for (const [method, [params, result]] of Object.entries(fixtures)) {
    assert.equal(isRpcMethod(registry, method), true, method);
    assert.doesNotThrow(() => parseRpcParams(registry, method, params), method);
    assert.deepEqual(parseRpcResult(registry, method, result), result, method);
    assert.throws(() => parseRpcParams(registry, method, []), /Expected params/, method);
    assert.throws(() => parseRpcResult(registry, method, null), schemaError, method);
  }

  for (const method of ['__proto__', 'toString', 'worker.futureOperation']) {
    assert.equal(isRpcMethod(registry, method), false);
    assert.throws(() => parseRpcParams(registry, method, {}), /Unknown request method/);
    assert.throws(() => parseRpcResult(registry, method, {}), /Unknown request method/);
  }
});

test('RPC-owned schemas and request/result fields are described rather than unknown projections', () => {
  for (const [method, entry] of Object.entries(registry)) {
    describedFields(entry.params, method + '.params');
    describedFields(entry.result, method + '.result');
  }
});

test('full review, files, team, health, backup, history and picker contracts retain every valid host field', () => {
  for (const [schema, value] of [
    [fileReviewSchema, review],
    [changedFilesSchema, fixtures['worker.files'][1]],
    [teamSchema, team],
    [healthSchema, health],
    [stateBackupSchema, backup],
    [historyResultSchema, history],
    [folderPickerResultSchema, { root: '/project', cancelled: false }],
    [fileTextSchema, source],
    [assetChunkSchema, fixtures['worker.asset'][1]],
  ]) {
    assert.deepEqual(schema.parse(value), value);
  }

  assert.equal(fileReviewSchema.safeParse({ ...review, beforeHash: undefined }).success, false);
  assert.equal(fileReviewSchema.safeParse({ ...review, currentHash: 'display-only' }).success, false);
  assert.equal(changedFilesSchema.safeParse([{ path: 'file.txt', status: 'applied' }]).success, false);
  assert.equal(healthSchema.safeParse({ ...health, database: { ok: true } }).success, false);
  assert.equal(teamSchema.safeParse({ peers: [{ id: 'worker_2' }], messages: [] }).success, false);
  assert.equal(folderPickerResultSchema.safeParse({ cancelled: false }).success, false);
  assert.equal(folderPickerResultSchema.safeParse({ cancelled: true, root: '/fabricated' }).success, false);
  assert.deepEqual(folderPickerResultSchema.parse({ cancelled: true }), { cancelled: true });
});

test('malformed genuine request fields reject, including previously uncovered reads/context/team messages', () => {
  for (const [method, changed] of [
    ['project.read', { path: null }],
    ['project.context', { save: 'true' }],
    ['project.context', { conventions: 12 }],
    ['worker.read', { path: {} }],
    ['worker.teamMessage', { to: null }],
    ['worker.teamMessage', { message: false }],
    ['worker.import', { reconcile: 'true' }],
    ['worker.run', { envelopeHash: undefined }],
    ['worker.approve', { approve: 'false' }],
    ['worker.approve', { trustRun: 'true' }],
    ['worker.restoreFile', { expectedHash: 'missing' }],
    ['worker.stop', { id: '../stop' }],
    ['worker.followupCancel', { id: 0 }],
    ['worker.history', { before: 0 }],
    ['worker.skip', { confirm: 'true' }],
    ['worker.rollback', { confirm: false }],
    ['worker.accept', { confirm: null }],
    ['system.verifyBackup', { id: '../state' }],
  ]) {
    assert.throws(
      () => parseRpcParams(registry, method, { ...fixtures[method][0], ...changed }),
      schemaError,
      method,
    );
  }

  assert.throws(
    () => parseRpcParams(registry, 'worker.run', { ...task, envelopeHash: hash }),
    /requires its envelope ID and exact hash/,
  );
  assert.throws(
    () => parseRpcParams(registry, 'worker.import', { ...task, text: '界'.repeat(140000) }),
    /too large/,
  );
  assert.throws(
    () => parseRpcParams(registry, 'settings.update', { settings: { extra: true } }),
    schemaError,
  );
  assert.throws(
    () => parseRpcParams(registry, 'settings.update', { settings: { contextSize: 2048, maxTokens: 4096 } }),
    /smaller than context/,
  );
});

test('receipt variants reject ambiguous or fabricated mutation acknowledgements instead of normalizing them', () => {
  for (const [method, result] of [
    ['worker.import', { queued: false }],
    ['worker.import', { queued: true, acknowledged: false }],
    ['worker.run', { started: false }],
    ['worker.run', { started: true, acknowledged: true }],
    ['worker.resume', { started: 'true' }],
    ['worker.pause', { stopping: true, completed: true }],
    ['worker.pause', { stopping: false, completed: true, review: true }],
    ['worker.cancel', { stopping: 0 }],
    ['worker.approve', { approved: true, denied: true }],
    ['worker.skip', { skipped: false }],
    ['worker.rollback', { restored: -1, warning: 'No.' }],
    ['worker.accept', { accepted: false }],
    ['worker.stop', { ...control, ready: true }],
    ['worker.steer', control],
    ['worker.continueFresh', { ready: false, epoch: 1 }],
    ['worker.followupCancel', { cancelled: false }],
    ['worker.followupActivate', { activated: true }],
  ]) {
    assert.throws(
      () => parseRpcResult(registry, method, result),
      (error) => {
        assert.ok(error instanceof RpcResultValidationError, method);
        assert.equal(error.code, 'RPC_RESULT_INVALID');
        assert.equal(error.retryable, false);
        assert.match(error.message, /may already have completed.*Check saved state before repeating/);
        return schemaError(error);
      },
    );
  }

  for (const result of [
    { stopping: true },
    { stopping: false, completed: true },
    { stopping: false, review: true },
  ]) {
    assert.deepEqual(parseRpcResult(registry, 'worker.pause', result), result);
  }

  const issue = {
    stage: 'precondition',
    code: 'READ_BASE_UNKNOWN',
    message: 'Read again.',
    field: 'base',
    actionIndex: 0,
  };
  assert.deepEqual(parseRpcResult(registry, 'worker.validateReply', { valid: false, issue }), {
    valid: false,
    issue,
  });
  assert.throws(() => parseRpcResult(registry, 'worker.validateReply', { valid: false }), schemaError);
  assert.throws(() => parseRpcResult(registry, 'worker.validateReply', { valid: true, issue }), schemaError);
});

test('feature schemas are explicitly composed and nested owner defaults/constraints are not locally duplicated', () => {
  assert.equal(registry['worker.bridgeLoad'].result, loadSchema);
  assert.equal(registry['worker.bridgeSave'].result, progressSchema);
  assert.equal(registry['worker.bridgeExtend'].result, progressSchema);
  assert.equal(Object.hasOwn(coreRpcRegistry, 'worker.bridgeSave'), false);
  assert.throws(() => parseRpcParams(registry, 'worker.bridgeSave', { ...task, progress: {} }), schemaError);

  for (const autoStart of [undefined, false, true, null, 0, 'false']) {
    const request = { ...followupRequest, autoStart };
    const owned = followupRequestSchema.safeParse(request);
    const composed = registry['worker.followup'].params.safeParse({ ...task, request });
    assert.equal(composed.success, owned.success);

    if (owned.success && composed.success) {
      assert.deepEqual(composed.data.request, owned.data);
    }
  }
});

test('creation and settings retain nullish defaults and suggested names without imposing creation limits on saved budgets', () => {
  const input = {
    ...projectRequest,
    mode: 'handoff',
    goal: worker.goal,
    name: ' '.repeat(100),
    checks: null,
    maxIterations: null,
    maxMinutes: null,
  };
  const creation = parseRpcParams(registry, 'worker.create', input);
  assert.equal(creation.name, input.name);
  assert.deepEqual(creation.checks, []);
  assert.equal(creation.maxIterations, 8);
  assert.equal(creation.maxMinutes, 15);
  assert.deepEqual(
    parseRpcParams(registry, 'settings.update', {
      settings: { coderModelPath: null, contextSize: null, maxTokens: null, gpu: null },
    }).settings,
    DEFAULT_SETTINGS,
  );
  assert.deepEqual(parseRpcResult(registry, 'worker.create', { ...worker, maxIterations: 108 }), {
    ...worker,
    maxIterations: 108,
  });
});

test('literal source, handoff text, selection offsets, receipts and reviewed run boundaries are not rewritten', () => {
  const text = '\ufeff {"source":"\\r\\n界 $&  "}\r\n';
  const expectedRun = { runId: 'run_1', epoch: 4 };
  const params = { ...task, text, expectedRun, epoch: 4 };
  assert.deepEqual(parseRpcParams(registry, 'worker.import', params), params);
  assert.deepEqual(parseRpcResult(registry, 'worker.read', source), source);
  assert.deepEqual(parseRpcResult(registry, 'worker.stop', control), control);
  const selection = { path: 'file.txt', hash, start: 1, end: 4, text: '\r\n界' };
  const request = { ...followupRequest, selection };
  assert.deepEqual(
    parseRpcParams(registry, 'worker.steer', { ...task, request }).request.selection,
    selection,
  );

  for (const boundary of [
    { runId: 'run_1', epoch: -1 },
    { runId: 1, epoch: 0 },
    { runId: 'run_1', epoch: 0, extra: true },
  ]) {
    assert.throws(
      () => parseRpcParams(registry, 'worker.stop', { ...task, id: 'stop_1', expectedRun: boundary }),
      schemaError,
    );
  }
});
