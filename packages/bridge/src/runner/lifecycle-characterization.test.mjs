import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

const { buildExchangeMessage, buildReportPrompt } = await import('./prompts.ts');

async function acceptReply(harness) {
  await harness.runner.start();
  const envelope = harness.showReply();
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  return envelope;
}

test('fresh local worker states finish or wait without consulting the chat reader', async (context) => {
  for (const [state, phase, reason] of [
    ['executing', 'running', 'Applying the accepted batch locally…'],
    ['waiting_lock', 'running', 'Waiting for another local task to release these files…'],
    ['awaiting_approval', 'waiting_approval', 'A command needs your approval'],
    ['blocked', 'error', 'Test refusal.'],
    ['paused', 'error', 'Test refusal.'],
    ['cancelled', 'error', 'Test refusal.'],
    ['complete', 'complete', 'Finished — no automated checks configured'],
  ]) {
    await context.test(state, async () => {
      const harness = createHarness();
      await acceptReply(harness);
      const rpc = harness.dependencies.rpc;
      harness.dependencies.rpc = async (method, params) => {
        const result = await rpc(method, params);
        if (method === 'state') {
          const snapshot = structuredClone(result);
          snapshot.workers[0].state = state;
          snapshot.workers[0].error = 'Test refusal.';
          return snapshot;
        }
        return result;
      };
      harness.worker.state = 'review';
      const before = harness.events.length;
      await harness.runner.tick();
      const events = harness.events.slice(before);
      assert.equal(events.filter((event) => event === 'state').length, 1);
      for (const mutation of [
        'page:inspect',
        'page:prepare',
        'page:commit',
        'worker.import',
        'worker.run',
        'worker.report',
      ]) {
        assert.equal(events.includes(mutation), false, mutation);
      }
      assert.equal(harness.runner.status.phase, phase);
      assert.equal(harness.runner.status.reason, reason);
      assert.equal(harness.imports.length, 1);
      assert.equal(harness.commits.length, 1);
      await harness.runner.settled();
    });
  }
});

test('completed local work retains queue rejection and human-review boundaries', async (context) => {
  await context.test('unexpected queue', async () => {
    const harness = createHarness();
    const envelope = await acceptReply(harness);
    harness.worker.state = 'review';
    harness.worker.queue = [envelope];
    const before = harness.events.length;
    await harness.runner.tick();
    assert.equal(harness.runner.status.reason, 'Unexpected queued work. Stopped rather than mixing batches.');
    assert.equal(harness.events.slice(before).includes('page:inspect'), false);
    assert.equal(harness.imports.length, 1);
    assert.equal(harness.commits.length, 1);
  });
  await context.test('human acceptance', async () => {
    const harness = createHarness();
    await acceptReply(harness);
    harness.worker.state = 'review';
    harness.worker.humanAcceptanceReady = true;
    const before = harness.events.length;
    await harness.runner.tick();
    assert.equal(harness.runner.status.phase, 'review');
    assert.equal(harness.progress().stage, 'review');
    assert.equal(harness.events.slice(before).includes('page:inspect'), false);
    assert.equal(harness.commits.length, 1);
  });
});

test('a busy report checkpoint drains through Stop without a late send or a replaced operation barrier', async () => {
  const harness = createHarness();
  await acceptReply(harness);
  harness.worker.state = 'review';
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let held = false;
  harness.configuration.beforeSave = async (progress) => {
    if (progress.stage === 'report_due' && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
  };
  const before = harness.events.length;
  const ticking = harness.runner.tick();
  await entered.promise;
  assert.equal(harness.events.slice(before).includes('page:inspect'), false);
  let settled = false;
  const settling = harness.runner.settled().then(() => {
    settled = true;
  });
  await harness.runner.tick();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(harness.events.slice(before).filter((event) => event === 'state').length, 1);
  const stopping = harness.runner.stop();
  assert.equal(harness.runner.status.active, false);
  release.resolve();
  await Promise.all([ticking, stopping, settling]);
  assert.equal(settled, true);
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.progress().phase, 'stopped');
});

