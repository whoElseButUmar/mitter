import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from './fixtures.mjs';

const { PageBridgeError } = await import('../page-transport.ts');
const images = [
  { id: '4fa35f69-92a9-4fb7-8d07-687498036e1e', name: 'first.png', type: 'image/png', size: 3 },
  { id: 'cdd9695f-6d59-4a72-a45e-96def3d04059', name: 'second.png', type: 'image/png', size: 3 },
];

function imagePage(harness) {
  const page = harness.dependencies.page;
  const staged = new Set();
  const loads = [];
  const requests = [];
  let deferred = true;
  let documentId = 'first-document';
  harness.dependencies.loadImage = async (attachment) => {
    loads.push(attachment.id);
    return 'YWJj';
  };
  harness.dependencies.page = async (tabId, request) => {
    if (request.op === 'attach_image') {
      requests.push(request);
      assert.equal(request.composerSession, documentId);
      const id = request.messageId + ':' + request.image.attachment.id;
      let outcome = 'attached';
      let readiness;
      if (request.image.base64) {
        assert.equal(request.image.base64, 'YWJj');
        assert.equal(staged.has(id), false, 'The same image must never be uploaded again.');
        staged.add(id);
        if (deferred) {
          deferred = false;
          outcome = 'pending';
          readiness = 'uploading_images';
          documentId = 'replaced-document';
        }
      } else if (!staged.has(id)) {
        outcome = 'pending';
        readiness = 'image_needed';
      }
      return { ...(await page(tabId, { ...request, op: 'inspect' })), outcome, readiness };
    }
    if (request.op === 'prepare') {
      return { ...(await page(tabId, request)), composerSession: documentId };
    }
    if (request.op === 'commit') {
      for (const image of request.imageAttachments ?? []) {
        assert.ok(
          staged.has(request.messageId + ':' + image.id),
          'Wait for every image before clicking Send.',
        );
      }
    }
    return page(tabId, request);
  };
  return { loads, requests };
}

async function sendImages(harness) {
  await harness.runner.start();
  assert.equal(harness.commits.length, 0);
  assert.equal(harness.progress().stage, 'prepared');

  for (let tick = 0; tick < 5 && !harness.commits.length; tick++) {
    harness.advance(1600);
    await harness.runner.tick();
  }
  assert.equal(harness.commits.length, 1);
}

test('the first prompt waits for every image without uploading twice after the chat document changes', async () => {
  const harness = createHarness({ worker: { imageAttachments: images } });
  const { loads, requests } = imagePage(harness);
  await sendImages(harness);
  assert.deepEqual(harness.commits[0].imageAttachments, images);
  assert.match(harness.commits[0].text, /BOOTSTRAP/);
  assert.deepEqual(harness.progress().lastReceipt.imageAttachments, images);
  assert.deepEqual(
    loads,
    images.map(({ id }) => id),
  );
  assert.equal(new Set(requests.map(({ messageId }) => messageId)).size, 1);
  assert.equal(new Set(requests.map(({ composerSession }) => composerSession)).size, 2);

  harness.showReply();
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  assert.equal(harness.imports.length, 1);
  harness.worker.state = 'review';
  await harness.runner.tick();
  assert.equal(harness.commits.length, 2);
  assert.equal(harness.commits[1].imageAttachments, undefined);
  assert.equal(loads.length, 2);
});

test('a queued follow-up sends only its own images, then later reports are text-only', async () => {
  const earlier = createHarness();
  await earlier.runner.start();
  const prior = earlier.commits[0].text;
  const harness = createHarness({
    options: { resumeExisting: true },
    worker: {
      imageAttachments: [images[0]],
      activeFollowupId: 'next_followup',
      activeFollowupImages: [images[1]],
    },
    progress: { ...earlier.progress(), stage: 'report_due', phase: 'stopped' },
    view: { count: 1, userCount: 1, lastRole: 'user', lastUserText: prior, lastUserId: 'sent_user' },
  });
  const { loads } = imagePage(harness);
  await sendImages(harness);
  assert.deepEqual(harness.commits[0].imageAttachments, [images[1]]);
  assert.match(harness.commits[0].text, /No successful changes yet/);
  assert.deepEqual(loads, [images[1].id]);
  assert.equal(harness.progress().imageFollowupId, 'next_followup');

  harness.showReply();
  await harness.runner.tick();
  harness.advance(1800);
  await harness.runner.tick();
  harness.worker.state = 'review';
  await harness.runner.tick();
  assert.equal(harness.commits.length, 2);
  assert.equal(harness.commits[1].imageAttachments, undefined);
  assert.equal(loads.length, 1);
});

test('a follow-up that starts an unsent task includes both drafts’ images in the first message', async () => {
  const harness = createHarness({
    worker: {
      imageAttachments: [images[0]],
      activeFollowupId: 'followup',
      activeFollowupImages: [images[1]],
    },
  });
  const { loads } = imagePage(harness);
  await sendImages(harness);
  assert.deepEqual(harness.commits[0].imageAttachments, images);
  assert.deepEqual(
    loads,
    images.map(({ id }) => id),
  );
});

test('an interrupted image send before commit restores its saved image references and intent ID', async () => {
  const interrupted = createHarness({ worker: { imageAttachments: images } });
  const page = interrupted.dependencies.page;
  interrupted.dependencies.page = async (tabId, request) => {
    if (request.op === 'attach_image') {
      throw new PageBridgeError('BRIDGE_NAVIGATED', 'The chat was reloaded.', true);
    }
    return page(tabId, request);
  };
  await interrupted.runner.start();
  assert.equal(interrupted.progress().stage, 'prepared');
  assert.equal(interrupted.commits.length, 0);
  const recovered = createHarness({
    options: { resumeExisting: true },
    progress: interrupted.progress(),
    worker: interrupted.worker,
  });
  imagePage(recovered);
  await sendImages(recovered);
  assert.equal(recovered.commits[0].messageId, interrupted.progress().lastReceipt.messageId);
  assert.deepEqual(recovered.commits[0].imageAttachments, images);
});
