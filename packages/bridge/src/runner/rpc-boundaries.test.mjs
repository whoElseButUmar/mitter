import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, replaceRpcResult } from './fixtures.mjs';

const { snapshotSchema } = await import('../../../protocol/src/index.ts');
const { ReplyValidationError } = await import('../../../protocol/src/validation.ts');
const { NativeRequestTimeout } = await import('../native-request.ts');
const { RpcResultValidationError } = await import('../../../protocol/src/rpc.ts');

const referencedActions = [
  {
    type: 'write',
    path: 'new.txt',
    content: 'Saved content.',
    base: 'missing',
  },
];
const admissionIssue = {
  stage: 'precondition',
  code: 'BASE_UNAVAILABLE',
  message: 'Read the affected file again.',
  field: 'base',
  actionIndex: 0,
};
const malformedValues = [
  ['missing', undefined],
  ['null', null],
  ['object', { sensitive: 'DO_NOT_LOG' }],
  ['number', 42],
  ['array', ['text']],
];

function selectedReply(harness, actions = [{ type: 'list', path: '.' }]) {
  return JSON.stringify({
    protocol: 'mitter/1',
    id: 'selected_reply',
    workerId: harness.worker.id,
    projectId: harness.worker.projectId,
    summary: 'Selected reply',
    actions,
  });
}

async function importReply(harness, changes) {
  await harness.runner.start();
  const envelope = harness.showReply(changes);
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  return envelope;
}

test('runner harness state results conform to the shared snapshot schema', () => {
  const harness = createHarness();
  assert.deepEqual(snapshotSchema.parse(harness.dependencies.snapshot()), harness.dependencies.snapshot());
});

test('malformed bootstrap and next prompts fail before preparation or Send', async (context) => {
  for (const kind of ['bootstrap', 'next']) {
    for (const [name, result] of malformedValues) {
      await context.test(kind + ': ' + name, async () => {
        const harness = createHarness();
        replaceRpcResult(harness, 'worker.prompt', result, kind);
        await assert.rejects(harness.runner.start(), {
          message: 'The host returned an invalid result for worker.prompt.',
        });
        assert.equal(harness.runner.status.active, false);
        assert.equal(harness.runner.status.reason.includes('DO_NOT_LOG'), false);
        assert.equal(harness.events.includes('page:prepare'), false);
        assert.equal(harness.commits.length, 0);
        assert.equal(harness.imports.length, 0);
        assert.equal(harness.progress().stage, 'ready');
        assert.equal(harness.runner.status.turns, 0);
      });
    }
  }
});

test('selected replies retain durable approval but cannot bypass malformed prompt results', async (context) => {
  for (const kind of ['bootstrap', 'next']) {
    await context.test(kind, async () => {
      const harness = createHarness();
      replaceRpcResult(harness, 'worker.prompt', null, kind);
      await assert.rejects(
        harness.runner.startWithReply(selectedReply(harness), harness.options.url),
        /invalid result for worker.prompt/,
      );
      assert.equal(harness.progress().approvedReply.id, 'selected_reply');
      assert.equal(harness.progress().stage, 'waiting_reply');
      assert.equal(harness.runner.status.turns, 0);
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.commits.length, 0);
    });
  }
});

test('malformed receipt results never import, run, or request a correction', async (context) => {
  for (const [name, result] of [
    ...malformedValues,
    ['absent seen', {}],
    ['truthy seen', { seen: 'false' }],
  ]) {
    await context.test(name, async () => {
      const harness = createHarness();
      replaceRpcResult(harness, 'worker.handoffSeen', result);
      await importReply(harness);
      assert.equal(harness.runner.status.active, false);
      assert.equal(
        harness.runner.status.reason,
        'The host returned an invalid result for worker.handoffSeen.',
      );
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.events.includes('worker.run'), false);
      assert.equal(harness.commits.length, 1);
      assert.equal(harness.progress().stage, 'waiting_reply');
      const events = [...harness.events];
      await harness.runner.tick();
      assert.deepEqual(harness.events, events);
    });
  }
});

