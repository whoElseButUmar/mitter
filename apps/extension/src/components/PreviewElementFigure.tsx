import type { PreviewElement } from '../../../../packages/protocol/src/rpc';

export function PreviewElementFigure(props: { element: PreviewElement }) {
  return (
    <figure class="element-selection">
      <img
        src={props.element.screenshot}
        alt={'Selected ' + props.element.role + ' on ' + props.element.route}
      />
      <figcaption>
        <strong>{props.element.name || props.element.role}</strong>
        <details>
          <summary>Selection details</summary>
          <p>
            {props.element.route} · {props.element.viewport.width} × {props.element.viewport.height}
          </p>
          <code>
            {props.element.role} · {props.element.selector}
          </code>
          <p>The task includes these element details. The screenshot stays in Miter.</p>
        </details>
      </figcaption>
    </figure>
  );
}
