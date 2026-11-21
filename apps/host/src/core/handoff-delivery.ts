import { z } from 'zod';
import { sha256Schema } from './storage-schemas.js';
import type { Worker } from '../../../../packages/protocol/src/index.js';
import { Store } from './database.js';

/** Body-free receipt, persisted in the SAME transaction as import. This is
 * acknowledgement recovery, not permission to run a different/stopped plan. */

export const handoffDeliverySchema = z
  .object({
    version: z.literal(1).describe('The body-free handoff delivery receipt format version.'),
    workerId: z.string().describe('The task that accepted this exact handoff.'),
    projectId: z.string().describe('The registered project owning the accepted task.'),
    runId: z.string().describe('The exact post-import run authorized by this receipt.'),
    epoch: z
      .number()
      .int()
      .nonnegative()
      .describe('The nonnegative control epoch that accepted the handoff.'),
    hash: sha256Schema.describe('The digest of the exact parsed envelope, retaining literal source strings.'),
    started: z.boolean().describe('Whether start intent was saved before scheduling any action.'),
  })
  .describe('Body-free import receipt bound to an exact envelope, run, epoch and digest.');

export type HandoffDelivery = z.infer<typeof handoffDeliverySchema>;

export const deliveryKey = (envelopeId: string) => 'miter.handoffDelivery.v1.' + envelopeId;

export function setupResultKey(worker: Worker, exchangeId: string): string {
  return (
    'miter.setupResult.' +
    JSON.stringify([worker.id, worker.projectId, worker.runId, worker.control?.epoch ?? 0, exchangeId])
  );
}

export function recordSetupResult(store: Store, worker: Worker): void {
  const batch = worker.queue[0];
  if (worker.mode === 'handoff' && batch?.replyTo) {
    store.set(setupResultKey(worker, batch.replyTo), batch.id);
  }
}

/** A linked exchange gets one admission, or can be retired before admission. */
export const exchangeKey = (workerId: string, exchangeId: string) =>
  'miter.handoffExchange.' + JSON.stringify([workerId, exchangeId]);

export function matchingDelivery(
  store: Store,
  worker: Worker,
  envelopeId: string,
  hash: string,
): HandoffDelivery {
  const delivery = store.get(deliveryKey(envelopeId), handoffDeliverySchema);

  if (
    !delivery ||
    delivery.version !== 1 ||
    store.envelopeOwner(envelopeId) !== worker.id ||
    delivery.workerId !== worker.id ||
    delivery.projectId !== worker.projectId ||
    delivery.runId !== worker.runId ||
    delivery.epoch !== (worker.control?.epoch ?? 0) ||
    delivery.hash !== hash ||
    typeof delivery.started !== 'boolean'
  ) {
    throw new Error(
      'The saved handoff acknowledgement does not match this exact batch and ' +
        'run. No actions were repeated.',
    );
  }

  return delivery;
}
