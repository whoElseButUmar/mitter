import { TRANSITIONS } from '../core/workflow.js';
import type { WorkflowFactory } from '../core/types.js';
import type { WorkerState } from '../../../../packages/protocol/src/index.js';
/** The import is intentionally deferred: `--portable` never silently pretends to run XState. */
export async function loadXStateWorkflow(): Promise<WorkflowFactory> {
  const moduleName = 'xstate';
  const { createMachine, createActor } = await import(moduleName);
  return (initial, onChange) => {
    const states = Object.fromEntries(Object.entries(TRANSITIONS).map(([state, targets]) => [state, {
      on: Object.fromEntries(targets.map(target => [`GO_${target}`, { target }]))
    }]));
    const actor = createActor(createMachine({id:'mitter-worker',initial,states}));
    actor.subscribe((snapshot: {value: unknown}) => onChange(snapshot.value as WorkerState));
    actor.start();
    return {
      get:()=>actor.getSnapshot().value as WorkerState,
      move(next) {
        const current = actor.getSnapshot().value as WorkerState;
        if (current === next) return;
        if (!TRANSITIONS[current].includes(next)) throw new Error(`Invalid transition ${current} → ${next}.`);
        actor.send({type:`GO_${next}`});
      },
      stop:()=>actor.stop(),
    };
  };
}
