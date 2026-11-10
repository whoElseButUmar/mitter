import type { ChangeRequest } from '../FileViewer';
import { requireElement } from '../ui/dom';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { mountSelectionEditor } from '../../../../packages/ui/src/selection-editor';
import { ContextArea } from '../ContextArea';

export function SelectedSource(props: {
  workerId: string;
  path: string;
  source: string;
  hash: string;
  request: (request: ChangeRequest) => Promise<unknown>;
  copy: (text: string) => Promise<void>;
}) {
  let pre: HTMLPreElement | undefined;
  let editor: ReturnType<typeof mountSelectionEditor> | undefined;
  const [hasSelection, setHasSelection] = createSignal(false);

  const copySelection = () => {
    const text = editor?.selection()?.text;
    if (text) {
      void props.copy(text);
    }
  };

  onMount(() => {
    editor = mountSelectionEditor(requireElement(pre, 'FileViewer pre'), {
      workerId: props.workerId,
      path: props.path,
      content: props.source,
      hash: props.hash,
      submit: (result) =>
        props.request({
          ...result,
          autoStart: true,
        }),
    });
    const update = () => setHasSelection(!!editor?.selection());
    document.addEventListener('selectionchange', update);
    onCleanup(() => {
      document.removeEventListener('selectionchange', update);
      editor?.dispose();
    });
  });

  return (
    <ContextArea
      focusable
      label="Source code actions"
      items={[
        {
          id: 'change',
          label: 'Change selected code…',
          shortcut: 'Alt+Enter',
          disabled: !hasSelection(),
          run: () => {
            editor?.open();
          },
        },
        {
          id: 'selection',
          label: 'Copy selected code',
          disabled: !hasSelection(),
          run: copySelection,
        },
        {
          id: 'source',
          label: 'Copy entire source',
          run: () => {
            void props.copy(props.source);
          },
        },
        {
          id: 'select-all',
          label: 'Select all code',
          run: () => {
            const range = document.createRange();
            range.selectNodeContents(requireElement(pre, 'FileViewer pre'));
            const selection = document.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            requireElement(pre, 'FileViewer pre').focus();
          },
        },
      ]}
    >
      <pre
        ref={(element) => {
          pre = element;
        }}
        tabindex="0"
        class="file-content selectable-source"
        aria-label={'Source of ' + props.path}
      >
        {props.source}
      </pre>
    </ContextArea>
  );
}
