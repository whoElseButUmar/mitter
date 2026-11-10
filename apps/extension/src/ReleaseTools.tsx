import { requireElement } from './ui/dom';
import { onMount, onCleanup } from 'solid-js';
import { mountHealthPanel, type HealthPanelOptions } from '../../../packages/ui/src/health-panel';
import { mountChangeReview, type ChangeReviewOptions } from '../../../packages/ui/src/change-review';

export function HealthPanel(props: HealthPanelOptions) {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const panel = mountHealthPanel(requireElement(root, 'ReleaseTools root'), props);
    onCleanup(panel.dispose);
  });

  return (
    <div
      class="health-panel"
      ref={(element) => {
        root = element;
      }}
    />
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
