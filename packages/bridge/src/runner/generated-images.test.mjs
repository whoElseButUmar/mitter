import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

test('one task continues an image-only reply and stages the exact earlier image before importing both assets', async () => {
  const harness = createHarness({ worker: { goal: 'Find a photo and generate a small illustration.' } });
  const page = harness.dependencies.page;
  const rpc = harness.dependencies.rpc;
  const imageReads = [];
  const uploads = [];
  const base64 = 'AAAA'.repeat(125_000);
  await harness.runner.start();
  const source = harness.progress().lastReceipt;
  harness.dependencies.page = async (tabId, request) => {
    if (request.op !== 'read_generated_image') {
      return page(tabId, request);
    }
    imageReads.push(request);
    const view = await page(tabId, { ...request, op: 'inspect' });
    if (request.replyTo === source.exchangeId) {
      return { ...view, generatedImage: { base64, contentType: 'image/webp' } };
    }
    return { ...view, generatedImageIssue: 'missing' };
  };
  harness.dependencies.rpc = async (method, input) => {
    if (method === 'worker.stageImage') {
      uploads.push(input);
      return { received: input.offset + input.data.length };
    }
    return rpc(method, input);
  };

  harness.setView({
    count: 2,
    lastRole: 'assistant',
    assistantId: 'image-only',
    assistantText: '',
    complete: true,
    generatedImageCount: 1,
  });
  await harness.runner.tick();
  harness.advance(3600);
  await harness.runner.tick();
  assert.equal(harness.commits.length, 2);
  assert.match(harness.commits[1].text, /preceding response are ready/);
  assert.equal(harness.progress().imageSourceReceipt.exchangeId, source.exchangeId);

  const envelope = harness.showReply({
    actions: [
      {
        type: 'saveImage',
        path: 'images/photo.jpg',
        source: { type: 'web', url: 'https://example.com/photo.jpg' },
      },
      { type: 'saveImage', path: 'images/art.png', source: { type: 'generated', index: 1 } },
    ],
  });
  harness.setView({ generatedImageCount: undefined });
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  assert.equal(harness.commits.length, 2);
  assert.deepEqual(
    imageReads.map(({ replyTo }) => replyTo),
    [envelope.replyTo, source.exchangeId],
  );
  assert.deepEqual(
    uploads.map(({ offset }) => offset),
    [0, 400_000],
  );
  assert.equal(uploads.map(({ data }) => data).join(''), base64);
  assert.ok(
    uploads.every(
      ({ envelopeId, exchangeId }) => envelopeId === envelope.id && exchangeId === envelope.replyTo,
    ),
  );
  assert.deepEqual(JSON.parse(harness.imports[0].text), envelope);
});
