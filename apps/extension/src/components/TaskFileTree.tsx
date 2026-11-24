import { createEffect, createMemo, For, on, Show } from 'solid-js';
import type { MenuItem } from '../../../../packages/ui/src/menu';
import type { ChangedFile } from '../ui/view-data';
import { ContextArea } from '../ContextArea';
import { Icon } from '../icons';

type Directory = { name: string; path: string; entries: Entries };
type Entries = { folders: Map<string, Directory>; files: Map<string, ChangedFile> };

function emptyEntries(): Entries {
  return { folders: new Map(), files: new Map() };
}

const names = new Intl.Collator(undefined, { numeric: true });

function groupFiles(files: ChangedFile[]): Entries {
  const root = emptyEntries();
  for (const file of files) {
    const segments = file.path.split('/');
    const name = segments.pop() ?? file.path;
    let parent = root;
    let path = '';
    for (const segment of segments) {
      path += segment;
      let folder = parent.folders.get(segment);
      if (!folder) {
        folder = { name: segment, path, entries: emptyEntries() };
        parent.folders.set(segment, folder);
      }
      parent = folder.entries;
      path += '/';
    }
    parent.files.set(name, file);
  }
  return root;
}

type FileActions = {
  selected: string;
  previewRequest: number;
  preview: (path: string) => void;
  menu: (path: string) => MenuItem[];
};

function Folder(props: { folder: Directory; actions: FileActions; depth: number }) {
  let disclosure: HTMLDetailsElement | undefined;
  createEffect(
    on(
      () => props.actions.previewRequest,
      () => {
        if (disclosure && props.actions.selected.startsWith(props.folder.path + '/')) {
          disclosure.open = true;
        }
      },
    ),
  );

  return (
    <details ref={disclosure}>
      <summary class="file-tree-folder" title={props.folder.path}>
        <Icon name="right" />
        <Icon name="folder" />
        <span>{props.folder.name}</span>
      </summary>
      <FileTreeEntries entries={props.folder.entries} actions={props.actions} depth={props.depth + 1} />
    </details>
  );
}

function FileTreeEntries(props: { entries: Entries; actions: FileActions; depth: number }) {
  return (
    <ul class="file-tree" classList={{ 'file-tree-branch': props.depth > 0 && props.depth <= 5 }}>
      <For each={[...props.entries.folders.keys()].sort(names.compare)}>
        {(name) => (
          <li>
            <Show when={props.entries.folders.get(name)}>
              {(folder) => <Folder folder={folder()} actions={props.actions} depth={props.depth} />}
            </Show>
          </li>
        )}
      </For>
      <For each={[...props.entries.files.keys()].sort(names.compare)}>
        {(name) => (
          <li>
            <Show when={props.entries.files.get(name)}>
              {(entry) => (
                <ContextArea items={props.actions.menu(entry().path)}>
                  <button
                    type="button"
                    class="file-row"
                    classList={{ selected: props.actions.selected === entry().path }}
                    aria-current={props.actions.selected === entry().path}
                    title={entry().path + ' · ' + entry().bytes + ' B'}
                    onClick={() => props.actions.preview(entry().path)}
                  >
                    <Icon name="file" />
                    <span>{name}</span>
                    <Show when={entry().status === 'rolled_back'}>
                      <small>Restored</small>
                    </Show>
                  </button>
                </ContextArea>
              )}
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

export function TaskFileTree(props: FileActions & { files: ChangedFile[] }) {
  const entries = createMemo(() => groupFiles(props.files));
  return <FileTreeEntries entries={entries()} actions={props} depth={0} />;
}
