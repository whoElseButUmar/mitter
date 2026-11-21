import { createEffect, For, onCleanup, onMount } from 'solid-js';
import { enhanceSelect } from '../../../../packages/ui/src/select';
import { requireElement } from '../ui/dom';
import { bindTooltip } from './TooltipButton';

type TerminalChoice = { id: string; label: string; disabled: boolean };

export function TerminalSessionPicker(props: {
  value: string;
  choices: TerminalChoice[];
  placeholder: string;
  change: (id: string) => void;
}) {
  let select: HTMLSelectElement | undefined;
  onMount(() => {
    const element = requireElement(select, 'Terminal session picker');
    const control = enhanceSelect(element, { nativeTooltip: false });
    const tooltip = bindTooltip(control.trigger, () => element.selectedOptions[0]?.text || props.placeholder);
    const dismissHintForSelection = (event: KeyboardEvent) => {
      if (
        ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key) ||
        event.key.length === 1
      ) {
        tooltip.dismiss();
      }
    };
    control.trigger.addEventListener('keydown', dismissHintForSelection);
    createEffect(() => {
      const choices = props.choices;
      let value = '';
      if (choices.some((choice) => choice.id === props.value)) {
        value = props.value;
      }
      element.value = value;
      control.refresh();
      control.trigger.removeAttribute('title');
      tooltip.refresh();
    });
    onCleanup(() => {
      control.trigger.removeEventListener('keydown', dismissHintForSelection);
      tooltip.dispose();
      control.dispose();
    });
  });

  return (
    <select
      ref={(element) => {
        select = element;
      }}
      aria-label="Terminal session"
      disabled={!props.choices.length}
      onChange={(event) => props.change(event.currentTarget.value)}
    >
      <option value="" disabled>
        {props.placeholder}
      </option>
      <For each={props.choices}>
        {(choice) => (
          <option value={choice.id} disabled={choice.disabled}>
            {choice.label}
          </option>
        )}
      </For>
    </select>
  );
}
