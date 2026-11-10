import { onCleanup, onMount } from 'solid-js';
import { requireElement } from '../ui/dom';
import { bindSandboxPreview } from '../ui/sandbox-preview';

export function SandboxedDocument(props: { html: string }) {
  let frame: HTMLIFrameElement | undefined;
  onMount(() => {
    const dispose = bindSandboxPreview(requireElement(frame, 'file preview frame'), () => props.html);
    onCleanup(dispose);
  });

  return (
    <iframe
      ref={(element) => {
        frame = element;
      }}
      title="Rendered file preview"
      class="rendered-document"
      src={chrome.runtime.getURL('/preview-sandbox.html')}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
    />
  );
}