test('malformed reconciliation receipts cannot mark or resume an accepted queue', async () => {
  const previous = createHarness();
  await previous.runner.start();
  const accepted = previous.showReply();
  const saved = previous.progress();
  const resumed = createHarness({
    progress: saved,
    options: { resumeExisting: true },
    worker: { state: 'review', queue: [accepted] },
  });
  replaceRpcResult(resumed, 'worker.handoffSeen', { seen: 'true' });
  await assert.rejects(resumed.runner.start(), /invalid result for worker.handoffSeen/);
  assert.deepEqual(resumed.progress(), saved);
  assert.equal(resumed.events.includes('worker.resume'), false);
  assert.equal(resumed.events.includes('worker.run'), false);
  assert.equal(resumed.imports.length, 0);
  assert.equal(resumed.commits.length, 0);
});

test('malformed adopted-reply receipts cannot request a report or replay the saved Send', async () => {
  const previous = createHarness();
  await previous.runner.start();
  const envelope = previous.showReply();
  const resumed = createHarness({
    progress: previous.progress(),
    options: { resumeExisting: true },
    view: {
      count: 2,
      userCount: 1,
      lastRole: 'assistant',
      lastUserText: previous.commits[0].text,
      assistantId: envelope.id,
      assistantText: JSON.stringify(envelope),
      assistantFormat: 'code',
      complete: true,
    },
  });
  replaceRpcResult(resumed, 'worker.handoffSeen', {});
  await assert.rejects(resumed.runner.start(), /invalid result for worker.handoffSeen/);
  assert.equal(resumed.events.includes('worker.handoffSeen'), true);
  assert.equal(resumed.events.includes('worker.report'), false);
  assert.equal(resumed.imports.length, 0);
  assert.equal(resumed.commits.length, 0);
  assert.equal(resumed.runner.status.turns, 1);
});

test('malformed admission results stop without importing or spending a repair turn', async (context) => {
  for (const [name, result] of [
    ...malformedValues,
    ['truthy valid', { valid: 'true' }],
    ['rejection without issue', { valid: false }],
    ['invalid accepted issue', { valid: true, issue: { ...admissionIssue, stage: 'execution' } }],
    ['invalid rejected issue', { valid: false, issue: { ...admissionIssue, actionIndex: -1 } }],
  ]) {
    await context.test(name, async () => {
      const harness = createHarness();
      replaceRpcResult(harness, 'worker.validateReply', result);
      await importReply(harness, { actions: referencedActions });
      assert.equal(harness.events.includes('worker.validateReply'), true);
      assert.equal(
        harness.runner.status.reason,
        'The host returned an invalid result for worker.validateReply.',
      );
      assert.equal(harness.runner.status.active, false);
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.events.includes('worker.run'), false);
      assert.equal(harness.events.includes('worker.report'), false);
      assert.equal(harness.commits.length, 1);
      assert.equal(harness.progress().formatRepairs, 0);
      assert.equal(harness.progress().stage, 'waiting_reply');
    });
  }
});

test('valid admission rejection retains bounded read/replan correction and user-selected errors', async (context) => {
  await context.test('automatic reply', async () => {
    const harness = createHarness();
    replaceRpcResult(harness, 'worker.validateReply', {
      valid: false,
      issue: admissionIssue,
    });
    await importReply(harness, { actions: referencedActions });
    assert.equal(harness.imports.length, 0);
    assert.equal(harness.events.includes('worker.run'), false);
    assert.equal(harness.commits.length, 2);
    assert.equal(harness.progress().formatRepairs, 1);
    assert.equal(harness.progress().stage, 'waiting_reply');
    assert.match(harness.commits[1].text, /BASE_UNAVAILABLE/);
  });
  await context.test('user-selected reply', async () => {
    const harness = createHarness();
    replaceRpcResult(harness, 'worker.validateReply', {
      valid: false,
      issue: admissionIssue,
    });
    await assert.rejects(
      harness.runner.startWithReply(selectedReply(harness, referencedActions), harness.options.url),
      (error) => {
        assert.ok(error instanceof ReplyValidationError);
        assert.deepEqual(error.issue, admissionIssue);
        return true;
      },
    );
    assert.equal(harness.imports.length, 0);
    assert.equal(harness.events.includes('worker.run'), false);
    assert.equal(harness.commits.length, 0);
    assert.equal(harness.progress().approvedReply.id, 'selected_reply');
  });
});

