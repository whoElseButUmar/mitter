import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  imageAttachmentsSchema,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
} from '../src/schemas/image-attachments.js';
import { parseFollowup } from '../src/requests.js';
import { coreRpcRegistry, parseRpcParams } from '../src/rpc.js';

function reference() {
  return { id: randomUUID(), name: 'Screenshot.png', type: 'image/png', size: MAX_IMAGE_BYTES };
}

test('image attachment references are bounded metadata and preserve file order', () => {
  const images = Array.from({ length: MAX_IMAGE_ATTACHMENTS }, reference);
  assert.deepEqual(imageAttachmentsSchema.parse(images), images);
  assert.equal(imageAttachmentsSchema.safeParse([...images, reference()]).success, false);
  assert.equal(imageAttachmentsSchema.safeParse([images[0], images[0]]).success, false);
  for (const invalid of [
    { ...reference(), name: '/tmp/image.png' },
    { ...reference(), type: 'image/svg+xml' },
    { ...reference(), size: MAX_IMAGE_BYTES + 1 },
    { ...reference(), data: 'unexpected image bytes' },
  ]) {
    assert.equal(imageAttachmentsSchema.safeParse([invalid]).success, false);
  }
});

test('task and follow-up RPCs preserve image references and legacy text-only shape', () => {
  const imageAttachments = [reference()];
  const creation = parseRpcParams(coreRpcRegistry, 'worker.create', {
    projectId: 'project',
    goal: 'Match the screenshot.',
    mode: 'handoff',
    imageAttachments,
  });
  assert.deepEqual(creation.imageAttachments, imageAttachments);
  const request = { id: 'followup', instruction: 'Match this screenshot.' };
  assert.deepEqual(parseFollowup(request), { ...request, autoStart: true });
  assert.deepEqual(parseFollowup({ ...request, imageAttachments: [] }), parseFollowup(request));
  assert.deepEqual(parseFollowup({ ...request, imageAttachments }).imageAttachments, imageAttachments);
  for (const method of ['worker.followup', 'worker.steerValidate', 'worker.steer']) {
    const validated = parseRpcParams(coreRpcRegistry, method, {
      workerId: 'worker',
      request: { ...request, imageAttachments },
    });
    assert.deepEqual(validated.request.imageAttachments, imageAttachments);
  }
});
