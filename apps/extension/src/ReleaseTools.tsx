import { requireElement } from './ui/dom';
import { onMount, onCleanup } from 'solid-js';
import { mountHealthPanel, type HealthPanelOptions } from '../../../packages/ui/src/health-panel';
import { mountChangeReview, type ChangeReviewOptions } from '../../../packages/ui/src/change-review';
import { Icon } from './icons';

export function HealthPanel(props: HealthPanelOptions) {
  let root: HTMLDivElement | undefined;
  let panel: ReturnType<typeof mountHealthPanel> | undefined;
  onCleanup(() => panel?.dispose());

  return (
    <details
      class="setup-diagnostics setup-disclosure"
      onToggle={(event) => {
        if (event.currentTarget.open && !panel) {
          panel = mountHealthPanel(requireElement(root, 'Diagnostics and backups'), props);
        }
      }}
    >
      <summary>
        <Icon name="down" />
        Diagnostics and backups
      </summary>
      <div
        class="health-panel"
        ref={(element) => {
          root = element;
        }}
      />
    </details>
  );
}

export function ChangeReview(props: ChangeReviewOptions) {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const panel = mountChangeReview(requireElement(root, 'ReleaseTools root'), props);
    onCleanup(panel.dispose);
  });

  return (
    <div
      class="change-review"
      ref={(element) => {
        root = element;
      }}
    />
  );
}
