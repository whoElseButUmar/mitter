export function requiredElement<ElementType extends HTMLElement>(
  root: HTMLElement,
  selector: string,
  elementConstructor: { new (): ElementType },
): ElementType {
  const element = root.querySelector(selector);
  if (!(element instanceof elementConstructor)) {
    throw new Error(`The sheet is missing its ${selector} element or it has the wrong type.`);
  }
  return element;
}
