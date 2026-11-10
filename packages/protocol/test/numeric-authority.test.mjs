import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { VERSION } from '../src/constants.ts';
import { parseSchema } from '../src/helpers.ts';
import {
  activitySchema,
  approvalSchema,
  bridgeProgressSummarySchema,
  completionRecordSchema,
  profileSchema,
  projectSchema,
  snapshotSchema,
  taskBoundarySchema,
  taskControlSchema,
  workerSchema,
} from '../src/schemas/domain.ts';
import { followupSchema, followupSummarySchema } from '../src/schemas/requests.ts';

const profile = {
  id: 'check',
  label: 'Check',
  program: 'node',
  args: ['--check', 'a.js'],
  timeoutMs: 120000,
};
const project = { id: 'project', name: 'Project', root: '/project', profiles: [profile], revision: 0 };
const approval = {
  token: 'approval',
  fingerprint: 'exact',
  action: { type: 'diff' },
  reason: 'Review',
  revision: 0,
};
const control = {
  version: 1,
  epoch: 0,
  mode: 'stopped',
  at: 0,
  operationId: 'stop',
  reason: 'Stopped',
  retiredExchanges: [],
};
const completion = { version: 1, verification: 'passed', summary: 'Checked', checked: 0, at: 0 };
const worker = {
  id: 'worker',
  projectId: 'project',
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
const activity = { id: 0, workerId: 'worker', time: 0, kind: 'created', message: 'Created' };
const bridgeProgress = {
  workerId: 'worker',
  turns: 0,
  maxTurns: 15,
  lowerBound: false,
  activeMs: 0,
  maxMinutes: 30,
  startedAt: 0,
  phase: 'stopped',
  reason: 'Paused',
};
const followup = {
  id: 'followup',
  workerId: 'worker',
  instruction: 'Continue',
  status: 'queued',
  createdAt: 0,
  baseRunId: 'run',
  autoStart: false,
};
const followupSummary = { id: 'followup', instruction: 'Continue', status: 'queued', createdAt: 0 };
const snapshot = {
  protocol: VERSION,
  projects: [project],
  workers: [worker],
  events: [activity],
  settings: { coderModelPath: '', contextSize: 8192, maxTokens: 2048, gpu: 'auto' },
  runtime: { node: 'ready', workflow: 'ready', models: 'ready' },
};

const invalidNumbers = [
  -1,
  0.5,
  Number.MAX_SAFE_INTEGER + 1,
  NaN,
  Infinity,
  -Infinity,
  '1',
  null,
  false,
  {},
  [],
];
const nonnegativeRecords = [
  ['project', projectSchema, project, ['revision']],
  ['approval', approvalSchema, approval, ['revision']],
  ['task boundary', taskBoundarySchema, { runId: 'run', epoch: 0 }, ['epoch']],
  ['task control', taskControlSchema, control, ['epoch', 'at']],
  ['completion', completionRecordSchema, completion, ['checked', 'at']],
  ['worker', workerSchema, worker, ['cursor', 'iteration', 'startedAt', 'repeatCount', 'createdAt']],
  ['activity', activitySchema, activity, ['id', 'time']],
  ['bridge progress', bridgeProgressSummarySchema, bridgeProgress, ['turns', 'activeMs', 'startedAt']],
  ['follow-up', followupSchema, followup, ['createdAt', 'activatedAt', 'finishedAt']],
  ['follow-up summary', followupSummarySchema, followupSummary, ['createdAt']],
];

for (const [name, schema, saved, fields] of nonnegativeRecords) {
  for (const field of fields) {
    test(
      name +
        '.' +
        field +
        ' preserves safe nonnegative integers and rejects corrupt authority before effects',
      () => {
        for (const number of [0, 1, Number.MAX_SAFE_INTEGER]) {
          const value = { ...saved, [field]: number };
          assert.deepEqual(schema.parse(value), value);
        }
        for (const number of invalidNumbers) {
          const effects = [];
          assert.throws(
            () => {
              const value = parseSchema(schema, { ...saved, [field]: number });
              effects.push(value);
            },
            (error) => {
              assert.ok(error.cause instanceof z.ZodError);
              assert.deepEqual(error.cause.issues[0].path, [field]);
              return true;
            },
          );
          assert.deepEqual(effects, []);
        }
      },
    );
  }
}

for (const [name, schema, saved, field, minimum, maximum] of [
  ['command profile', profileSchema, profile, 'timeoutMs', 1000, 600000],
  ['worker', workerSchema, worker, 'maxIterations', 1, Number.MAX_SAFE_INTEGER],
  ['worker', workerSchema, worker, 'maxMinutes', 1, 240],
  ['bridge progress', bridgeProgressSummarySchema, bridgeProgress, 'maxTurns', 1, 100000],
  ['bridge progress', bridgeProgressSummarySchema, bridgeProgress, 'maxMinutes', 1, 100000],
]) {
  test(name + '.' + field + ' requires a positive bounded integer without clamping or defaults', () => {
    for (const number of [minimum, maximum]) {
      const value = { ...saved, [field]: number };
      assert.deepEqual(schema.parse(value), value);
    }
    for (const number of [...invalidNumbers, undefined, 0, minimum - 1, maximum + 1]) {
      const effects = [];
      assert.throws(
        () => {
          const value = parseSchema(schema, { ...saved, [field]: number });
          effects.push(value);
        },
        (error) => {
          assert.ok(error.cause instanceof z.ZodError);
          assert.deepEqual(error.cause.issues[0].path, [field]);
          return true;
        },
      );
      assert.deepEqual(effects, []);
    }
  });
}

test('saved limits retain legitimate extensions beyond initial creation budgets', () => {
  const extendedWorker = { ...worker, iteration: 100, maxIterations: 108, maxMinutes: 240 };
  const extendedBridge = { ...bridgeProgress, turns: 100, maxTurns: 115, maxMinutes: 300 };
  assert.deepEqual(workerSchema.parse(extendedWorker), extendedWorker);
  assert.deepEqual(bridgeProgressSummarySchema.parse(extendedBridge), extendedBridge);
});

test('legacy zero timestamps and absent optional control, completion and follow-up times remain unchanged', () => {
  assert.deepEqual(workerSchema.parse(worker), worker);
  assert.deepEqual(followupSchema.parse(followup), followup);
  assert.deepEqual(snapshotSchema.parse(snapshot), snapshot);
  for (const autoStart of [true, false]) {
    const saved = { ...followup, autoStart };
    assert.deepEqual(followupSchema.parse(saved), saved);
  }
  for (const autoStart of [undefined, null, 'false', 0, {}]) {
    assert.equal(followupSchema.safeParse({ ...followup, autoStart }).success, false);
  }
});

test('nested snapshot authority is rejected before a parsed snapshot can be published', async (context) => {
  for (const [name, value, expectedPath] of [
    [
      'project revision',
      { ...snapshot, projects: [{ ...project, revision: 0.5 }] },
      ['projects', 0, 'revision'],
    ],
    [
      'worker cursor',
      { ...snapshot, workers: [{ ...worker, cursor: Number.MAX_SAFE_INTEGER + 1 }] },
      ['workers', 0, 'cursor'],
    ],
    [
      'control epoch',
      { ...snapshot, workers: [{ ...worker, control: { ...control, epoch: -1 } }] },
      ['workers', 0, 'control', 'epoch'],
    ],
    [
      'approval revision',
      { ...snapshot, workers: [{ ...worker, pending: { ...approval, revision: 0.5 } }] },
      ['workers', 0, 'pending', 'revision'],
    ],
    [
      'follow-up time',
      { ...snapshot, workers: [{ ...worker, followups: [{ ...followupSummary, createdAt: -1 }] }] },
      ['workers', 0, 'followups', 0, 'createdAt'],
    ],
    ['activity time', { ...snapshot, events: [{ ...activity, time: -1 }] }, ['events', 0, 'time']],
    [
      'bridge limit',
      { ...snapshot, bridgeProgress: [{ ...bridgeProgress, maxMinutes: 0 }] },
      ['bridgeProgress', 0, 'maxMinutes'],
    ],
  ]) {
    await context.test(name, () => {
      const published = [];
      assert.throws(
        () => {
          const parsed = parseSchema(snapshotSchema, value);
          published.push(parsed);
        },
        (error) => {
          assert.ok(error.cause instanceof z.ZodError);
          assert.deepEqual(error.cause.issues[0].path, expectedPath);
          return true;
        },
      );
      assert.deepEqual(published, []);
    });
  }
});
