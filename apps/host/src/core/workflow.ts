import type { WorkerState } from '../../../../packages/protocol/src/index.js';
import type { WorkflowFactory } from './types.js';
/** One declarative graph drives both XState (production) and the dependency-free conformance runner. */
export const TRANSITIONS: Record<WorkerState, WorkerState[]> = {
  idle: ['queued','planning','cancelled','paused'],
  queued: ['planning','waiting_lock','executing','paused','cancelled','blocked'],
  planning: ['waiting_model','waiting_lock','executing','paused','blocked','cancelled'],
  waiting_model: ['waiting_lock','executing','paused','blocked','cancelled'],
  waiting_lock: ['executing','verifying','paused','blocked','cancelled'],
  executing: ['waiting_lock','planning','queued','verifying','awaiting_approval','paused','blocked','review','complete','cancelled'],
  verifying: ['waiting_lock','executing','awaiting_approval','planning','queued','review','complete','paused','blocked','cancelled'],
  awaiting_approval: ['queued','planning','paused','blocked','cancelled'],
  paused: ['queued','planning','idle','blocked','cancelled'],
  review: ['queued','planning','complete','paused','cancelled'],
  blocked: ['queued','planning','paused','cancelled'],
  complete: ['queued','planning','paused','cancelled'],
  cancelled: ['queued','planning','paused'],
};
export const referenceWorkflow: WorkflowFactory = (initial,onChange) => {
  let current = initial;
  return { get:()=>current, move(next) {
    if (next === current) return;
    if (!TRANSITIONS[current].includes(next)) throw new Error(`Invalid transition ${current} → ${next}.`);
    current = next; onChange(next);
  }, stop() {} };
};
