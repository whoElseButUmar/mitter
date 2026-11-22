import { createSignal, onCleanup, Show } from 'solid-js';
import { connectionHelp } from '../ui/connection-help';
import type { ConnectionBuilds } from '../client';
import { Icon } from '../icons';

type ConnectionOptions = {
  error: string;
  builds?: ConnectionBuilds | undefined;
  reconnect: () => void;
  reload: () => void;
};

export function ConnectionAction(props: ConnectionOptions) {
  const help = () => connectionHelp(props.error, props.builds);
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

export function ConnectionGuide(props: ConnectionOptions) {
  const help = () => connectionHelp(props.error, props.builds);
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
      <Show when={help().action === 'reload'}>
        <p class="small">
          If the builds still differ, run <strong>Install Miter.command</strong>. In this Chrome profile, open{' '}
          <code>chrome://extensions</code>, choose <strong>Load unpacked</strong> in Developer mode, and
          select the extension folder shown by the installer.
        </p>
      </Show>
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
