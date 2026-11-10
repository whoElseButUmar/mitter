export function requireElement<ElementType extends HTMLElement>(
  element: ElementType | null | undefined,
  description: string,
): ElementType {
  if (!element) {
    throw new Error('Miter could not mount ' + description + '.');
  }
  return element;
}

export function syncInputValidity(input: HTMLInputElement | HTMLTextAreaElement): void {
  if (input.matches(':user-invalid')) {
    input.setAttribute('aria-invalid', 'true');
  } else {
    input.removeAttribute('aria-invalid');
  }
}
