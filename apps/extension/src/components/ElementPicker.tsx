import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { coreRpcRegistry, type AppRunSession } from '../../../../packages/protocol/src/rpc';
import { Modal } from '../components';
import { errorMessage } from '../schemas/primitives';
import type { ViewRpcResult } from '../schemas/view-rpc';
import { callResult, type ViewRPC } from '../ui/rpc';

export type PickedElements = ViewRpcResult<'worker.pickElement'>;

export function ElementPicker(props: {
  run: AppRunSession;
  rpc: ViewRPC;
  close: () => void;
  picked: (selection: PickedElements) => void;
}) {
  const params = {
    workerId: props.run.workerId,
    expectedRun: props.run.expectedRun,
    previewId: props.run.previewId,
  };
  const [error, setError] = createSignal('');
  const [closing, setClosing] = createSignal(false);
  let alive = true;
  let waiting = false;

  const cancelPick = () =>
    callResult(props.rpc, coreRpcRegistry['worker.cancelPick'].result, 'worker.cancelPick', params);

  async function close() {
    if (closing()) {
      return;
    }
    setClosing(true);
    try {
      if (waiting) {
        await cancelPick();
      }
      if (alive) {
        props.close();
      }
    } catch (failure) {
      if (alive) {
        setError(errorMessage(failure));
        setClosing(false);
      }
    }
  }

  onMount(async () => {
    waiting = true;
    try {
      const selection = await callResult(
        props.rpc,
        coreRpcRegistry['worker.pickElement'].result,
        'worker.pickElement',
        params,
      );
      waiting = false;
      if (alive && !closing()) {
        props.picked(selection);
      }
    } catch (failure) {
      waiting = false;
      if (alive && !closing()) {
        setError(errorMessage(failure));
      }
    }
  });

  onCleanup(() => {
    alive = false;
    if (waiting && !closing()) {
      void cancelPick().catch(() => {});
    }
  });

  return (
    <Modal title="Point to edit" close={() => void close()} closeDisabled={closing()}>
      <Show when={error()} fallback={<p role="status">Capture elements in the preview, then choose Done.</p>}>
        <p class="error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="button-row end">
        <button type="button" disabled={closing()} onClick={close}>
          <Show when={error()} fallback="Cancel">
            Close
          </Show>
        </button>
      </div>
    </Modal>
  );
}
