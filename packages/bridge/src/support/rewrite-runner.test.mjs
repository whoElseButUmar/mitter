import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';

import { chatLink, chatView } from './fixtures.mjs';
const { RewriteRunner } = await import('../rewrite-runner.ts');
const { PageBridgeError } = await import('../page-transport.ts');

function rewriteHarness({ probe, prepare, commit, inspect, stop, composerSession = 'document-ledger' } = {}) {
  let time = 0;
  let prompt = '';
  const calls = [];
  const resultText = JSON.stringify({
    protocol: 'miter-rewrite/1',
    requestId: 'rewrite_1',
    text: 'Improved draft',
  });
  const page = async (tabId, request) => {
    calls.push({ tabId, ...request });
    if (request.op === 'probe') {
      if (probe) {
        return probe(request, calls);
      }
      return chatView({ url: 'https://chatgpt.com', count: 0 });
    }
    if (request.op === 'prepare') {
      prompt = request.text;
      if (prepare) {
        return prepare(request, calls);
      }
      const view = chatView({ url: 'https://chatgpt.com', outcome: 'prepared' });
      if (composerSession !== null) {
        view.composerSession = composerSession;
      }
      return view;
    }
    if (request.op === 'commit') {
      if (commit) {
        return commit(request, calls);
      }
      return chatView({ outcome: 'clicked' });
    }
    if (request.op === 'inspect') {
      const view = chatView({
        lastUserText: prompt,
        assistantText: resultText,
        complete: true,
      });
      if (inspect) {
        return inspect(view, request, calls);
      }
      return view;
    }
    if (request.op === 'stop' && stop) {
      return stop(request, calls);
    }
    return chatView();
  };
  const runner = new RewriteRunner(
    'rewrite_1',
    7,
    {
      instruction: 'Original draft',
      mode: 'clarity',
      provider: 'chatgpt',
    },
    page,
    () => time,
    async (delayMs) => {
      time += delayMs;
    },
  );
  return { runner, calls };
}

test('rewrite execution is shared, binds the conversation and waits for a stable complete reply', async () => {
  const { runner, calls } = rewriteHarness();
  const running = runner.run();
  assert.equal(runner.run(), running);
  await running;
  await runner.settled();
  assert.equal(runner.id, 'rewrite_1');
  assert.equal(runner.tabId, 7);
  assert.equal(runner.result.state, 'done');
  assert.equal(runner.result.text, 'Improved draft');
  assert.deepEqual(
    calls.map((call) => call.op),
    ['probe', 'prepare', 'commit', 'inspect', 'inspect', 'inspect', 'stop'],
  );
  assert.equal(calls[1].allowConversationBind, false);
  assert.equal(calls[2].allowConversationBind, true);
  assert.equal(calls[4].url, chatLink.url);
  assert.equal(calls.at(-1).url, chatLink.url);
});

test('ambiguous rewrite commits without a ledger or from a changed document are inspected, not resent', async (t) => {
  for (const [composerSession, error] of [
    [undefined, new PageBridgeError('BRIDGE_TIMEOUT', 'Lost acknowledgement', true)],
    ['document-ledger', new PageBridgeError('COMMIT_DOCUMENT_CHANGED', 'Changed document', true)],
    ['document-ledger', new Error('Unknown send outcome')],
  ]) {
    await t.test(error.message + ', ledger=' + composerSession, async () => {
      const harness = rewriteHarness({
        composerSession: composerSession ?? null,
        commit: async () => {
          throw error;
        },
      });
      await harness.runner.run();
      assert.equal(harness.calls.filter((call) => call.op === 'commit').length, 1);
      assert.equal(harness.runner.result.state, 'done');
      assert.equal(harness.calls.at(-1).op, 'stop');
    });
  }
});

test('rewrite commit retries reuse the exact bytes, message ID, nonce and document ledger', async () => {
  let commits = 0;
  const harness = rewriteHarness({
    commit: async () => {
      if (++commits === 1) {
        throw new PageBridgeError('SEND_NOT_READY', 'Wait for Send');
      }
      return chatView({ outcome: 'clicked' });
    },
  });
  await harness.runner.run();
  const requests = harness.calls.filter((call) => call.op === 'commit');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(harness.runner.result.state, 'done');
});

