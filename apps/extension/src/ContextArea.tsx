import { requireElement } from './ui/dom';
import { onMount, onCleanup, type JSX } from 'solid-js';
import { mountMenu, type MenuItem } from '../../../packages/ui/src/menu';

/** Context actions belong to a scope. Text inputs keep the OS editing menu. */

export function ContextArea(props: {
  items: MenuItem[];
  children: JSX.Element;
  class?: string;
  label?: string;
  focusable?: boolean;
}) {
  let root: HTMLDivElement | undefined;

  const tabIndex = () => {
    if (props.focusable) {
      return 0;
    }

    return undefined;
  };

  const groupRole = (): 'group' | undefined => {
    if (props.label) {
      return 'group';
    }
    return undefined;
  };

  onMount(() => {
    const menu = mountMenu(requireElement(root, 'ContextArea root'), props.label || 'Actions', [], {
      trigger: requireElement(root, 'ContextArea root'),
      items: () => props.items,
    });
    onCleanup(menu.dispose);
  });

  return (
    <div
      ref={(element) => {
        root = element;
      }}
      class={'context-area ' + (props.class || '')}
      data-miter-context
      tabindex={tabIndex()}
      role={groupRole()}
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}