test('an excluded dependency read after setup gets a bounded correction before import', async (context) => {
  const rejected = [{ type: 'read', path: 'node_modules/pdf-lib/package.json' }];
  const rejection = {
    valid: false,
    issue: {
      stage: 'precondition',
      code: 'EXCLUDED_PATH',
      actionIndex: 0,
      field: 'path',
      message: 'Sensitive or excluded path.',
    },
  };
  const report = 'Manual setup finished. pnpm add pdf-lib exited with code 0.';
  async function showNext(harness, id, actions) {
    harness.showReply({ id, actions });
    await harness.runner.tick();
    harness.advance(1800);
    await harness.runner.tick();
  }
  for (const outcome of ['corrected', 'still excluded']) {
    await context.test(outcome, async () => {
      const harness = createHarness();
      replaceRpcResult(harness, 'worker.report', report);
      replaceRpcResult(harness, 'worker.validateReply', rejection);
      await importReply(harness, { actions: rejected });
      assert.equal(harness.progress().formatRepairs, 1);
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.events.includes('worker.run'), false);
      assert.equal(harness.commits.length, 2);
      assert.ok(harness.commits[1].text.includes(report));
      assert.match(harness.commits[1].text, /Omit the excluded path/);
      assert.doesNotMatch(harness.commits[1].text, /node_modules\/pdf-lib/);
      if (outcome === 'corrected') {
        replaceRpcResult(harness, 'worker.validateReply', { valid: true });
        const allowed = [{ type: 'read', path: 'package.json' }];
        await showNext(harness, 'fresh_project_read', allowed);
        assert.equal(harness.imports.length, 1);
        assert.deepEqual(JSON.parse(harness.imports[0].text).actions, allowed);
        assert.equal(harness.events.filter((event) => event === 'worker.run').length, 1);
      } else {
        await showNext(harness, 'second_excluded_read', rejected);
        await showNext(harness, 'third_excluded_read', rejected);
        assert.equal(harness.commits.length, 3);
        assert.equal(harness.progress().formatRepairs, 2);
        assert.equal(harness.imports.length, 0);
        assert.equal(harness.events.includes('worker.run'), false);
        assert.match(harness.runner.status.reason, /EXCLUDED_PATH.*Two correction attempts/);
      }
    });
  }
});

test('malformed late-watch admission stays read-only and retains the absolute deadline', async (context) => {
  for (const [name, result] of [
    ['missing valid', {}],
    ['malformed issue', { valid: true, issue: { ...admissionIssue, stage: 'execution' } }],
  ]) {
    await context.test(name, async () => {
      const harness = createHarness();
      await harness.runner.start();
      await harness.runner.stop('Cannot read reply.', 'error', 'REPLY_UNREADABLE');
      const saved = harness.progress();
      const deadline = harness.runner.status.watchUntil;
      replaceRpcResult(harness, 'worker.validateReply', result);
      harness.showReply({ actions: referencedActions });
      for (const elapsed of [1800, 1800]) {
        harness.advance(elapsed);
        await harness.runner.tick();
      }
      assert.equal(harness.events.includes('worker.validateReply'), true);
      assert.equal(harness.runner.status.active, false);
      assert.equal(harness.runner.status.monitoring, true);
      assert.equal(harness.runner.status.watchUntil, deadline);
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.commits.length, 1);
      assert.deepEqual(harness.progress(), {
        ...saved,
        revision: saved.revision + 1,
        updatedAt: saved.updatedAt + 1800,
        readerDiagnostic: { reason: 'validation_rejected' },
      });
    });
  }
});

