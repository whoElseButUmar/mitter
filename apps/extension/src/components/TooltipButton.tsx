import { createEffect, onCleanup, onMount, type ComponentProps, type JSX } from 'solid-js';
import { Icon } from '../icons';
import { bindTooltip } from '../ui/tooltip';
import { requireElement } from '../ui/dom';

export { bindTooltip } from '../ui/tooltip';

export function TooltipButton(props: {
  label: string;
  icon: ComponentProps<typeof Icon>['name'];
  disabled?: boolean;
  busy?: boolean;
  class?: string;
  ariaHasPopup?: 'dialog';
  onClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
}) {
  let button: HTMLButtonElement | undefined;

  onMount(() => {
    const tooltip = bindTooltip(requireElement(button, 'tooltip button'), () => props.label);
    createEffect(() => {
      tooltip.refresh();
      if (props.disabled) {
        tooltip.dismiss();
      }
    });
    onCleanup(tooltip.dispose);
  });

  return (
    <button
      ref={button}
      type="button"
      class={'tooltip-button ' + (props.class || '')}
      aria-label={props.label}
      aria-busy={props.busy}
      aria-disabled={props.busy || undefined}
      aria-haspopup={props.ariaHasPopup}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  );
}
