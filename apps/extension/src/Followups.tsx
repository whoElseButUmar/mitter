import { requireElement } from './ui/dom';
import { errorMessage } from './schemas/primitives';
import type { RewriteRequest } from '../../../packages/protocol/src/rewrite';
import { createEffect, onMount, onCleanup, For, Show, createSignal } from 'solid-js';
import { mountFollowupComposer } from '../../../packages/ui/src/followup-composer';
import type { FollowupSummary } from '../../../packages/protocol/src/requests';
import type { ChangeRequest } from './FileViewer';
import { ContextArea } from './ContextArea';
import { TooltipButton } from './components/TooltipButton';
import { Icon } from './icons';

export function FollowupPanel(props: {
  workerId: string;
  items: FollowupSummary[];
  running: boolean;
  disabled: boolean;
  send: (request: ChangeRequest) => Promise<unknown>;
  steer: (request: ChangeRequest) => Promise<unknown>;
  cancel: (id: string) => Promise<unknown>;
  copy: (text: string) => Promise<void>;
  history: () => void;
  rewrite: (request: RewriteRequest, signal: AbortSignal) => Promise<string>;
  start: () => Promise<unknown>;
}) {
  let root: HTMLDivElement | undefined;
  const [error, setError] = createSignal('');
  onMount(() => {
    const form = mountFollowupComposer(requireElement(root, 'Followups root'), {
      workerId: props.workerId,
      running: props.running,
      disabled: props.disabled,
      rewrite: props.rewrite,
      send: (result) =>
        props.send({
          ...result,
          autoStart: true,
        }),
      steer: (result) =>
        props.steer({
          ...result,
          autoStart: true,
        }),
    });
    createEffect(() =>
      form.update({
        workerId: props.workerId,
        running: props.running,
        disabled: props.disabled,
        rewrite: props.rewrite,
        send: (result) =>
          props.send({
            ...result,
            autoStart: true,
          }),
        steer: (result) =>
          props.steer({
            ...result,
            autoStart: true,
          }),
      }),
    );
    onCleanup(form.dispose);
  });
  const pending = () => props.items.filter((followup) => ['queued', 'blocked'].includes(followup.status));
  return (
    <section class="followup-section" aria-label="Follow up on this task">
      <Show when={props.items.length}>
        <div class="followup-topline">
          <button class="text-button" aria-label="Follow-up history" onClick={props.history}>
            History
          </button>
        </div>
      </Show>
      <div
        ref={(element) => {
          root = element;
        }}
      />
      <Show when={pending().length}>
        <details class="followup-queue" open>
          <summary class="disclosure-summary">
            <Icon name="down" />
            {pending().length} pending follow-up
            <Show when={pending().length === 1} fallback={'s'}>
              {''}
            </Show>
          </summary>
          <Show when={!props.running}>
            <button
              class="text-button"
              onClick={() => void props.start().catch((event) => setError(errorMessage(event)))}
            >
              Continue queued follow-ups
            </button>
          </Show>
          <For each={pending()}>
            {(followup) => (
              <ContextArea
                label="Follow-up actions"
                items={[
                  {
                    id: 'copy',
                    label: 'Copy request',
                    run: () => void props.copy(followup.instruction),
                  },
                  {
                    id: 'remove',
                    label: 'Remove queued request',
                    run: () => {
                      void props.cancel(followup.id).catch((event) => setError(errorMessage(event)));
                    },
                  },
                ]}
              >
                <div class="followup-row">
                  <span>{followup.instruction}</span>
                  <small>{followup.status}</small>
                  <TooltipButton
                    class="icon-button"
                    icon="close"
                    label="Remove queued request"
                    onClick={() =>
                      void props.cancel(followup.id).catch((event) => setError(errorMessage(event)))
                    }
                  />
                </div>
                <Show when={followup.error}>
                  <p class="error">{followup.error}</p>
                </Show>
              </ContextArea>
            )}
          </For>
        </details>
      </Show>
      <Show when={error()}>
        <p class="error" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
