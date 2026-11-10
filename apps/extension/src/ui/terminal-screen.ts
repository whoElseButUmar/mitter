import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { TerminalInfo } from '../../../../packages/terminal/src/protocol';

export type TerminalScreen = {
  info: TerminalInfo;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  after: number;
  polling: boolean;
  tail: Promise<void>;
  pending: number;
  failed: boolean;
  exitShown: boolean;
  disposed: boolean;
  disposables: { dispose: () => void }[];
};

export function disposeTerminalScreen(screen: TerminalScreen): void {
  if (screen.disposed) {
    return;
  }

  screen.disposed = true;
  screen.failed = true;

  for (const disposable of screen.disposables.splice(0)) {
    try {
      disposable.dispose();
    } catch (error) {
      console.warn('Miter terminal subscription could not be disposed.', error);
    }
  }

  try {
    screen.term.dispose();
  } catch (error) {
    console.warn('Miter terminal widget could not be disposed.', error);
  }

  try {
    screen.el.remove();
  } catch (error) {
    console.warn('Miter terminal element could not be removed.', error);
  }
}
