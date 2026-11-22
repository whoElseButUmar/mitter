import { PreviewElementFigure } from './PreviewElementFigure';
import { createSignal, Show } from 'solid-js';
import { coreRpcRegistry, type PreviewElement } from '../../../../packages/protocol/src/rpc';
import { errorMessage } from '../schemas/primitives';
import { callResult, type ViewRPC } from '../ui/rpc';

export function SelectedPreviewElement(props: { workerId: string; rpc: ViewRPC }) {
  const [element, setElement] = createSignal<PreviewElement>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  async function load(open: boolean) {
    if (!open || loading() || element()) {
      return;
    }
    setLoading(true);
    setError('');
    try {
      const selected = await callResult(
        props.rpc,
        coreRpcRegistry['worker.previewSelection'].result,
        'worker.previewSelection',
        { workerId: props.workerId },
      );
      if (!selected) {
        throw new Error('This task has no saved preview selection.');
      }
      setElement(selected);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }

  return (
    <details class="task-details" onToggle={(event) => void load(event.currentTarget.open)}>
      <summary>Selected element</summary>
      <Show when={loading()}>
        <p role="status">Loading selection…</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={element()}>{(selected) => <PreviewElementFigure element={selected()} />}</Show>
    </details>
  );
}
