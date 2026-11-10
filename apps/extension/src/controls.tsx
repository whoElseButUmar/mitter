import { requireElement } from './ui/dom';
import { tabRowOptions } from './ui/tab-row-options';
import { createEffect, onMount, onCleanup, type JSX } from 'solid-js';
import { mountMenu, type MenuItem } from '../../../packages/ui/src/menu';
import { mountTabRow, type TabRowOptions } from '../../../packages/ui/src/tab-row';
import { enhanceSelects } from '../../../packages/ui/src/select';
import { bindInfoPopover, uiId } from '../../../packages/ui/src/popover';
import { Icon } from './icons';

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

export function MenuButton(props: { label: string; items: MenuItem[]; disabled?: boolean }) {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const menu = mountMenu(requireElement(root, 'controls root'), props.label, props.items);
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

export function InfoPopover(props: { label: string; title: string; children: JSX.Element }) {
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  const id = uiId('info-button');

  onMount(() => {
    const popover = bindInfoPopover(
      requireElement(trigger, 'info popover trigger'),
      requireElement(panel, 'info popover panel'),
    );
    onCleanup(popover.dispose);
  });

  return (
    <div class="info-control">
      <button
        id={id}
        ref={(element) => {
          trigger = element;
        }}
        type="button"
        class="info-trigger"
      >
        {props.label}
        <Icon name="down" size={12} />
      </button>
      <div
        ref={(element) => {
          panel = element;
        }}
        hidden
        tabindex="-1"
        class="info-popup"
        aria-label={props.title}
      >
        {props.children}
      </div>
    </div>
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