test('malformed reports retain the completed local batch without another Send or import', async (context) => {
  for (const [name, result] of malformedValues) {
    await context.test(name, async () => {
      const harness = createHarness();
      const envelope = await importReply(harness);
      const receipt = structuredClone(harness.options.lastReceipt);
      harness.worker.state = 'review';
      replaceRpcResult(harness, 'worker.report', result);
      await harness.runner.tick();
      assert.equal(harness.runner.status.reason, 'The host returned an invalid result for worker.report.');
      assert.equal(harness.runner.status.active, false);
      assert.equal(harness.imports.length, 1);
      assert.equal(harness.events.filter((event) => event === 'worker.run').length, 1);
      assert.equal(harness.commits.length, 1);
      assert.deepEqual(harness.options.lastReceipt, receipt);
      assert.equal(harness.progress().stage, 'report_due');
      assert.equal(harness.progress().lastImportedId, envelope.id);
      const events = [...harness.events];
      await harness.runner.tick();
      assert.deepEqual(harness.events, events);
    });
  }
});

test('malformed state results cannot authorize local completion or a continuation report', async (context) => {
  for (const [name, corrupt] of [
    ['partial snapshot', (snapshot) => ({ workers: snapshot.workers })],
    [
      'missing settings',
      (snapshot) => {
        delete snapshot.settings;
        return snapshot;
      },
    ],
    [
      'invalid worker',
      (snapshot) => {
        snapshot.workers[0].state = 'unknown';
        return snapshot;
      },
    ],
    [
      'invalid approval',
      (snapshot) => {
        snapshot.workers[0].pending = { token: 1 };
        return snapshot;
      },
    ],
    [
      'invalid control',
      (snapshot) => {
        snapshot.workers[0].control = { epoch: '0' };
        return snapshot;
      },
    ],
  ]) {
    await context.test(name, async () => {
      const harness = createHarness();
      const envelope = await importReply(harness);
      harness.worker.state = 'review';
      replaceRpcResult(harness, 'state', corrupt(structuredClone(harness.dependencies.snapshot())));
      await harness.runner.tick();
      assert.equal(harness.runner.status.reason, 'The host returned an invalid result for state.');
      assert.equal(harness.runner.status.active, false);
      assert.equal(harness.events.includes('worker.report'), false);
      assert.equal(harness.imports.length, 1);
      assert.equal(harness.commits.length, 1);
      assert.equal(harness.progress().stage, 'local_batch');
      assert.equal(harness.progress().lastImportedId, envelope.id);
    });
  }
});

test('valid snapshots still require the bound task identity before continuation', async () => {
  const harness = createHarness();
  await importReply(harness);
  const snapshot = structuredClone(harness.dependencies.snapshot());
  snapshot.workers[0].projectId = 'other_project';
  assert.equal(snapshotSchema.safeParse(snapshot).success, true);
  replaceRpcResult(harness, 'state', snapshot);
  await harness.runner.tick();
  assert.equal(harness.runner.status.reason, 'The task is no longer available.');
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.commits.length, 1);
});

test('malformed recovery snapshots cannot spend a repair turn or replay an absent response', async () => {
  const harness = createHarness();
  await harness.runner.start();
  harness.setView({
    transcript: {
      version: 'message-discovery/1',
      state: 'ready',
      users: 1,
      assistants: 0,
      roleAttributes: 1,
      alternativeRoles: 0,
      semanticRoles: 0,
      turnContainers: 1,
      unknownTurns: 0,
      unclassifiedTail: false,
      codeBlocks: 0,
      openShadowRoots: 0,
      frames: 0,
      scanLimited: false,
    },
  });
  replaceRpcResult(harness, 'state', { workers: [harness.worker] });
  await harness.runner.tick();
  const receipt = structuredClone(harness.options.lastReceipt);
  harness.advance(120000);
  await harness.runner.tick();
  assert.equal(harness.events.includes('state'), true);
  assert.equal(harness.runner.status.reason, 'The host returned an invalid result for state.');
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.progress().formatRepairs, 0);
  assert.deepEqual(harness.options.lastReceipt, receipt);
});

