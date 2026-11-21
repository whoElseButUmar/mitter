import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseTerminalArguments } from '../src/cli/arguments.ts';
import { runTaskCommand, readGoalFile } from '../src/cli/tasks.ts';
import { watchOutcome } from '../src/cli/watch.ts';
import { TerminalControlError } from '../src/core/terminal-control/client.ts';

const requestId = randomUUID();
const workerId = 'task-1';
const expectedRun = { runId: 'run-1', epoch: 1 };

function receipt(overrides = {}) {
  return {
    requestId,
    kind: 'start',
    state: 'queued',
    workerId,
    expectedRun,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function status(overrides = {}) {
  return {
    worker: {
      id: workerId,
      projectId: 'project-1',
      projectPath: '/projects/example',
      name: 'Example',
      goal: 'Build it',
      state: 'waiting_model',
      expectedRun,
      pendingApproval: false,
    },
    browserConnected: true,
    events: [],
    ...overrides,
  };
}

function harness(clientOverrides = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const controller = new AbortController();
  const client = {
    async start(params) {
      calls.push(['start', params]);
      return receipt();
    },
    async stop(params) {
      calls.push(['stop', params]);
      return receipt({ kind: 'stop' });
    },
    async resume(params) {
      calls.push(['resume', params]);
      return receipt({ kind: 'resume' });
    },
    async status(id) {
      calls.push(['status', id]);
      return status();
    },
    async operation(id) {
      calls.push(['operation', id]);
      return receipt();
    },
    async list() {
      calls.push(['list']);
      return { browserConnected: true, tasks: [] };
    },
    ...clientOverrides,
  };
  return {
    out,
    err,
    calls,
    controller,
    dependencies: {
      client,
      signal: controller.signal,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      wait: async () => {},
    },
  };
}

test('list identifies incompatible Chrome and native host versions in text and JSON', async () => {
  const mismatch = { extensionVersion: '1.0.0-rc.30', hostVersion: '1.0.0-rc.31' };
  const fixture = harness({
    list: async () => ({ browserConnected: false, browserVersionMismatch: mismatch, tasks: [] }),
  });
  assert.equal(await runTaskCommand(parseTerminalArguments(['list']), fixture.dependencies), 0);
  const message = fixture.err.at(-1);
  assert.ok(message.includes(mismatch.extensionVersion) && message.includes(mismatch.hostVersion));
  assert.match(message, /chrome:\/\/extensions/);
  assert.equal(await runTaskCommand(parseTerminalArguments(['list', '--json']), fixture.dependencies), 0);
  assert.deepEqual(JSON.parse(fixture.out.at(-1)).browserVersionMismatch, mismatch);
});

test('status leads with final web evidence and retains the earlier proposal in the machine record', async () => {
  const detail = 'All scored Lighthouse categories reached 100 on desktop and mobile.';
  const summary = 'The previous desktop run lacked scores. Retry verification.';
  const completion = { verification: 'passed', summary, evidence: { lighthouse: 'passed', detail } };
  const record = status();
  record.worker.state = 'complete';
  record.worker.completion = completion;
  const fixture = harness({ status: async () => record });
  assert.equal(await runTaskCommand(parseTerminalArguments(['status', workerId]), fixture.dependencies), 0);
  assert.match(fixture.out[1], /Final verification/);
  assert.equal(fixture.out.filter((line) => line.includes(detail)).length, 1);
  assert.ok(fixture.out.every((line) => !line.includes(summary)));
  assert.equal(
    await runTaskCommand(parseTerminalArguments(['status', workerId, '--json']), fixture.dependencies),
    0,
  );
  assert.deepEqual(JSON.parse(fixture.out.at(-1)).worker.completion, completion);
});

test('start arguments preserve the literal goal and reject malformed, duplicate and exclusive options', () => {
  const goal = '  Build `literal` $HOME\nKeep this newline.\n';
  const parsed = parseTerminalArguments(['task', 'start', '--project', '/tmp/project', '--goal', goal]);
  assert.equal(parsed.goal, goal);
  assert.equal(parsed.maxTurns, 20);
  assert.equal(parsed.maxMinutes, 60);
  for (const args of [
    ['start', '--project', 'relative', '--goal', 'x'],
    ['start', '--project', '/x', '--goal', 'x', '--goal-file', '/y'],
    ['start', '--project', '/x', '--goal', 'x', '--goal', 'y'],
    ['start', '--project', '/x', '--goal', 'x', '--watch', '--watch'],
    ['start', '--project', '/x', '--goal', 'x', '--max-turns', '2e1'],
    ['start', '--project', '/x', '--goal', 'x', '--max-turns', '21'],
    ['start', '--project', '/x', '--goal', 'x', '--max-minutes', '0'],
    ['start', '--project', '/x', '--goal', 'x', '--request-id', 'not-a-uuid'],
    ['start', '--project', '/x', '--goal', 'x', '--portable'],
    ['list', '--unknown'],
    ['status'],
    ['status', 'one', 'two'],
    ['bogus', '--help'],
  ]) {
    assert.throws(() => parseTerminalArguments(args), args.join(' '));
  }
});

test('legacy request keeps its default object and unknown maintenance flags do not become task commands', () => {
  assert.deepEqual(parseTerminalArguments(['--portable', 'request', 'state.get']), {
    command: 'legacy',
    operation: 'request',
    args: ['state.get', '{}'],
    portable: true,
  });
  assert.throws(() => parseTerminalArguments(['state', '--unknown']));
});

test('resume accepts a task, watch and request identity but no new-session or budget options', () => {
  assert.deepEqual(
    parseTerminalArguments(['resume', workerId, '--watch', '--json', '--request-id', requestId]),
    {
      command: 'resume',
      workerId,
      watch: true,
      json: true,
      requestId,
    },
  );
  for (const args of [
    ['resume'],
    ['resume', workerId, 'other-task'],
    ['resume', workerId, '--watch', '--watch'],
    ['resume', workerId, '--max-turns', '20'],
    ['resume', workerId, '--max-minutes', '60'],
    ['resume', workerId, '--new-chat'],
    ['resume', workerId, '--reset'],
    ['resume', workerId, '--goal', 'New goal'],
    ['resume', workerId, '--request-id', 'bad-id'],
  ]) {
    assert.throws(() => parseTerminalArguments(args));
  }
});

test('goal files preserve UTF-8 bytes, BOM and whitespace while rejecting invalid or oversized input', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'miter-goal-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'brief.txt');
  const goal = '\ufeff  Build café\n\n';
  await fs.writeFile(file, goal);
  assert.equal(await readGoalFile(file), goal);
  await fs.writeFile(file, Buffer.from([0xff]));
  await assert.rejects(readGoalFile(file), /valid UTF-8/);
  await fs.writeFile(file, 'x'.repeat(4001));
  await assert.rejects(readGoalFile(file), /4,000/);
  await assert.rejects(readGoalFile(directory), /Could not read/);
});

test('start publishes a durable receipt ID before dispatch and preserves goal and explicit budgets', async () => {
  const fixture = harness();
  fixture.dependencies.client.start = async (params) => {
    assert.match(fixture.err[0], new RegExp(requestId));
    assert.equal(params.goal, ' Goal\n');
    assert.equal(params.consent, true);
    assert.equal(params.maxTurns, 7);
    return receipt();
  };
  const code = await runTaskCommand(
    parseTerminalArguments([
      'start',
      '--project',
      '/tmp/app',
      '--goal',
      ' Goal\n',
      '--request-id',
      requestId,
      '--max-turns',
      '7',
      '--json',
    ]),
    fixture.dependencies,
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(fixture.out[0]).workerId, workerId);
  assert.equal(JSON.parse(fixture.out[0]).type, 'operation');
});

test('ambiguous start acknowledgement is not retried and points to its durable receipt', async () => {
  let starts = 0;
  const fixture = harness({
    async start() {
      starts++;
      throw new TerminalControlError('Acknowledgement lost.', 'unknown');
    },
  });
  const code = await runTaskCommand(
    parseTerminalArguments([
      'start',
      '--project',
      '/tmp/app',
      '--goal',
      'Build it',
      '--request-id',
      requestId,
    ]),
    fixture.dependencies,
  );
  assert.equal(code, 1);
  assert.equal(starts, 1);
  assert.match(fixture.err.join('\n'), new RegExp('miter operation ' + requestId));
  assert.match(fixture.err.join('\n'), /Do not start again with a new request ID/);
});

test('stop binds the request to the status run and epoch without direct runtime control', async () => {
  const fixture = harness();
  const code = await runTaskCommand(
    parseTerminalArguments(['stop', workerId, '--request-id', requestId]),
    fixture.dependencies,
  );
  assert.equal(code, 0);
  assert.deepEqual(fixture.calls, [
    ['status', workerId],
    ['stop', { requestId, workerId, expectedRun }],
  ]);
});

test('resume binds the saved run, publishes its identity before dispatch, and sends no budget changes', async () => {
  const fixture = harness();
  fixture.dependencies.client.resume = async (params) => {
    assert.match(fixture.err[0], new RegExp(requestId));
    fixture.calls.push(['resume', params]);
    return receipt({ kind: 'resume' });
  };
  const code = await runTaskCommand(
    parseTerminalArguments(['resume', workerId, '--request-id', requestId]),
    fixture.dependencies,
  );
  assert.equal(code, 0);
  assert.deepEqual(fixture.calls, [
    ['status', workerId],
    ['resume', { requestId, workerId, expectedRun }],
  ]);
});

test('ambiguous resume is never replayed or replaced with a new task', async () => {
  let resumes = 0;
  const fixture = harness({
    async resume() {
      resumes++;
      throw new TerminalControlError('Acknowledgement lost.', 'unknown');
    },
  });
  const code = await runTaskCommand(
    parseTerminalArguments(['resume', workerId, '--request-id', requestId, '--watch']),
    fixture.dependencies,
  );
  assert.equal(code, 1);
  assert.equal(resumes, 1);
  assert.deepEqual(fixture.calls, [['status', workerId]]);
  assert.match(fixture.err.join('\n'), new RegExp('miter operation ' + requestId));
  assert.match(fixture.err.join('\n'), /Do not repeat this operation with a new request ID/);
});

test('pending resume waits through prior error, stopped and paused display while retaining fatal guards', () => {
  const current = status();
  for (const operationState of ['preparing', 'queued', 'claimed']) {
    const operation = receipt({ kind: 'resume', state: operationState });
    for (const phase of ['error', 'stopped']) {
      const progress = { phase, reason: 'Previous session ended' };
      assert.equal(watchOutcome(status({ operation, progress })), undefined);
      let staleCode = 1;
      if (phase === 'stopped') {
        staleCode = 2;
      }
      assert.equal(
        watchOutcome(status({ worker: { ...current.worker, state: 'paused' }, operation, progress })),
        undefined,
      );
      assert.equal(
        watchOutcome(status({ worker: { ...current.worker, pendingApproval: true }, operation, progress }))
          ?.code,
        2,
      );
      assert.equal(watchOutcome(status({ browserConnected: false, operation, progress }))?.code, 3);
      assert.equal(
        watchOutcome(status({ worker: { ...current.worker, state: 'cancelled' }, operation, progress }))
          ?.code,
        1,
      );
      assert.equal(
        watchOutcome(status({ worker: { ...current.worker, state: 'blocked' }, operation, progress })),
        undefined,
      );
      assert.equal(
        watchOutcome(
          status({ operation: { ...operation, expectedRun: { runId: 'old', epoch: 0 } }, progress }),
        )?.code,
        staleCode,
      );
    }
  }
});

test('resume watch crosses queued, claimed and acknowledged stale checkpoints before verified completion', async () => {
  const current = status();
  const progress = { revision: 7, phase: 'error', reason: 'Previous reply watch expired' };
  const pausedWorker = { ...current.worker, state: 'paused' };
  const resumed = receipt({ kind: 'resume' });
  const snapshots = [
    status({ worker: pausedWorker, progress }),
    status({ worker: pausedWorker, progress, operation: resumed }),
    status({ worker: pausedWorker, progress, operation: { ...resumed, state: 'claimed' } }),
    status({ worker: pausedWorker, progress, operation: { ...resumed, state: 'succeeded' } }),
    status({
      worker: pausedWorker,
      progress: { ...progress, revision: 8, phase: 'waiting_reply', reason: 'Reading saved reply' },
      operation: { ...resumed, state: 'succeeded' },
    }),
    status({
      worker: {
        ...current.worker,
        state: 'complete',
        completion: { verification: 'passed', summary: 'Done' },
      },
    }),
  ];
  const fixture = harness({
    async status() {
      const next = snapshots.shift();
      assert.ok(next);
      return next;
    },
  });
  const code = await runTaskCommand(
    parseTerminalArguments(['resume', workerId, '--request-id', requestId, '--watch', '--json']),
    fixture.dependencies,
  );
  assert.equal(code, 0);
  assert.equal(snapshots.length, 0);
  assert.deepEqual(fixture.calls, [['resume', { requestId, workerId, expectedRun }]]);
  assert.equal(JSON.parse(fixture.out[0]).kind, 'resume');
});

test('a newer failed checkpoint ends resume monitoring immediately instead of masking an actual failure', async () => {
  const progress = { revision: 7, phase: 'error', reason: 'Could not continue' };
  const operation = receipt({ kind: 'resume', state: 'succeeded' });
  const snapshots = [
    status({ progress }),
    status({ progress, operation }),
    status({ progress: { ...progress, revision: 8 }, operation }),
  ];
  const fixture = harness({
    async status() {
      const next = snapshots.shift();
      assert.ok(next);
      return next;
    },
  });
  const code = await runTaskCommand(
    parseTerminalArguments(['resume', workerId, '--request-id', requestId, '--watch']),
    fixture.dependencies,
  );
  assert.equal(code, 1);
  assert.equal(snapshots.length, 0);
  assert.match(fixture.err.join('\n'), /Could not continue/);
});

test('acknowledged resume without a newer checkpoint exits with attention after thirty seconds', async () => {
  const progress = { revision: 7, phase: 'error', reason: 'Previous session ended' };
  const operation = receipt({ kind: 'resume', state: 'succeeded' });
  const snapshots = [
    status({ progress }),
    status({ progress, operation }),
    status({ progress, operation }),
    status({ progress, operation }),
  ];
  let now = 1000;
  const fixture = harness({
    async status() {
      const next = snapshots.shift();
      assert.ok(next);
      return next;
    },
  });
  fixture.dependencies.now = () => now;
  fixture.dependencies.wait = async () => {
    now += 15000;
  };
  const code = await runTaskCommand(
    parseTerminalArguments(['resume', workerId, '--request-id', requestId, '--watch']),
    fixture.dependencies,
  );
  assert.equal(code, 2);
  assert.equal(now, 31000);
  assert.match(fixture.err.join('\n'), /no newer task checkpoint arrived within 30 seconds/);
  assert.deepEqual(fixture.calls, [['resume', { requestId, workerId, expectedRun }]]);
});

test('legacy progress without a revision uses a changed saved snapshot as resume evidence', async () => {
  const current = status();
  const progress = { phase: 'stopped', reason: 'Previous session ended' };
  const operation = receipt({ kind: 'resume', state: 'succeeded' });
  const snapshots = [
    status({ progress }),
    status({ progress, operation }),
    status({ progress: { phase: 'waiting_reply', reason: 'Reading saved reply' }, operation }),
    status({
      worker: {
        ...current.worker,
        state: 'complete',
        completion: { verification: 'passed', summary: 'Done' },
      },
      operation,
    }),
  ];
  const fixture = harness({
    async status() {
      const next = snapshots.shift();
      assert.ok(next);
      return next;
    },
  });
  const code = await runTaskCommand(
    parseTerminalArguments(['resume', workerId, '--request-id', requestId, '--watch']),
    fixture.dependencies,
  );
  assert.equal(code, 0);
  assert.equal(snapshots.length, 0);
});

test('waiting for a resumed checkpoint never masks approval, cancellation, failure or disconnect', () => {
  const current = status();
  const progress = { revision: 7, phase: 'error', reason: 'Previous session ended' };
  const operation = receipt({ kind: 'resume', state: 'succeeded' });
  const observation = {
    waitingForCheckpoint: true,
    checkpointObserved: false,
    previousWorker: current.worker,
  };
  for (const [worker, code] of [
    [{ ...current.worker, pendingApproval: true }, 2],
    [{ ...current.worker, state: 'cancelled' }, 1],
    [{ ...current.worker, state: 'blocked' }, 1],
  ]) {
    assert.equal(watchOutcome(status({ worker, progress, operation }), 1000, observation)?.code, code);
  }
  assert.equal(
    watchOutcome(status({ browserConnected: false, progress, operation }), 1000, observation)?.code,
    3,
  );
  assert.equal(
    watchOutcome(status({ progress, operation: { ...operation, state: 'failed' } }), 1000, observation)?.code,
    1,
  );
});

test('resuming keeps unchanged blocked and paused host states through fresh active checkpoints', async () => {
  for (const state of ['blocked', 'paused']) {
    const current = status();
    const worker = { ...current.worker, state, error: 'Previous interrupted step' };
    const progress = { revision: 7, phase: 'stopped', reason: 'Previous session ended' };
    const operation = receipt({ kind: 'resume', state: 'succeeded' });
    const snapshots = [
      status({ worker, progress }),
      status({ worker, progress, operation: { ...operation, state: 'queued' } }),
      status({ worker, progress, operation }),
      status({
        worker,
        progress: { revision: 8, phase: 'connecting', reason: 'Reconnecting saved chat' },
        operation,
      }),
      status({
        worker,
        progress: { revision: 9, phase: 'waiting_reply', reason: 'Reading saved reply' },
        operation,
      }),
      status({
        worker: {
          ...current.worker,
          state: 'complete',
          completion: { verification: 'passed', summary: 'Done' },
        },
        operation,
      }),
    ];
    const fixture = harness({
      async status() {
        const next = snapshots.shift();
        assert.ok(next);
        return next;
      },
    });
    const code = await runTaskCommand(
      parseTerminalArguments(['resume', workerId, '--request-id', requestId, '--watch']),
      fixture.dependencies,
    );
    assert.equal(code, 0, state);
    assert.equal(snapshots.length, 0, state);
  }
});

test('a fresh failed checkpoint or changed blocking reason ends resumed monitoring', async () => {
  for (const state of ['blocked', 'paused']) {
    for (const failure of ['checkpoint', 'worker']) {
      const current = status();
      const worker = { ...current.worker, state, error: 'Old failure' };
      const progress = { revision: 7, phase: 'stopped', reason: 'Previous session ended' };
      const operation = receipt({ kind: 'resume', state: 'succeeded' });
      let failed = status({
        worker,
        progress: { revision: 9, phase: 'error', reason: 'Fresh reader failure' },
        operation,
      });
      if (failure === 'worker') {
        failed = status({
          worker: { ...worker, state: 'blocked', error: 'Fresh host failure' },
          progress: { revision: 8, phase: 'connecting', reason: 'Reconnecting' },
          operation,
        });
      }
      const snapshots = [
        status({ worker, progress }),
        status({ worker, progress: { revision: 8, phase: 'connecting', reason: 'Reconnecting' }, operation }),
        failed,
      ];
      const fixture = harness({
        async status() {
          const next = snapshots.shift();
          assert.ok(next);
          return next;
        },
      });
      const code = await runTaskCommand(
        parseTerminalArguments(['resume', workerId, '--request-id', requestId, '--watch']),
        fixture.dependencies,
      );
      assert.equal(code, 1, state + ' ' + failure);
      assert.equal(snapshots.length, 0);
      assert.match(fixture.err.at(-1), /Fresh (reader|host) failure/);
    }
  }
});

test('blocked resume without a fresh checkpoint still has a thirty-second attention deadline', async () => {
  const worker = { ...status().worker, state: 'blocked', error: 'Old failure' };
  const progress = { revision: 7, phase: 'connecting', reason: 'Old connection attempt' };
  const operation = receipt({ kind: 'resume', state: 'succeeded' });
  const snapshots = [
    status({ worker, progress }),
    status({ worker, progress, operation }),
    status({ worker, progress, operation }),
  ];
  let now = 0;
  const fixture = harness({
    async status() {
      const next = snapshots.shift();
      assert.ok(next);
      return next;
    },
  });
  fixture.dependencies.now = () => now;
  fixture.dependencies.wait = async () => {
    now += 30000;
  };
  const code = await runTaskCommand(
    parseTerminalArguments(['resume', workerId, '--request-id', requestId, '--watch']),
    fixture.dependencies,
  );
  assert.equal(code, 2);
  assert.match(fixture.err.at(-1), /no newer task checkpoint arrived within 30 seconds/);
});

test('recoverable attention messages name terminal Resume without promising to revive a stopped plan', () => {
  const current = status();
  for (const value of [
    status({ worker: { ...current.worker, state: 'paused' } }),
    status({
      progress: { phase: 'error', reason: 'Reply watch expired', monitoring: true, watchUntil: 1000 },
    }),
    status({ progress: { phase: 'stopped', reason: 'Extension shutdown' } }),
  ]) {
    const outcome = watchOutcome(value, 2000);
    assert.equal(outcome.code, 2);
    assert.match(outcome.message, new RegExp('miter resume ' + workerId + ' --watch'));
    assert.match(outcome.message, /If you stopped the plan, use Continue fresh/);
  }
  assert.doesNotMatch(
    watchOutcome(status({ worker: { ...current.worker, pendingApproval: true } })).message,
    /miter resume/,
  );
});

test('watch continues through an active review phase and exits only on verified completion', async () => {
  const current = status();
  const reviewing = status({
    worker: { ...current.worker, state: 'review' },
    progress: { phase: 'waiting_reply', turns: 2, maxTurns: 20, reason: 'Repairing checks' },
  });
  const complete = status({
    worker: { ...current.worker, state: 'complete', completion: { verification: 'passed', summary: 'Done' } },
  });
  const snapshots = [reviewing, reviewing, complete];
  const fixture = harness({
    async status() {
      const next = snapshots.shift();
      assert.ok(next);
      return next;
    },
  });
  const code = await runTaskCommand(
    parseTerminalArguments(['watch', workerId, '--json']),
    fixture.dependencies,
  );
  assert.equal(code, 0);
  assert.equal(fixture.out.length, 2, 'unchanged snapshots should not flood terminal output');
  assert.match(fixture.err.join('\n'), /recorded verification/);
});

test('watch distinguishes unverified completion, approval, pause, disconnect and failure', () => {
  const current = status();
  for (const [snapshot, code] of [
    [status({ worker: { ...current.worker, state: 'complete' } }), 2],
    [status({ worker: { ...current.worker, pendingApproval: true } }), 2],
    [status({ worker: { ...current.worker, state: 'paused' } }), 2],
    [status({ browserConnected: false }), 3],
    [status({ operation: receipt({ state: 'failed', error: 'Cannot dispatch' }) }), 1],
    [status({ worker: { ...current.worker, state: 'blocked' } }), 1],
  ]) {
    assert.equal(watchOutcome(snapshot)?.code, code);
  }
});

test('an old failed receipt cannot stop monitoring a newer task run', () => {
  assert.equal(
    watchOutcome(
      status({ operation: receipt({ state: 'failed', expectedRun: { runId: 'older-run', epoch: 0 } }) }),
    ),
    undefined,
  );
});

test('recoverable errors keep watching only with a connected browser and an active structured deadline', () => {
  const current = status();
  const progress = { phase: 'error', reason: 'Waiting for a late reply', monitoring: true, watchUntil: 2000 };
  const automatic = { ...progress, phase: 'waiting_reply' };
  assert.equal(watchOutcome(status({ progress: automatic }), 1000), undefined);
  assert.equal(watchOutcome(status({ progress: automatic }), 2000)?.code, 2);
  assert.equal(watchOutcome(status({ progress }), 1000), undefined);
  assert.equal(watchOutcome(status({ progress }), 2000)?.code, 2);
  assert.equal(watchOutcome(status({ progress }), 3000)?.code, 2);
  assert.equal(watchOutcome(status({ progress: { ...progress, monitoring: false } }), 1000)?.code, 1);
  assert.equal(
    watchOutcome(status({ progress: { phase: 'error', reason: progress.reason } }), 1000)?.code,
    1,
  );
  assert.equal(
    watchOutcome(status({ progress: { phase: 'error', reason: progress.reason, monitoring: true } }), 1000)
      ?.code,
    1,
  );
  assert.equal(watchOutcome(status({ progress, browserConnected: false }), 1000)?.code, 3);
  for (const state of ['blocked', 'cancelled']) {
    assert.equal(watchOutcome(status({ worker: { ...current.worker, state }, progress }), 1000)?.code, 1);
  }
  assert.equal(
    watchOutcome(status({ worker: { ...current.worker, state: 'paused' }, progress }), 1000)?.code,
    2,
  );
});

test('watch emits monitoring deadline changes, follows late-reply recovery, and reaches verified completion', async () => {
  const current = status();
  const progress = {
    phase: 'error',
    reason: 'Waiting for a late reply',
    monitoring: true,
    watchUntil: Date.now() + 60000,
  };
  const snapshots = [
    status({ progress }),
    status({ progress: { ...progress, watchUntil: progress.watchUntil + 1000 } }),
    status({ progress: { phase: 'waiting_reply', reason: 'Reply recovered', monitoring: false } }),
    status({
      worker: {
        ...current.worker,
        state: 'complete',
        completion: { verification: 'passed', summary: 'Done' },
      },
    }),
  ];
  const fixture = harness({
    async status() {
      const next = snapshots.shift();
      assert.ok(next);
      return next;
    },
  });
  const code = await runTaskCommand(
    parseTerminalArguments(['watch', workerId, '--json']),
    fixture.dependencies,
  );
  assert.equal(code, 0);
  assert.equal(fixture.out.length, 4);
  assert.equal(snapshots.length, 0);
});

test('a new run cannot inherit the monitor for the old run even with a future recovery deadline', async () => {
  const current = status();
  const progress = {
    phase: 'error',
    reason: 'Waiting for a late reply',
    monitoring: true,
    watchUntil: Date.now() + 60000,
  };
  const snapshots = [
    status({ progress }),
    status({
      worker: { ...current.worker, expectedRun: { ...expectedRun, epoch: expectedRun.epoch + 1 } },
      progress,
    }),
  ];
  const fixture = harness({
    async status() {
      const next = snapshots.shift();
      assert.ok(next);
      return next;
    },
  });
  const code = await runTaskCommand(parseTerminalArguments(['watch', workerId]), fixture.dependencies);
  assert.equal(code, 2);
  assert.match(fixture.err.join('\n'), /task run changed/);
});

test('goal validation uses the creation contract before contacting the running host', () => {
  for (const goal of [' ', '\n\t', 'A\u0000B', 'x'.repeat(4001)]) {
    assert.throws(() => parseTerminalArguments(['start', '--project', '/tmp/app', '--goal', goal]));
  }
  assert.equal(
    parseTerminalArguments(['start', '--project', '/tmp/app', '--goal', 'x'.repeat(4000)]).goal.length,
    4000,
  );
});

test('interrupted monitoring never sends stop and does not mislabel the task as cancelled', async () => {
  const fixture = harness();
  fixture.dependencies.wait = async () => {
    fixture.controller.abort();
  };
  const code = await runTaskCommand(parseTerminalArguments(['watch', workerId]), fixture.dependencies);
  assert.equal(code, 130);
  assert.deepEqual(fixture.calls, [['status', workerId]]);
  assert.match(fixture.err.join('\n'), /task was not cancelled/);
});

test('a failure after accepted start does not claim its start acknowledgement was lost', async () => {
  const fixture = harness({
    async status() {
      throw new TerminalControlError('Connection lost.', 'unknown');
    },
  });
  const code = await runTaskCommand(
    parseTerminalArguments(['start', '--project', '/tmp/app', '--goal', 'Build it', '--watch']),
    fixture.dependencies,
  );
  assert.equal(code, 1);
  assert.doesNotMatch(fixture.err.join('\n'), /Do not start again/);
});

test('preview CLI prints the exact host URL and gives JSON consumers the session details', async () => {
  const previewId = 'c'.repeat(32);
  const preview = {
    previewId,
    url: 'http://miter-' + previewId + '.localhost:8123/' + previewId + '/index.html',
    files: 1,
    bytes: 12,
    idleTimeoutMs: 1800000,
    detail: 'Local application preview.',
  };
  const sent = [];
  const fixture = harness({
    preview: async (params) => {
      sent.push(params);
      return preview;
    },
  });
  const run = (...options) =>
    runTaskCommand(parseTerminalArguments(['preview', workerId, ...options]), fixture.dependencies);
  assert.equal(await run(), 0);
  assert.deepEqual(fixture.out, [preview.url, preview.detail]);
  assert.equal(await run('--json'), 0);
  assert.deepEqual(JSON.parse(fixture.out.at(-1)), { type: 'preview', workerId, expectedRun, ...preview });
  assert.deepEqual(sent, [
    { workerId, expectedRun },
    { workerId, expectedRun },
  ]);
  assert.deepEqual(fixture.calls, [
    ['status', workerId],
    ['status', workerId],
  ]);
  for (const invalid of [
    ['preview'],
    ['preview', 'one', 'two'],
    ['preview', workerId, '--watch'],
    ['preview', workerId, '--portable'],
  ]) {
    assert.throws(() => parseTerminalArguments(invalid));
  }
});
