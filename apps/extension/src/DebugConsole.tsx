import { ContextArea } from './ContextArea';
import { APP_VERSION } from '../../../packages/protocol/src/index';
import { For, createMemo } from 'solid-js';
import type { DebugEntry } from '../../../packages/bridge/src/diagnostics';
import { Icon } from './icons';

export function DebugConsole(props: {
  entries: DebugEntry[];
  clear: () => void;
  close: () => void;
  copy: (text: string) => void;
}) {
  const plain = createMemo(() =>
    [
      'MITER ' + APP_VERSION + ' DEBUG CONSOLE (available session buffer, up to 500 entries)',
      'Review before sharing; credential redaction is best effort.',
      ...props.entries.map(
        (event) => `${new Date(event.time).toISOString()} [${event.kind}] ${event.message}`,
      ),
    ].join('\n'),
  );

  return (
    <ContextArea
      items={[
        {
          id: 'copy',
          label: 'Copy entire console',
          run: () => props.copy(plain()),
        },
        {
          id: 'clear',
          label: 'Clear console',
          run: props.clear,
        },
        {
          id: 'close',
          label: 'Close console',
          run: props.close,
        },
      ]}
    >
      <section class="debug-console" aria-label="Debug console">
        <header>
          <strong>Console</strong>
          <span class="muted">{props.entries.length} entries</span>
          <div class="spacer" />
          <button onClick={() => props.copy(plain())}>
            <Icon name="copy" size={13} />
            Copy all
          </button>
          <button onClick={props.clear}>Clear</button>
          <button class="icon-button" aria-label="Close console" onClick={props.close}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div class="debug-lines" tabindex="0">
          <For
            each={props.entries}
            fallback={<p class="muted">Requests, results, and errors will appear here.</p>}
          >
            {(event) => (
              <ContextArea
                label="Console event actions"
                items={[
                  {
                    id: 'copy',
                    label: 'Copy event',
                    run: () => props.copy(event.message),
                  },
                  {
                    id: 'copy-time',
                    label: 'Copy event with timestamp',
                    run: () =>
                      props.copy(
                        new Date(event.time).toISOString() + ' [' + event.kind + '] ' + event.message,
                      ),
                  },
                ]}
              >
                <div
                  classList={{
                    'debug-line': true,
                    'debug-error': event.kind.includes('error'),
                  }}
                >
                  <time>{new Date(event.time).toLocaleTimeString()}</time>
                  <span class="debug-kind">{event.kind}</span>
                  <pre>{event.message}</pre>
                </div>
              </ContextArea>
            )}
          </For>
        </div>
      </section>
    </ContextArea>
  );
}
