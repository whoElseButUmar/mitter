import { createSignal, onCleanup } from 'solid-js';
import { errorMessage } from '../schemas/primitives';
import { createTerminalAppearance } from '../ui/terminal-appearance';
import { TerminalAppearance } from './TerminalAppearance';

export function TerminalAppearanceSettings(props: { close: () => void }) {
  const [error, setError] = createSignal('');
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  const fail = (reason: unknown) => {
    if (alive) {
      setError(errorMessage(reason));
    }
  };
  const appearance = createTerminalAppearance(() => {}, fail, setError);

  return <TerminalAppearance {...appearance} error={error} fail={fail} close={props.close} />;
}