test('a stopped epoch during report inspection cannot authorize a continuation send', async () => {
  const harness = createHarness();
  await acceptReply(harness);
  harness.worker.state = 'review';
  const page = harness.dependencies.page;
  harness.dependencies.page = async (tabId, request) => {
    if (request.op === 'inspect' && harness.progress().stage === 'report_due') {
      harness.worker.control = {
        version: 1,
        epoch: 1,
        mode: 'stopped',
        at: harness.now(),
        operationId: 'stop_1',
        reason: 'Stopped',
        retiredExchanges: [],
      };
    }
    return page(tabId, request);
  };
  await harness.runner.tick();
  assert.equal(harness.runner.status.errorCode, 'RUN_SUPERSEDED');
  assert.equal(harness.runner.status.active, false);
  assert.equal(harness.events.includes('worker.report'), false);
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.commits.length, 1);
});

test('prompt loading remains sequential and preserves literal bootstrap and report bytes', async () => {
  const harness = createHarness();
  const bootstrap = '  literal `bootstrap`\\source\n\tkeep whitespace  ';
  const next = 'Next `step`\\literal\n  unchanged';
  const report = 'File bytes: `code`\\path\n\t  raw';
  const rpc = harness.dependencies.rpc;
  harness.dependencies.rpc = async (method, params) => {
    const result = await rpc(method, params);
    if (method === 'worker.prompt') {
      if (params.kind === 'bootstrap') {
        return bootstrap;
      }
      return next;
    }
    if (method === 'worker.report') {
      return report;
    }
    return result;
  };
  await acceptReply(harness);
  assert.equal(
    harness.commits[0].text,
    buildExchangeMessage(bootstrap, harness.options.lastReceipt.exchangeId, harness.worker),
  );
  const before = harness.events.length;
  harness.worker.state = 'review';
  await harness.runner.tick();
  const events = harness.events.slice(before);
  assert.ok(events.indexOf('save:report_due') < events.indexOf('page:inspect'));
  assert.ok(events.indexOf('page:inspect') < events.indexOf('worker.report'));
  assert.ok(events.indexOf('save:prepared') < events.indexOf('page:prepare'));
  assert.equal(
    harness.commits[1].text,
    buildExchangeMessage(
      buildReportPrompt(next, report),
      harness.options.lastReceipt.exchangeId,
      harness.worker,
    ),
  );
  assert.equal(harness.events.filter((event) => event === 'worker.prompt').length, 2);
  assert.equal(harness.imports.length, 1);
});

test('Stop while the next prompt is pending keeps startup inside the existing settle barrier', async () => {
  const harness = createHarness();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const rpc = harness.dependencies.rpc;
  harness.dependencies.rpc = async (method, params) => {
    const result = await rpc(method, params);
    if (method === 'worker.prompt' && params.kind === 'next') {
      entered.resolve();
      await release.promise;
    }
    return result;
  };
  const starting = harness.runner.start();
  const rejection = assert.rejects(starting, /Session stopped/);
  await entered.promise;
  let settled = false;
  const settling = harness.runner.settled().then(() => {
    settled = true;
  });
  const stopping = harness.runner.stop();
  await Promise.resolve();
  assert.equal(settled, false);
  release.resolve();
  await Promise.all([rejection, stopping, settling]);
  assert.equal(settled, true);
  assert.equal(harness.commits.length, 0);
  assert.equal(harness.imports.length, 0);
  assert.equal(harness.events.includes('page:prepare'), false);
});

test('reply identity changes and interrupted observations each restart the completion window', async (context) => {
  for (const interruption of ['changed reply', 'busy']) {
    await context.test(interruption, async () => {
      const harness = createHarness();
      await harness.runner.start();
      harness.showReply();
      await harness.runner.tick();
      harness.advance(1700);
      if (interruption === 'changed reply') {
        harness.showReply({ summary: 'Different bytes' });
      } else {
        harness.setView({ busy: true });
      }
      await harness.runner.tick();
      harness.setView({ busy: false });
      await harness.runner.tick();
      harness.advance(1799);
      await harness.runner.tick();
      assert.equal(harness.imports.length, 0);
      harness.advance(1);
      await harness.runner.tick();
      assert.equal(harness.imports.length, 1);
      assert.equal(harness.commits.length, 1);
    });
  }
});

