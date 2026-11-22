import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

test('a dedicated image request selects image mode once, then continues with an ordinary project reply', async () => {
  const harness = createHarness({ worker: { goal: 'Generate an illustration of a crater.' } });
  const page = harness.dependencies.page;
  const sends = [];
  harness.dependencies.page = async (tabId, request) => {
    if (request.op === 'commit') {
      sends.push(request);
    }
    return page(tabId, request);
  };
  await harness.runner.start();
  harness.showReply({
    actions: [{ type: 'generateImage', prompt: 'A cream and blue lunar crater, no lettering.' }],
  });
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(sends.length, 2);
  assert.equal(sends[0].imageMode, undefined);
  assert.equal(sends[1].imageMode, true);
  const receipt = harness.progress().lastReceipt;
  assert.equal(receipt.imageMode, true);
  assert.equal(receipt.expectsReplyTo, undefined);
  assert.match(sends[1].text, /^Create one image\. A cream and blue lunar crater/);
  assert.ok(sends[1].text.includes(receipt.exchangeId));
  assert.equal(harness.imports.length, 0);

  harness.setView({
    assistantId: 'generated-art',
    assistantText: '',
    lastRole: 'assistant',
    busy: true,
    complete: false,
  });
  await harness.runner.tick();
  assert.equal(sends.length, 2);
  harness.setView({ busy: false, complete: true, generatedImageCount: 1 });
  await harness.runner.tick();
  harness.advance(3600);
  await harness.runner.tick();
  assert.equal(sends.length, 3);
  assert.equal(sends[2].imageMode, undefined);
  assert.match(sends[2].text, /preceding response are ready/);
  assert.equal(harness.progress().imageSourceReceipt.exchangeId, receipt.exchangeId);
  assert.equal(harness.imports.length, 0);
  await harness.runner.stop();
  await harness.runner.settled();
});

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
