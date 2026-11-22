import { Buffer } from 'node:buffer';
import path from 'node:path';
import { z } from 'zod';
import type { Action, Envelope, Worker } from '../../../../../packages/protocol/src/index.js';
import {
  MAX_IMAGE_BASE64_CHARS,
  workerStageImageParamsSchema,
} from '../../../../../packages/protocol/src/rpc.js';
import { MAX_IMAGE_BYTES } from '../../../../../packages/protocol/src/schemas/image-attachments.js';
import { parseTaskProgress, progressKey } from '../../../../../packages/bridge/src/progress.js';
import type { Store } from '../database.js';

const ownershipSchema = workerStageImageParamsSchema.pick({
  envelopeId: true,
  exchangeId: true,
  index: true,
  contentType: true,
  total: true,
});

const stagedImageSchema = ownershipSchema
  .extend({
    runId: z.string().describe('The task run that owns the image.'),
    payload: z.string().max(MAX_IMAGE_BASE64_CHARS).describe('Base64 received so far.'),
  })
  .describe('One durable image upload slot for an active task.');

const extensions = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function imageSlot(worker: Worker, index: number): string {
  return `miter.generatedImage.${worker.id}.${index}`;
}

export function stageGeneratedImage(
  store: Store,
  worker: Worker,
  input: z.infer<typeof workerStageImageParamsSchema>,
): { received: number } {
  const progress = parseTaskProgress(store.get(progressKey(worker.id)));
  if (
    worker.mode !== 'handoff' ||
    worker.queue.length ||
    !progress ||
    !['commit_intent', 'waiting_reply'].includes(progress.stage) ||
    progress.lastReceipt?.exchangeId !== input.exchangeId ||
    progress.lastReceipt.expectsReplyTo !== true ||
    worker.control?.retiredExchanges.includes(input.exchangeId)
  ) {
    throw new Error('This image does not belong to the current reply.');
  }

  const end = input.offset + input.data.length;
  if (
    input.total % 4 ||
    input.offset % 4 ||
    input.data.length % 4 ||
    end > input.total ||
    (end < input.total && input.data.includes('='))
  ) {
    throw new Error('Image upload is outside its declared length.');
  }

  const slot = imageSlot(worker, input.index);
  const previous = store.get(slot, stagedImageSchema.nullable());
  const owner = ownershipSchema.parse(input);
  let payload = '';
  if (
    previous?.runId === worker.runId &&
    previous.envelopeId === input.envelopeId &&
    previous.exchangeId === input.exchangeId
  ) {
    if (previous.total !== input.total || previous.contentType !== input.contentType) {
      throw new Error('A retry supplied different image metadata.');
    }
    payload = previous.payload;
  }

  if (input.offset < payload.length && payload.slice(input.offset, end) === input.data) {
    return { received: end };
  }
  if (input.offset !== payload.length) {
    throw new Error('An image chunk was repeated with different bytes or arrived out of order.');
  }
  store.set(slot, { ...owner, runId: worker.runId, payload: payload + input.data });
  return { received: end };
}

type ImageAction = Extract<Action, { type: 'saveImage' }>;

export function stagedGeneratedImage(store: Store, worker: Worker, batch: Envelope, action: ImageAction) {
  if (action.source.type !== 'generated') {
    throw new Error('Only ChatGPT-generated images use the browser upload.');
  }
  const image = store.get(imageSlot(worker, action.source.index), stagedImageSchema.nullable());
  if (
    !image ||
    image.runId !== worker.runId ||
    image.envelopeId !== batch.id ||
    image.exchangeId !== batch.replyTo ||
    image.payload.length !== image.total
  ) {
    throw new Error(
      'The generated image is missing from this reply. Import it from the linked ChatGPT chat.',
    );
  }

  const bytes = Buffer.from(image.payload, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== image.payload) {
    throw new Error('ChatGPT returned invalid image bytes.');
  }
  const requested = path.posix.extname(action.path);
  const extension = extensions[image.contentType];
  let filename = action.path;
  const requestedExtension = requested.toLowerCase();
  if (requestedExtension !== extension && !(extension === '.jpg' && requestedExtension === '.jpeg')) {
    filename = action.path.slice(0, action.path.length - requested.length) + extension;
  }
  return { bytes, path: filename };
}

export function clearGeneratedImages(store: Store, worker: Worker, batch: Envelope): void {
  for (const action of batch.actions) {
    if (action.type === 'saveImage' && action.source.type === 'generated') {
      const slot = imageSlot(worker, action.source.index);
      const image = store.get(slot, stagedImageSchema.nullable());
      if (image?.envelopeId === batch.id && image.runId === worker.runId) {
        store.set(slot, null);
      }
    }
  }
}
