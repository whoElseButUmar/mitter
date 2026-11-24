import { For, Show, createSignal } from 'solid-js';
import type { PreviewElement } from '../../../../packages/protocol/src/rpc';

export function PreviewCaptureGallery(props: { elements: PreviewElement[] }) {
  const [active, setActive] = createSignal(0);
  const current = () => props.elements[active()] ?? props.elements[0];

  return (
    <Show when={current()}>
      {(element) => (
        <figure class="element-selection">
          <img
            class="capture-preview"
            src={element().screenshot}
            alt={'Captured ' + (element().name || element().role)}
          />
          <Show when={props.elements.length > 1}>
            <div class="capture-thumbnails" role="group" aria-label="Preview captures">
              <For each={props.elements}>
                {(capture, index) => (
                  <button
                    type="button"
                    aria-label={'Capture ' + (index() + 1) + ': ' + (capture.name || capture.role)}
                    aria-pressed={active() === index()}
                    onClick={() => setActive(index())}
                  >
                    <img src={capture.screenshot} alt="" />
                  </button>
                )}
              </For>
            </div>
          </Show>
          <figcaption>
            <strong>{element().name || element().role}</strong>
            <details>
              <summary>Selection details</summary>
              <p>
                {element().route} · {element().viewport.width} × {element().viewport.height}
              </p>
              <code>
                {element().role} · {element().selector}
              </code>
              <p>The task includes the element details. Screenshots stay in Miter.</p>
            </details>
          </figcaption>
        </figure>
      )}
    </Show>
  );
}
