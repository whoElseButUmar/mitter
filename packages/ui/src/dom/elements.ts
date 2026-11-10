export function requireWindow(document: Document): Window & typeof globalThis {
  const window = document.defaultView;

  if (!window) {
    throw new Error('This UI requires a document attached to a window.');
  }

  return window;
}

/** The constructor is checked at runtime, not asserted by a selector generic. */
export function requireElement<T extends Element>(
  root: ParentNode,
  selector: string,
  constructor: { new (): T },
): T {
  const element = root.querySelector(selector);

  if (!(element instanceof constructor)) {
    throw new Error('Missing or invalid UI element: ' + selector);
  }

  return element;
}

export function isNode(document: Document, value: EventTarget | null): value is Node {
  return value instanceof requireWindow(document).Node;
}

export function isElement(document: Document, value: EventTarget | null): value is Element {
  return value instanceof requireWindow(document).Element;
}

export function isHTMLElement(document: Document, value: EventTarget | null): value is HTMLElement {
  return value instanceof requireWindow(document).HTMLElement;
}

export function textElement<Tag extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: Tag,
  text = '',
  className = '',
): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  element.textContent = text;

  if (className) {
    element.className = className;
  }

  return element;
}

/** Use only for algorithm indices whose bounds are part of the invariant. */
export function requireItem<T>(items: ArrayLike<T>, index: number): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error('UI algorithm index is out of bounds: ' + index);
  }

  return item;
}
