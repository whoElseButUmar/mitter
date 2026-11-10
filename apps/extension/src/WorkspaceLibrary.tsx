import { requireElement } from './ui/dom';
import { onMount, onCleanup, createEffect } from 'solid-js';
import { mountLibrary, type LibraryOptions } from '../../../packages/ui/src/library';

export function WorkspaceLibrary(props: LibraryOptions) {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const library = mountLibrary(requireElement(root, 'workspace library'), props);
    createEffect(() =>
      library.update({
        ...props,
        state: props.state,
        projects: props.projects,
        tasks: props.tasks,
        initialFilter: props.initialFilter,
      }),
    );
    onCleanup(library.dispose);
  });

  return (
    <div
      ref={(element) => {
        root = element;
      }}
    />
  );
}
