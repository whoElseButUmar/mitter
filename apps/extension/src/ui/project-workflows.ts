import { createSignal, onCleanup } from 'solid-js';
import { workflowStateSchema, type ProjectWorkflowState } from '../../../../packages/protocol/src/rpc';
import { errorMessage } from '../schemas/primitives';
import { callResult, type ViewRPC } from './rpc';

type WorkflowAction =
  | { kind: 'list' | 'record' | 'expect' | 'cancel' }
  | { kind: 'replay' | 'delete'; id: string }
  | { kind: 'save'; name: string; verifyAfterRestart: boolean };

export function createProjectWorkflows(projectId: string, rpc: ViewRPC) {
  const [state, setState] = createSignal<ProjectWorkflowState>();
  const [pending, setPending] = createSignal<WorkflowAction['kind']>();
  const [error, setError] = createSignal('');
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  async function run(action: WorkflowAction): Promise<boolean> {
    if (disposed || pending() || (!state() && action.kind !== 'list')) {
      return false;
    }
    const { kind, ...params } = action;
    setPending(kind);
    setError('');
    try {
      const result = await callResult(rpc, workflowStateSchema, 'workflow.' + kind, { projectId, ...params });
      if (disposed) {
        return false;
      }
      setState(result);
      return true;
    } catch (failure) {
      if (!disposed) {
        setError(errorMessage(failure));
        // A lost acknowledgement may follow a successful mutation. Read before offering actions again.
        setState(undefined);
      }
      return false;
    } finally {
      if (!disposed) {
        setPending(undefined);
      }
    }
  }
  return { run, state, pending, error };
}
