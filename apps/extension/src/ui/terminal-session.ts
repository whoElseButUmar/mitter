import type { TerminalClient } from '../terminal-client';
import type { TerminalScreen } from './terminal-screen';
import { showConfirmation } from './confirmation';

type TerminalSessionDependencies = {
  client: Pick<TerminalClient, 'request'>;
  isCurrent: () => boolean;
  fail: (error: unknown) => void;
};

export function bindTerminalInput(
  screen: TerminalScreen,
  dependencies: TerminalSessionDependencies & { confirmationSignal: () => AbortSignal },
): void {
  const { client, isCurrent, fail } = dependencies;
  const { term, el } = screen;
  const acceptsInput = () => isCurrent() && !screen.disposed && !screen.failed && !screen.info.exited;
  const lifetime = new AbortController();
  let pastePending = false;
  screen.disposables.push({ dispose: () => lifetime.abort() });

  // Escape sequences cannot query or change the clipboard. Clipboard access remains a human gesture.
  screen.disposables.push(term.parser.registerOscHandler(52, () => true));
  screen.disposables.push(
    term.onData((data) => {
      if (!acceptsInput()) {
        return;
      }
      const inputScope = dependencies.confirmationSignal();
      if (inputScope.aborted) {
        return;
      }

      if (screen.pending + data.length > 65536) {
        screen.failed = true;
        term.options.disableStdin = true;
        fail(
          new Error('Terminal input queue is full. Input stopped rather than silently dropping keystrokes.'),
        );
        return;
      }

      screen.pending += data.length;
      screen.tail = screen.tail
        .then(async () => {
          for (let offset = 0; offset < data.length;) {
            if (!acceptsInput() || inputScope.aborted) {
              return;
            }

            let end = Math.min(offset + 8192, data.length);
            if (end < data.length && /[\uD800-\uDBFF]/.test(data.charAt(end - 1))) {
              end--;
            }

            await client.request('terminal.write', {
              sessionId: screen.info.id,
              data: data.slice(offset, end),
            });
            offset = end;
          }
        })
        .catch((error) => {
          if (!isCurrent() || screen.disposed) {
            return;
          }

          screen.failed = true;
          term.options.disableStdin = true;
          fail(error);
        })
        .finally(() => {
          screen.pending -= data.length;
        });
    }),
  );
  screen.disposables.push(
    term.onResize((size) => {
      if (!acceptsInput()) {
        return;
      }

      void client
        .request('terminal.resize', {
          sessionId: screen.info.id,
          cols: Math.max(10, Math.min(500, size.cols)),
          rows: Math.max(2, Math.min(300, size.rows)),
        })
        .catch((error) => {
          if (isCurrent() && !screen.disposed) {
            fail(error);
          }
        });
    }),
  );

  // Intercept paste before xterm; xterm still owns bracketed-paste encoding.
  const paste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain');
    if (text === undefined) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    if (!acceptsInput() || pastePending) {
      return;
    }

    if (text.length > 16384) {
      fail(new Error('Paste up to 16 KB at a time.'));
      return;
    }

    if (/[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
      pastePending = true;
      const signal = AbortSignal.any([lifetime.signal, dependencies.confirmationSignal()]);
      void showConfirmation({
        title: 'Paste into shell',
        message: 'Paste multiple lines or control characters into the real shell? This may execute commands.',
        confirmLabel: 'Paste into shell',
        signal,
        isCurrent: acceptsInput,
      })
        .then((accepted) => {
          if (accepted && !signal.aborted && acceptsInput()) {
            term.paste(text);
          }
        })
        .catch((error) => {
          if (!signal.aborted && acceptsInput()) {
            fail(error);
          }
        })
        .finally(() => {
          pastePending = false;
        });
      return;
    }

    term.paste(text);
  };
  const pasteOptions = { capture: true };
  el.addEventListener('paste', paste, pasteOptions);
  screen.disposables.push({
    dispose: () => el.removeEventListener('paste', paste, pasteOptions),
  });

  term.attachCustomKeyEventHandler((event) => {
    if (!isCurrent() || screen.disposed) {
      return false;
    }

    if (event.type === 'keydown' && event.metaKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      term.clear();
      return false;
    }

    if (
      event.type === 'keydown' &&
      (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
      event.key.toLowerCase() === 'c' &&
      term.hasSelection()
    ) {
      event.preventDefault();
      void navigator.clipboard.writeText(term.getSelection()).catch((error) => {
        if (isCurrent() && !screen.disposed) {
          fail(error);
        }
      });
      return false;
    }

    return true;
  });
}

export async function readTerminalScreen(
  screen: TerminalScreen,
  dependencies: TerminalSessionDependencies & { refresh: () => Promise<void> },
): Promise<void> {
  const { client, isCurrent, fail, refresh } = dependencies;
  if (screen.polling || screen.failed || screen.exitShown || screen.disposed || !isCurrent()) {
    return;
  }

  screen.polling = true;
  try {
    const result = await client.request('terminal.read', {
      sessionId: screen.info.id,
      after: screen.after,
    });
    if (!isCurrent() || screen.disposed) {
      return;
    }

    if (result.reset) {
      screen.term.reset();
      screen.term.writeln('\x1b[33m[Earlier terminal scrollback is no longer available.]\x1b[0m');
    }

    for (const frame of result.frames) {
      if (!isCurrent() || screen.disposed) {
        return;
      }

      if (frame.seq <= screen.after) {
        continue;
      }

      let pendingWrite: { dispose: () => void } | undefined;
      try {
        await new Promise<void>((resolve) => {
          pendingWrite = { dispose: resolve };
          screen.disposables.push(pendingWrite);
          screen.term.write(frame.data, resolve);
        });
      } finally {
        if (pendingWrite) {
          const index = screen.disposables.indexOf(pendingWrite);
          if (index >= 0) {
            screen.disposables.splice(index, 1);
          }
        }
      }
      if (!isCurrent() || screen.disposed) {
        return;
      }
      screen.after = frame.seq;
    }

    if (!isCurrent() || screen.disposed) {
      return;
    }
    if (result.exited && !screen.exitShown) {
      screen.exitShown = true;
      screen.info.exited = true;
      screen.term.options.disableStdin = true;
      screen.term.writeln('\r\n\x1b[90m[Shell exited: ' + result.exitCode + ']\x1b[0m');
      void refresh();
    }
  } catch (error) {
    if (!isCurrent() || screen.disposed) {
      return;
    }

    screen.failed = true;
    screen.term.options.disableStdin = true;
    fail(error);
  } finally {
    screen.polling = false;
  }
}
