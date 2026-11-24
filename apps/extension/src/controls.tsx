import { requireElement } from './ui/dom';
import { tabRowOptions } from './ui/tab-row-options';
import { createEffect, onMount, onCleanup, type JSX } from 'solid-js';
import { mountMenu, type MenuItem } from '../../../packages/ui/src/menu';
import { mountTabRow, type TabRowOptions } from '../../../packages/ui/src/tab-row';
import { enhanceSelects } from '../../../packages/ui/src/select';
import { createIcon } from '../../../packages/ui/src/icons';
import { bindTooltip } from './ui/tooltip';

export function WorkspaceTabRow(props: TabRowOptions) {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const tabRow = mountTabRow(requireElement(root, 'workspace tab row'), tabRowOptions(props));
    createEffect(() => {
      tabRow.update(tabRowOptions(props));
    });
    onCleanup(tabRow.dispose);
  });

  return (
    <div
      ref={(element) => {
        root = element;
      }}
    />
  );
}

export function MenuButton(props: {
  label: string;
  items: MenuItem[];
  disabled?: boolean;
  icon?: Parameters<typeof createIcon>[1];
}) {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const menu = mountMenu(requireElement(root, 'controls root'), props.label, props.items);
    if (props.icon && menu.trigger instanceof HTMLButtonElement) {
      menu.trigger.replaceChildren(createIcon(menu.trigger.ownerDocument, props.icon));
      menu.trigger.classList.add('icon-button');
      menu.trigger.setAttribute('aria-label', props.label);
      const tooltip = bindTooltip(menu.trigger, () => props.label);
      onCleanup(tooltip.dispose);
    }
    createEffect(() => menu.update(props.items, props.disabled));
    onCleanup(menu.dispose);
  });

  return (
    <div
      class="menu-control"
      ref={(element) => {
        root = element;
      }}
    />
  );
}

/** Progressive enhancement for forms whose DOM is rendered by Solid. */

export function SelectSurface(props: { children: JSX.Element }) {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const selects = enhanceSelects(requireElement(root, 'controls root'));
    onCleanup(selects.dispose);
  });

  return (
    <div
      ref={(element) => {
        root = element;
      }}
    >
      {props.children}
    </div>
  );
}
