import { createEffect, createMemo, createUniqueId, Show } from 'solid-js';
import type { AppRunSession } from '../../../../packages/protocol/src/rpc';
import type { TerminalPreferences } from '../../../../packages/terminal/src/appearance';
import { terminalSettings } from '../ui/terminal-settings';
import { Icon } from '../icons';

export function AppRunOutput(props: {
  run: AppRunSession;
  preferences: TerminalPreferences;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}) {
  const settings = createMemo(() => terminalSettings(props.preferences));
  const outputId = 'app-log-' + createUniqueId();
  let screen: HTMLPreElement | undefined;
  let previousSession = '';
  let follow = true;
  createEffect(() => {
    const session = props.run.previewId;
    props.run.output;
    if (!props.expanded) {
      return;
    }
    const latest = session !== previousSession || follow;
    previousSession = session;
    if (latest) {
      queueMicrotask(() => {
        if (screen?.isConnected && props.run.previewId === session) {
          screen.scrollTop = screen.scrollHeight;
        }
      });
    }
  });
  return (
    <div class="terminal-app-output">
      <div class="terminal-app-status">
        <span class="terminal-run-state" role="status">
          {props.run.state}
        </span>
        <button
          class="terminal-log-toggle"
          aria-expanded={props.expanded}
          aria-controls={outputId}
          onClick={() => props.setExpanded(!props.expanded)}
        >
          <Icon name="right" />
          Logs
        </button>
      </div>
      <Show when={props.run.state === 'failed'}>
        <p class="terminal-app-failure" role="alert">
          This app run failed. Check Logs, then try Run again.
        </p>
      </Show>
      <pre
        ref={screen}
        id={outputId}
        hidden={!props.expanded}
        class="terminal-run-output"
        role="region"
        aria-label={props.run.name + ' output'}
        tabIndex={0}
        style={{
          color: settings().theme.foreground,
          'background-color': settings().theme.background,
          'font-family': settings().fontFamily,
          'font-size': settings().fontSize + 'px',
          'line-height': settings().lineHeight,
        }}
        onScroll={() => {
          if (screen) {
            follow = screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 4;
          }
        }}
      >
        {props.run.output}
      </pre>
    </div>
  );
}
