import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';
const { ResetViewBarrier, RESET_VIEW_PARAM } = await import('../reset-views.ts');

test('reset-view identity comes from the independent marked context, not an acknowledgement claim', async (t) => {
  const pageURL = 'chrome-extension://miter/sidepanel.html';
  const messages = [];
  let markedURL = pageURL;
  const port = {
    sender: { url: pageURL },
    postMessage(message) {
      messages.push(message);
      if (message.type === 'reset-quiesce') {
        markedURL = pageURL + '?' + RESET_VIEW_PARAM + '=' + message.id;
      }
      if (message.type === 'reset-identified') {
        markedURL = pageURL;
      }
    },
  };
  const barrier = new ResetViewBarrier(
    [pageURL],
    async () => [
      {
        contextId: 'real-context',
        documentId: 'real-document',
        documentUrl: markedURL,
      },
    ],
    1000,
  );
  t.after(() => barrier.dispose());
  barrier.add(port);
  const pending = barrier.quiesce(port);
  assert.equal(barrier.quiesce(port), pending);
  assert.equal(messages[0].identify, true);
  assert.equal(
    barrier.receive(port, {
      type: 'reset-ack',
      id: messages[0].id,
      ok: true,
      documentId: 'self-reported-document',
    }),
    true,
  );
  await pending;
  await barrier.quiesceAll();
  assert.deepEqual(
    messages.map((message) => message.type),
    ['reset-quiesce', 'reset-identified'],
  );
});

test('a shared page URL cannot prove identity, and an acknowledged document cannot prove its replacement', async (t) => {
  const pageURL = 'chrome-extension://miter/sidepanel.html';
  const messages = [];
  let documentId = 'document-1';
  const port = {
    sender: { url: pageURL, documentId },
    postMessage: (message) => messages.push(message),
  };
  const barrier = new ResetViewBarrier(
    [pageURL],
    async () => [
      {
        contextId: 'context-1',
        documentId,
        documentUrl: pageURL,
      },
    ],
    1000,
  );
  t.after(() => barrier.dispose());
  barrier.add(port);
  const pending = barrier.quiesce(port);
  barrier.receive(port, { type: 'reset-ack', id: messages[0].id, ok: true });
  await pending;
  documentId = 'document-2';
  await assert.rejects(barrier.quiesceAll(), /cannot confirm it stopped writing/);
  const unconnected = new ResetViewBarrier([pageURL], async () => [{ documentUrl: pageURL }], 1000);
  t.after(() => unconnected.dispose());
  await assert.rejects(unconnected.quiesceAll(), /cannot confirm it stopped writing/);
});

test('malformed browser inventories cannot authorize reset or pin document proof', async (context) => {
  for (const inventory of [undefined, null, {}, [null], [{ documentUrl: 1 }], [{ contextId: false }]]) {
    await context.test(JSON.stringify(inventory), async (t) => {
      const pageURL = 'chrome-extension://miter/sidepanel.html';
      const messages = [];
      const port = {
        sender: { url: pageURL, documentId: 'document-1' },
        postMessage: (message) => messages.push(message),
      };
      const barrier = new ResetViewBarrier([pageURL], async () => inventory, 1000);
      t.after(() => barrier.dispose());
      await assert.rejects(barrier.quiesceAll(), /invalid.*inventory/i);
      barrier.add(port);
      const pending = barrier.quiesce(port);
      const rejected = assert.rejects(pending, /invalid.*inventory/i);
      barrier.receive(port, { type: 'reset-ack', id: messages[0].id, ok: true });
      await rejected;
      assert.equal(
        messages.some((message) => message.type === 'reset-identified'),
        false,
      );
    });
  }
});

test('disconnecting during reset identification cannot leave a stale document proof', async (t) => {
  const pageURL = 'chrome-extension://miter/sidepanel.html';
  const messages = [];
  let barrier;
  const port = {
    sender: { url: pageURL, documentId: 'document-1' },
    postMessage(message) {
      messages.push(message);
      if (message.type === 'reset-identified') {
        barrier.remove(port);
      }
    },
  };
  barrier = new ResetViewBarrier(
    [pageURL],
    async () => [
      {
        contextId: 'context-1',
        documentId: 'document-1',
        documentUrl: pageURL,
      },
    ],
    1000,
  );
  t.after(() => barrier.dispose());
  barrier.add(port);
  const pending = barrier.quiesce(port);
  const rejected = assert.rejects(pending, /disconnected/);
  barrier.receive(port, { type: 'reset-ack', id: messages[0].id, ok: true });
  await rejected;
  await assert.rejects(barrier.quiesceAll(), /cannot confirm it stopped writing/);
});
