import { createTeamUpdates } from './ui/team-updates';
import { syncInputValidity } from './ui/dom';
import { For, Show } from 'solid-js';
import type { PreviewRPC } from '../../../packages/ui/src/preview';
import { ContextArea } from './ContextArea';

export function TeamPanel(props: {
  workerId: string;
  rpc: PreviewRPC;
  revision: number;
  copy: (text: string) => Promise<void>;
  success?: (message: string) => void;
}) {
  const updates = createTeamUpdates(props);
  const { data, text, setText, busy, loading, error } = updates;

  return (
    <section class="team-panel" aria-label="Project team">
      <Show when={loading()}>
        <p class="muted" role="status">
          Loading team updates…
        </p>
      </Show>
      <For
        each={data().peers}
        fallback={
          <Show when={!loading() && !error()}>
            <p class="muted">No other tasks in this project.</p>
          </Show>
        }
      >
        {(peer) => (
          <ContextArea
            items={[
              {
                id: 'copy',
                label: 'Copy task summary',
                run: () => void props.copy(peer.name + ' · ' + peer.state + ' · ' + peer.branch),
              },
            ]}
          >
            <div class="team-peer">
              <strong>{peer.name}</strong>
              <small>
                {peer.held || peer.state} · {peer.branch}
              </small>
            </div>
          </ContextArea>
        )}
      </For>
      <div class="team-updates">
        <For
          each={data().messages}
          fallback={
            <Show when={!loading() && !error()}>
              <p class="muted">No team updates yet.</p>
            </Show>
          }
        >
          {(message) => (
            <ContextArea
              items={[
                {
                  id: 'copy',
                  label: 'Copy update',
                  run: () => void props.copy(message.message),
                },
              ]}
            >
              <div class="activity-line">
                <time dateTime={new Date(message.time).toISOString()}>
                  {new Date(message.time).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
                <p>{message.message}</p>
              </div>
            </ContextArea>
          )}
        </For>
      </div>
      <form
        aria-busy={busy()}
        onSubmit={(event) => {
          event.preventDefault();
          return updates.send();
        }}
      >
        <label class="field">
          <span>Project update</span>
          <textarea
            required
            maxlength="3000"
            rows="2"
            value={text()}
            onInput={(event) => {
              setText(event.currentTarget.value);
              syncInputValidity(event.currentTarget);
            }}
            onBlur={(event) => syncInputValidity(event.currentTarget)}
            onInvalid={(event) => event.currentTarget.setAttribute('aria-invalid', 'true')}
          />
        </label>
        <div class="button-row end">
          <button type="submit" disabled={busy()}>
            Send update
          </button>
        </div>
      </form>
      <Show when={error()}>
        <p class="error" role="alert">
          {error()}
        </p>
        <button type="button" disabled={loading()} onClick={() => updates.load()}>
          Refresh team updates
        </button>
      </Show>
    </section>
  );
}
