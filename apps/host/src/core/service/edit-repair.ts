import type { Envelope } from '../../../../../packages/protocol/src/index.js';
import type { Journal } from '../database.js';
import type { EditConflict } from '../edit-plan.js';
import type { EditRepair, EditRepairObservation, RepairFileEvidence } from './schemas.js';

export function buildEditRepair(
  batch: Envelope,
  cursor: number,
  pending: Envelope[],
  error: EditConflict,
  current: RepairFileEvidence,
  writes: Journal[],
): EditRepair {
  let failedIndex = cursor;

  if (error.index >= 0) {
    failedIndex = error.index;
  }

  const discarded = pending.map((queuedBatch, index) => {
    let remainingActions = queuedBatch.actions.length;

    if (index === 0) {
      remainingActions -= cursor;
    }

    return { batchId: queuedBatch.id, remainingActions };
  });

  return {
    code: error.code,
    batchId: batch.id,
    actionIndex: failedIndex,
    path: error.path,
    message: error.message,
    current,
    applied: writes
      .filter((write) => write.id.startsWith(batch.id + '_') && write.status === 'applied')
      .map((write) => ({
        actionId: write.id,
        path: write.path,
        hash: write.afterHash,
      })),
    discarded,
    next:
      'The unapplied remainder has been set aside, NOT executed. Preserve successful edits. ' +
      'Read current files and return a new minimal batch with fresh hashes. ' +
      'Do not replay completed actions ' +
      'or claim completion. Commands and goal checks were not run by this repair.',
  };
}

export function encodeRepairObservation(repair: EditRepair): string {
  const observation: EditRepairObservation = {
    ...repair,
    current: { ...repair.current },
    applied: [...repair.applied],
    discarded: [...repair.discarded],
    appliedOmitted: 0,
    discardedOmitted: 0,
  };
  const encode = (): string => JSON.stringify({ editRepair: observation });

  if (encode().length > 12000 && 'content' in observation.current) {
    delete observation.current.content;
    observation.current.contentOmitted = true;
  }

  while (encode().length > 12000 && observation.applied.length > 0) {
    observation.applied.pop();
    observation.appliedOmitted++;
  }

  while (encode().length > 12000 && observation.discarded.length > 0) {
    observation.discarded.pop();
    observation.discardedOmitted++;
  }

  return encode();
}
