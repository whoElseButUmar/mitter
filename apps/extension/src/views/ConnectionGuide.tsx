import { createSignal, onCleanup, Show } from 'solid-js';
import { connectionHelp } from '../ui/connection-help';
import { Icon } from '../icons';

export function ConnectionAction(props: { error: string; reconnect: () => void; reload: () => void }) {
  const help = () => connectionHelp(props.error);
  return (
    <Show when={help().action !== 'wait'}>
      <button
        type="button"
        class="primary"
        onClick={() => {
          if (help().action === 'reload') {
            props.reload();
          } else {
            props.reconnect();
          }
        }}
      >
        {help().label}
      </button>
    </Show>
  );
}

export function ConnectionGuide(props: { error: string; reconnect: () => void; reload: () => void }) {
  const help = () => connectionHelp(props.error);
  const [copyMessage, setCopyMessage] = createSignal('');
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  const copySetup = async () => {
    try {
      await navigator.clipboard.writeText('node scripts/setup.mjs');
      if (alive) {
        setCopyMessage('Setup command copied. Run it inside the Miter source folder.');
      }
    } catch {
      if (alive) {
        setCopyMessage('Copy the command below and run it inside the Miter source folder.');
      }
    }
  };

  return (
    <section class="connection-guide" aria-label="Local helper setup">
      <h2>{help().title}</h2>
      <p role="status">{help().detail}</p>
      <div class="button-row">
        <ConnectionAction {...props} />
      </div>
      <details class="setup-disclosure">
        <summary>
          <Icon name="down" />
          Setup help
        </summary>
        <p>
          Open <strong>Install Miter.command</strong> from your Miter installer, then reconnect here.
        </p>
        <p class="muted small">The local helper saves files and runs your apps and checks.</p>
        <Show when={help().action === 'wait'}>
          <button type="button" onClick={props.reconnect}>
            Reconnect
          </button>
        </Show>
        <details class="setup-disclosure">
          <summary>
            <Icon name="down" />
            Installing from source
          </summary>
          <p>With Node.js 26 or newer, run this inside the Miter source folder:</p>
          <code class="setup-command">node scripts/setup.mjs</code>
          <button type="button" onClick={() => void copySetup()}>
            Copy setup command
          </button>
          <p class="small" role="status">
            {copyMessage()}
          </p>
        </details>
      </details>
      <Show when={props.error}>
        <details class="setup-disclosure">
          <summary>
            <Icon name="down" />
            Connection details
          </summary>
          <pre>{props.error}</pre>
        </details>
      </Show>
    </section>
  );
}
