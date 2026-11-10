import type { TabRowOptions } from '../../../../packages/ui/src/tab-row';

export function tabRowOptions(props: TabRowOptions): TabRowOptions {
  const options: TabRowOptions = {
    kind: props.kind,
    items: props.items,
    selected: props.selected,
    canAdd: props.canAdd,
    addLabel: props.addLabel,
    onSelect: props.onSelect,
    onAdd: props.onAdd,
  };
  const addDisabled = props.addDisabled;
  const onClose = props.onClose;
  const onList = props.onList;
  const listLabel = props.listLabel;
  const menuItems = props.menuItems;

  if (addDisabled !== undefined) {
    options.addDisabled = addDisabled;
  }

  if (onClose !== undefined) {
    options.onClose = onClose;
  }

  if (onList !== undefined) {
    options.onList = onList;
  }

  if (listLabel !== undefined) {
    options.listLabel = listLabel;
  }

  if (menuItems !== undefined) {
    options.menuItems = menuItems;
  }

  return options;
}
