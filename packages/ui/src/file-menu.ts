import type { MenuItem } from './menu.js';

export type FileMenuActions = {
  openWindow(): void;
  reveal(): void;
  openEditor(): void;
  copyPath(): void;
  copySource(): void;
  reload(): void;
  hasSource: boolean;
  truncated: boolean;
};

/** Source / Preview already have adjacent buttons. Do not duplicate them here. */
export function fileViewerMenu(actions: FileMenuActions): MenuItem[] {
  let copyLabel = 'Copy source';

  if (actions.truncated) {
    copyLabel = 'Copy displayed source';
  }

  return [
    { id: 'window', label: 'Open in new window', run: actions.openWindow },
    {
      id: 'finder',
      label: 'Reveal in file manager',
      separatorBefore: true,
      run: actions.reveal,
    },
    { id: 'vscode', label: 'Open in VS Code', run: actions.openEditor },
    {
      id: 'copy-path',
      label: 'Copy relative path',
      separatorBefore: true,
      run: actions.copyPath,
    },
    {
      id: 'copy-source',
      label: copyLabel,
      disabled: !actions.hasSource,
      run: actions.copySource,
    },
    { id: 'reload', label: 'Reload file', run: actions.reload },
  ];
}