test('roleless correlated code replies restart stability after interrupted reads before user-confirmation returns', async (context) => {
  for (const [interruption, changes] of [
    ['busy', { busy: true }],
    ['incomplete read', { codeReply: undefined, complete: false }],
    [
      'fragment with stale completion',
      {
        complete: true,
        codeRead: { characters: 10, fingerprint: 'f', issue: 'INVALID_JSON', incomplete: true },
      },
    ],
    ['in-progress code with stale completion', { complete: true, codeReplyIssue: 'REPLY_IN_PROGRESS' }],
    [
      'unreadable newer code with stale completion',
      { complete: true, codeReplyIssue: 'NEWER_REPLY_UNREADABLE' },
    ],
  ]) {
    await context.test(interruption, async () => {
      const harness = createHarness();
      await harness.runner.start();
      const receipt = structuredClone(harness.options.lastReceipt);
      const envelope = harness.showReply();
      const idle = {
        count: 1,
        userCount: 0,
        lastRole: '',
        assistantId: '',
        assistantText: '',
        lastUserText: '',
        lastUserId: '',
        userIds: [],
        busy: false,
        complete: false,
        codeRead: undefined,
        codeReplyIssue: undefined,
        codeReply: { ...envelope, text: JSON.stringify(envelope), format: 'code', hasCopyControl: true },
        transcript: {
          version: 'message-discovery/1',
          unclassifiedTail: false,
          scanLimited: false,
          state: 'unrecognized',
          roleAttributes: 0,
          alternativeRoles: 0,
          semanticRoles: 0,
          turnContainers: 0,
          users: 0,
          assistants: 0,
          unknownTurns: 0,
          codeBlocks: 1,
          openShadowRoots: 0,
          frames: 0,
        },
      };
      harness.setView(idle);
      await harness.runner.tick();
      assert.equal(harness.imports.length, 0);
      harness.advance(1700);
      harness.setView(changes);
      await harness.runner.tick();
      assert.equal(harness.runner.status.active, true);
      assert.equal(harness.imports.length, 0);
      harness.advance(100);
      harness.setView(idle);
      await harness.runner.tick();
      assert.equal(harness.imports.length, 0, 'An interrupted read must discard the old stability timer');
      harness.advance(1799);
      await harness.runner.tick();
      assert.equal(harness.imports.length, 0);
      harness.advance(1);
      await harness.runner.tick();
      assert.equal(harness.imports.length, 1);
      assert.deepEqual(JSON.parse(harness.imports[0].text), envelope);
      assert.deepEqual(harness.options.lastReceipt, receipt);
      assert.equal(harness.commits.length, 1);
      assert.equal(harness.events.includes('worker.report'), false);
    });
  }
});

test('an absent user observation breaks conflict stability without replaying the saved Send', async () => {
  const harness = createHarness();
  await harness.runner.start();
  harness.setView({ lastUserText: 'DO_NOT_LOG_PRIVATE_SOURCE' });
  await harness.runner.tick();
  harness.advance(1799);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, true);
  harness.setView({ lastUserText: '', lastUserId: '' });
  await harness.runner.tick();
  harness.setView({ lastUserText: 'DO_NOT_LOG_PRIVATE_SOURCE', lastUserId: 'sent_user' });
  await harness.runner.tick();
  harness.advance(1799);
  await harness.runner.tick();
  assert.equal(harness.runner.status.active, true);
  harness.advance(1);
  await harness.runner.tick();
  assert.equal(harness.runner.status.errorCode, 'CHAT_INTERVENED');
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
});

test('busy unlinked observations break stability without renewing the overall correction wait', async () => {
  const harness = createHarness();
  await harness.runner.start();
  const envelope = {
    protocol: 'mitter/1',
    id: 'unlinked_1',
    replyTo: 'older_exchange',
    workerId: harness.worker.id,
    projectId: harness.worker.projectId,
    summary: 'Unlinked reply',
    actions: [{ type: 'list', path: '.' }],
  };
  harness.setView({
    unlinkedReply: { ...envelope, text: JSON.stringify(envelope), hasCopyControl: true },
    codeReplyIds: [envelope.id],
  });
  await harness.runner.tick();
  harness.advance(5000);
  harness.setView({ busy: true });
  await harness.runner.tick();
  harness.setView({ busy: false });
  await harness.runner.tick();
  harness.advance(7001);
  await harness.runner.tick();
  assert.equal(harness.runner.status.errorCode, 'REPLY_LINK_MISSING');
  assert.equal(harness.runner.status.monitoring, true);
  assert.equal(harness.progress().formatRepairs, 0);
  assert.equal(harness.events.includes('worker.report'), false);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.imports.length, 0);
});

