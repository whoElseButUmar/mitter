import { TRANSITIONS } from '../core/workflow.js';
import { workerStateSchema } from '../core/storage-schemas.js';
import type { WorkflowFactory } from '../core/types.js';

/** Portable mode uses its explicit reference graph, never a simulated XState adapter. */

export async function loadXStateWorkflow(): Promise<WorkflowFactory> {
  const { createActor, createMachine } = await import('xstate');

  return (initial, onChange) => {
    const states = Object.fromEntries(
      Object.entries(TRANSITIONS).map(([state, targets]) => [
        state,
        {
          on: Object.fromEntries(
            targets.map((target) => [
              `GO_${target}`,
              {
                target,
              },
            ]),
          ),
        },
      ]),
    );
    const actor = createActor(
      createMachine({
        id: 'mitter-worker',
        initial,
        states,
      }),
    );
    actor.subscribe((snapshot) => onChange(workerStateSchema.parse(snapshot.value)));
    actor.start();

    return {
      get() {
        return workerStateSchema.parse(actor.getSnapshot().value);
      },
      move(next) {
        const current = workerStateSchema.parse(actor.getSnapshot().value);

        if (current === next) {
          return;
        }

        if (!TRANSITIONS[current].includes(next)) {
          throw new Error(`Invalid transition ${current} → ${next}.`);
        }
        actor.send({
          type: `GO_${next}`,
        });
      },
      stop() {
        actor.stop();
      },
    };
  };
}
