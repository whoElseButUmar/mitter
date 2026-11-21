import { reloadWorkspace } from './workspace-reload';
import { requireElement } from './ui/dom';
import { createSignal, createEffect, onMount, onCleanup, Show, type JSX } from 'solid-js';
import { Modal } from './components';
import { connectResetView } from './data-view';
import { mountResetForm } from '../../../packages/ui/src/reset-form';
import type { DataResetState } from '../../../packages/bridge/src/data-reset';
import './style.css';
import { ConnectionGuide } from './views/ConnectionGuide';

function ResetForm(props: {
  state: DataResetState;
  clear: (confirmation: string) => Promise<void>;
  close: () => void;
  connected: boolean;
}) {
  let root: HTMLDivElement | undefined;
  let form: ReturnType<typeof mountResetForm> | undefined;
  onMount(() => {
    form = mountResetForm(requireElement(root, 'ResetBoundary root'), {
      clear: props.clear,
      close: props.close,
    });
    form.update(props.state);
    form.setConnected(props.connected);
  });

  createEffect(() => {
    const state = props.state;
    form?.update(state);
  });

  createEffect(() => {
    form?.setConnected(props.connected);
  });

  onCleanup(() => form?.dispose());

  return (
    <div
      ref={(element) => {
        root = element;
      }}
    />
  );
}

/** Lives outside App so reset can dispose every task, preview, terminal, draft,
 * toast and client without destroying the confirmation/result channel. */

export function ResetBoundary(props: { app: () => JSX.Element }) {
  const [ready, setReady] = createSignal(false);

  const [locked, setLocked] = createSignal(false);

  const [show, setShow] = createSignal(false);

  const [state, setState] = createSignal<DataResetState>({
    phase: 'idle',
  });

  const [connected, setConnected] = createSignal(false);

  const [connectionError, setConnectionError] = createSignal('');

  let channel: ReturnType<typeof connectResetView> | undefined;
  const close = () => {
    if (!locked() && state().phase === 'idle') {
      setShow(false);
    }
  };

  onMount(() => {
    channel = connectResetView(
      (next) => {
        setReady(true);
        setState(next);
        if (next.phase !== 'idle') {
          setLocked(true);
          setShow(true);
        }
      },
      async () => {
        setLocked(true);
        await Promise.resolve();
      },
      (ok, error) => {
        setConnected(ok);
        setConnectionError(error || '');
      },
    );
    const open = () => setShow(true);
    window.addEventListener('miter-request-reset', open);
    onCleanup(() => {
      window.removeEventListener('miter-request-reset', open);
      channel?.close();
    });
  });

  return (
    <>
      <Show when={!ready()}>
        <main class="reset-locked">
          <h1>Miter</h1>
          <ConnectionGuide
            error={connectionError()}
            reconnect={() => location.reload()}
            reload={reloadWorkspace}
          />
        </main>
      </Show>
      <Show when={ready() && !locked()}>{props.app()}</Show>
      <Show when={locked()}>
        <main class="reset-locked">
          <h1>Miter</h1>
          <p>Application data reset</p>
        </main>
      </Show>
      <Show when={show()}>
        <Modal
          title="Clear all Miter data"
          close={close}
          closeDisabled={locked() || state().phase !== 'idle'}
        >
          <ResetForm
            state={state()}
            close={close}
            connected={connected()}
            clear={async (confirmation) => {
              if (!channel) {
                throw new Error('The reset coordinator is not connected.');
              }
              await channel.clear(confirmation);
            }}
          />
        </Modal>
      </Show>
    </>
  );
}