test('cancelling a pending rewrite page call prevents preparation and still drains the composer job', async () => {
  const probe = Promise.withResolvers();
  const calls = [];
  const runner = new RewriteRunner(
    'rewrite_1',
    7,
    {
      instruction: 'Original draft',
      mode: 'clarity',
      provider: 'chatgpt',
    },
    async (_tabId, request) => {
      calls.push(request.op);
      if (request.op === 'probe') {
        return probe.promise;
      }
      return chatView();
    },
  );
  const running = runner.run();
  runner.cancel();
  probe.resolve(chatView({ count: 0 }));
  await running;
  await runner.settled();
  assert.equal(runner.result.state, 'cancelled');
  assert.equal(runner.result.error, 'Rewrite cancelled.');
  assert.deepEqual(calls, ['probe', 'stop', 'stop']);
});

test('rewrite cancellation is idempotent and settled drains its Stop even before execution starts', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const harness = rewriteHarness({
    stop: async () => {
      entered.resolve();
      await release.promise;
      return chatView();
    },
  });
  harness.runner.cancel();
  await entered.promise;
  harness.runner.cancel();
  let settled = false;
  const settling = harness.runner.settled().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(settled, false, 'Cancellation Stop is still in flight');
    assert.equal(harness.calls.filter((call) => call.op === 'stop').length, 1);
  } finally {
    release.resolve();
    await settling;
  }
  assert.equal(harness.runner.result.state, 'cancelled');
  assert.equal(
    harness.calls.some((call) => ['prepare', 'commit'].includes(call.op)),
    false,
  );
});

test('rewrite cancellation drains a rejected Stop without exposing an unhandled rejection', async () => {
  const harness = rewriteHarness({
    stop: async () => {
      throw new Error('Page channel disconnected.');
    },
  });
  harness.runner.cancel();
  await harness.runner.settled();
  assert.equal(harness.runner.result.state, 'cancelled');
  assert.equal(harness.calls.filter((call) => call.op === 'stop').length, 1);
});

test('malformed rewrite page observations never authorize Send or replace the original draft', async (context) => {
  for (const [operation, result] of [
    ['probe', undefined],
    ['probe', chatView({ count: -1 })],
    ['prepare', chatView({ outcome: 'prepared', draft: 'false' })],
    ['inspect', chatView({ complete: 'true' })],
  ]) {
    await context.test(operation + ': ' + JSON.stringify(result), async () => {
      const harness = rewriteHarness({ [operation]: async () => result });
      await harness.runner.run();
      assert.equal(harness.runner.result.state, 'error');
      assert.equal(harness.runner.result.text, undefined);
      assert.match(harness.runner.result.error, /invalid state/i);
      assert.equal(harness.calls.at(-1).op, 'stop');
      if (operation !== 'inspect') {
        assert.equal(
          harness.calls.some((call) => call.op === 'commit'),
          false,
        );
      }
    });
  }
});

test('malformed rewrite commit acknowledgements are inspected rather than replayed', async () => {
  const harness = rewriteHarness({ commit: async () => chatView({ outcome: 'sent_maybe' }) });
  await harness.runner.run();
  assert.equal(harness.calls.filter((call) => call.op === 'commit').length, 1);
  assert.equal(harness.runner.result.state, 'done');
});

test('a user draft in the rewrite chat remains a write barrier and still stops the composer job', async () => {
  const harness = rewriteHarness({
    inspect: (view) => ({
      ...view,
      draft: true,
      draftText: 'My different draft',
    }),
  });
  await harness.runner.run();
  assert.equal(harness.runner.result.state, 'error');
  assert.equal(harness.runner.result.error, 'A draft appeared in the rewrite chat. Nothing was overwritten.');
  assert.equal(harness.calls.at(-1).op, 'stop');
  assert.equal(harness.calls.filter((call) => call.op === 'commit').length, 1);
});