for (const method of ['worker.import', 'worker.run']) {
  test(
    method + ' invalid acknowledgements cannot replay a completed operation or advance delivery',
    async (context) => {
      for (const [name, receipt] of [
        ['missing', undefined],
        ['null', null],
        ['empty', {}],
        ['wrong variant', { stopping: false }],
        ['incomplete recovery', { started: true, acknowledged: true }],
      ]) {
        await context.test(name, async () => {
          const harness = createHarness();
          const rpc = harness.dependencies.rpc;
          harness.dependencies.rpc = async (requestedMethod, params) => {
            const result = await rpc(requestedMethod, params);
            if (requestedMethod === method) {
              return receipt;
            }
            return result;
          };
          const envelope = await importReply(harness, {
            actions: [
              { type: 'write', path: 'exact.js', content: '\ufeffconst text = "😀";\r\n', base: 'missing' },
            ],
          });
          assert.equal(harness.runner.status.active, false);
          assert.equal(harness.runner.status.errorCode, 'RPC_RESULT_INVALID');
          assert.match(harness.runner.status.reason, /operation may already have completed/);
          assert.equal(harness.imports.length, 1);
          assert.equal(harness.imports[0].epoch, 0);
          assert.equal(harness.imports[0].reconcile, true);
          assert.equal(JSON.parse(harness.imports[0].text).actions[0].content, envelope.actions[0].content);
          assert.equal(harness.commits.length, 1);
          assert.equal(harness.events.includes('worker.report'), false);
          if (method === 'worker.import') {
            assert.equal(harness.events.includes('worker.run'), false);
            assert.equal(harness.progress().stage, 'waiting_reply');
            assert.equal(harness.progress().lastImportedId, undefined);
          } else {
            assert.equal(harness.events.filter((event) => event === 'worker.run').length, 1);
            assert.equal(harness.progress().stage, 'local_batch');
            assert.equal(harness.progress().lastImportedId, envelope.id);
          }
          const saved = harness.progress();
          const events = [...harness.events];
          harness.advance(60000);
          await harness.runner.tick();
          assert.deepEqual(harness.events, events);
          assert.deepEqual(harness.progress(), saved);
        });
      }
    },
  );

  test(
    method + ' valid acknowledgements arriving after an epoch change cannot authorize continuation',
    async () => {
      const harness = createHarness();
      const rpc = harness.dependencies.rpc;
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      harness.dependencies.rpc = async (requestedMethod, params) => {
        const result = await rpc(requestedMethod, params);
        if (requestedMethod === method) {
          entered.resolve();
          await release.promise;
        }
        return result;
      };
      await harness.runner.start();
      harness.showReply();
      await harness.runner.tick();
      harness.advance(1800);
      const delivering = harness.runner.tick();
      await entered.promise;
      try {
        harness.worker.control = {
          version: 1,
          epoch: 1,
          mode: 'fresh',
          at: harness.now(),
          operationId: 'replacement',
          reason: 'New steering',
          retiredExchanges: [harness.options.lastReceipt.exchangeId],
        };
        harness.worker.runId = 'replacement_run';
      } finally {
        release.resolve();
        await delivering;
      }
      assert.equal(harness.runner.status.errorCode, 'RUN_SUPERSEDED');
      assert.equal(harness.runner.status.active, false);
      assert.equal(harness.events.includes('worker.pause'), false);
      assert.equal(harness.imports.length, 1);
      assert.equal(harness.commits.length, 1);
      assert.equal(harness.events.includes('worker.report'), false);
      if (method === 'worker.import') {
        assert.equal(harness.events.includes('worker.run'), false);
        assert.equal(harness.progress().stage, 'waiting_reply');
      } else {
        assert.equal(harness.events.filter((event) => event === 'worker.run').length, 1);
        assert.equal(harness.progress().stage, 'local_batch');
      }
    },
  );
}