test('reader diagnostics deduplicate independently and never log compared user source', async () => {
  const harness = createHarness({
    view: {
      disclosure: { state: 'expanded', attempts: 1 },
      transcript: {
        version: 'message-discovery/1',
        unclassifiedTail: false,
        scanLimited: false,
        state: 'ready',
        roleAttributes: 1,
        alternativeRoles: 0,
        semanticRoles: 0,
        turnContainers: 1,
        users: 1,
        assistants: 0,
        unknownTurns: 0,
        codeBlocks: 0,
        openShadowRoots: 0,
        frames: 0,
        codeAncestry: [[{ tag: 'pre', attributes: ['data-testid'] }]],
      },
    },
  });
  const logs = [];
  harness.dependencies.log = (kind, message) => logs.push({ kind, message });
  await harness.runner.start();
  await harness.runner.tick();
  await harness.runner.tick();
  const observationKinds = [
    'bridge.reply.observe',
    'bridge.user.disclosure',
    'bridge.location',
    'bridge.transcript',
    'bridge.reader.shape',
    'bridge.user.observe',
  ];
  const counts = observationKinds.map((kind) => logs.filter((entry) => entry.kind === kind).length);
  for (const count of counts) {
    assert.ok(count > 0);
  }
  await harness.runner.tick();
  await harness.runner.tick();
  assert.deepEqual(
    observationKinds.map((kind) => logs.filter((entry) => entry.kind === kind).length),
    counts,
  );
  harness.setView({ lastUserText: 'DO_NOT_LOG_PRIVATE_SOURCE' });
  await harness.runner.tick();
  await harness.runner.tick();
  const comparisons = logs.filter((entry) => entry.kind === 'bridge.user.compare');
  assert.equal(comparisons.length, 1);
  assert.equal(JSON.parse(comparisons[0].message).observedMatchesText, false);
  for (const entry of logs) {
    assert.equal(entry.message.includes('DO_NOT_LOG_PRIVATE_SOURCE'), false);
  }
});

test('structural and direct-code diagnostic keys retain reply identity across report sends', async () => {
  const harness = createHarness({
    view: {
      assistantReadStats: {
        extractor: 'logical-pre/4-user-turn/6-discovery/3-code-reply/5-send/2-control/1',
        preElements: 1,
        visiblePreElements: 1,
        nestedWrappers: 0,
        ignoredHiddenBlocks: 0,
        emptyBlocks: 0,
        logicalBlocks: 1,
        payloadCharacters: [100],
      },
      disclosure: { state: 'expanded', attempts: 1 },
    },
  });
  const logs = [];
  harness.dependencies.log = (kind, message) => logs.push({ kind, message });
  await harness.runner.start();
  for (const id of ['reply_1', 'reply_2']) {
    const envelope = harness.showReply({ id });
    harness.setView({
      codeReply: {
        ...envelope,
        text: JSON.stringify(envelope),
        format: 'code',
        hasCopyControl: true,
      },
    });
    await harness.runner.tick();
    harness.advance(1800);
    await harness.runner.tick();
    if (id === 'reply_1') {
      harness.worker.state = 'review';
      await harness.runner.tick();
    }
  }
  assert.equal(harness.imports.length, 2);
  assert.equal(harness.commits.length, 2);
  assert.equal(logs.filter((entry) => entry.kind === 'bridge.reply.structure').length, 2);
  assert.equal(logs.filter((entry) => entry.kind === 'bridge.reply.code').length, 2);
  assert.equal(logs.filter((entry) => entry.kind === 'bridge.user.disclosure').length, 1);
  assert.equal(logs.filter((entry) => entry.kind === 'bridge.location').length, 1);
});