test('exact host import/run recovery receipts retain durable-before-start ordering', async () => {
  const harness = createHarness();
  const rpc = harness.dependencies.rpc;
  const requests = [];
  harness.dependencies.rpc = async (method, params) => {
    requests.push([method, params]);
    const result = await rpc(method, params);
    if (method === 'worker.import') {
      return { queued: false, acknowledged: true };
    }
    if (method === 'worker.run') {
      return { started: true, acknowledged: true, state: 'executing' };
    }
    return result;
  };
  const envelope = await importReply(harness);
  assert.equal(harness.runner.status.active, true);
  assert.equal(harness.progress().stage, 'local_batch');
  assert.equal(harness.progress().lastImportedId, envelope.id);
  assert.ok(harness.events.indexOf('save:local_batch') < harness.events.indexOf('worker.run'));
  const run = requests.find(([method]) => method === 'worker.run');
  assert.equal(run[1].envelopeId, envelope.id);
  assert.match(run[1].envelopeHash, /^[0-9a-f]{64}$/);
  assert.equal(run[1].epoch, 0);
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.commits.length, 1);
});

test('invalid resume receipts retain saved local work without another import or handoff', async (context) => {
  const previous = createHarness();
  const envelope = await importReply(previous);
  for (const receipt of [
    undefined,
    null,
    {},
    { queued: true },
    { started: true, acknowledged: true, state: 'executing' },
  ]) {
    await context.test(JSON.stringify(receipt), async () => {
      const saved = previous.progress();
      const resumed = createHarness({
        progress: saved,
        options: { resumeExisting: true },
        worker: { state: 'paused', queue: [envelope] },
      });
      replaceRpcResult(resumed, 'worker.resume', receipt);
      await assert.rejects(resumed.runner.start(), (error) => {
        assert.ok(error instanceof RpcResultValidationError);
        assert.equal(error.method, 'worker.resume');
        assert.equal(error.retryable, false);
        return true;
      });
      assert.equal(resumed.progress().stage, 'local_batch');
      assert.equal(resumed.progress().lastImportedId, envelope.id);
      assert.deepEqual(resumed.progress().lastReceipt, saved.lastReceipt);
      assert.equal(resumed.events.filter((event) => event === 'worker.resume').length, 1);
      assert.equal(resumed.events.includes('worker.run'), false);
      assert.equal(resumed.imports.length, 0);
      assert.equal(resumed.commits.length, 0);
      resumed.advance(60000);
      await resumed.runner.tick();
      assert.equal(resumed.events.filter((event) => event === 'worker.resume').length, 1);
    });
  }
});

test('a typed run timeout recovers only the exact durable start without a second launch or handoff', async () => {
  const harness = createHarness();
  const rpc = harness.dependencies.rpc;
  const requests = [];
  let launches = 0;
  harness.dependencies.rpc = async (method, params) => {
    if (method === 'worker.run') {
      requests.push(structuredClone(params));
      if (requests.length === 1) {
        launches++;
        await rpc(method, params);
        throw new NativeRequestTimeout(method);
      }
      harness.events.push(method);
      return { started: true, acknowledged: true, state: 'executing' };
    }
    return rpc(method, params);
  };
  const envelope = await importReply(harness);
  assert.equal(harness.runner.status.active, true);
  assert.equal(harness.progress().stage, 'local_batch');
  assert.equal(harness.progress().lastImportedId, envelope.id);
  assert.equal(requests.length, 1);
  harness.advance(1000);
  await harness.runner.tick();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(launches, 1);
  assert.equal(harness.runner.pendingDelivery, undefined);
  assert.equal(harness.events.includes('worker.report'), false);
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.commits.length, 1);
});

test('a delayed valid resume receipt cannot continue or pause a replacement epoch', async () => {
  const previous = createHarness();
  const envelope = await importReply(previous);
  const resumed = createHarness({
    progress: previous.progress(),
    options: { resumeExisting: true },
    worker: { state: 'paused', queue: [envelope] },
  });
  const rpc = resumed.dependencies.rpc;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  resumed.dependencies.rpc = async (method, params) => {
    const result = await rpc(method, params);
    if (method === 'worker.resume') {
      entered.resolve();
      await release.promise;
    }
    return result;
  };
  const starting = resumed.runner.start();
  const rejection = assert.rejects(starting, { code: 'RUN_SUPERSEDED' });
  await entered.promise;
  try {
    resumed.worker.control = {
      version: 1,
      epoch: 1,
      mode: 'fresh',
      at: resumed.now(),
      operationId: 'replacement_resume',
      reason: 'Replacement plan',
      retiredExchanges: [previous.options.lastReceipt.exchangeId],
    };
    resumed.worker.runId = 'replacement_resume_run';
  } finally {
    release.resolve();
    await rejection;
  }
  assert.equal(resumed.events.filter((event) => event === 'worker.resume').length, 1);
  assert.equal(resumed.events.includes('worker.pause'), false);
  assert.equal(resumed.events.includes('worker.run'), false);
  assert.equal(resumed.events.includes('worker.report'), false);
  assert.equal(resumed.progress().stage, 'local_batch');
  assert.equal(resumed.imports.length, 0);
  assert.equal(resumed.commits.length, 0);
});

test('a resume timeout is never treated as an exact-delivery retry', async () => {
  const previous = createHarness();
  const envelope = await importReply(previous);
  const resumed = createHarness({
    progress: previous.progress(),
    options: { resumeExisting: true },
    worker: { state: 'paused', queue: [envelope] },
  });
  const rpc = resumed.dependencies.rpc;
  const failure = new NativeRequestTimeout('worker.resume');
  resumed.dependencies.rpc = async (method, params) => {
    const result = await rpc(method, params);
    if (method === 'worker.resume') {
      throw failure;
    }
    return result;
  };
  await assert.rejects(resumed.runner.start(), (error) => error === failure);
  resumed.advance(60000);
  await resumed.runner.tick();
  assert.equal(resumed.events.filter((event) => event === 'worker.resume').length, 1);
  assert.equal(resumed.events.includes('worker.run'), false);
  assert.equal(resumed.imports.length, 0);
  assert.equal(resumed.commits.length, 0);
  assert.equal(resumed.progress().stage, 'local_batch');
});

test('invalid pause receipts are reported while every shutdown barrier still drains', async () => {
  const harness = createHarness();
  await importReply(harness);
  const logs = [];
  harness.dependencies.log = (kind, message) => logs.push({ kind, message });
  replaceRpcResult(harness, 'worker.pause', { started: true });
  await harness.runner.stop();
  await harness.runner.settled();
  assert.equal(harness.events.filter((event) => event === 'worker.pause').length, 1);
  assert.equal(harness.events.includes('page:stop'), true);
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.progress().stage, 'local_batch');
  assert.equal(harness.commits.length, 1);
  assert.match(
    logs.find((entry) => entry.kind === 'bridge.local.pause.error').message,
    /may already have completed/,
  );
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.commits.length, 1);
});

test('schema-driven queries preserve RPC errors and dependency method receivers', async (context) => {
  await context.test('dependency receiver', async () => {
    const harness = createHarness();
    const rpc = harness.dependencies.rpc;
    harness.dependencies.rpc = async function (method, params) {
      assert.equal(this, harness.dependencies);
      return rpc(method, params);
    };
    await harness.runner.start();
    assert.equal(harness.commits.length, 1);
  });
  for (const error of [new Error('Host policy refused.'), new NativeRequestTimeout('worker.prompt')]) {
    await context.test(error.name, async () => {
      const harness = createHarness();
      harness.dependencies.rpc = async (method) => {
        harness.events.push(method);
        throw error;
      };
      await assert.rejects(harness.runner.start(), (received) => received === error);
      assert.equal(harness.events.filter((event) => event === 'worker.prompt').length, 1);
      assert.equal(harness.commits.length, 0);
      assert.equal(harness.imports.length, 0);
      assert.equal(harness.runner.status.reason, error.message);
    });
  }
});
