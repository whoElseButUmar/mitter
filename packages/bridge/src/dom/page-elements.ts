export function parentAcrossShadow(element: Element): Element | null {
  if (element.parentElement) {
    return element.parentElement;
  }
  const rootNode = element.getRootNode();
  if (rootNode instanceof ShadowRoot) {
    return rootNode.host;
  }
  return null;
}

export function htmlElements(root: ParentNode, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll(selector)).filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );
}

/** Visibility is about CSS, not intersection with the scroll viewport. An older
 * message scrolled offscreen may still be a real message; a hidden mirror is not.
 */
export function contentHidden(element: Element): boolean {
  const elementStyle = getComputedStyle(element);
  if (elementStyle.visibility === 'hidden' || elementStyle.visibility === 'collapse') {
    return true;
  }
  for (let ancestor: Element | null = element; ancestor; ancestor = parentAcrossShadow(ancestor)) {
    const ancestorStyle = getComputedStyle(ancestor);
    if (
      ancestor.hasAttribute('hidden') ||
      ancestorStyle.display === 'none' ||
      ancestorStyle.contentVisibility === 'hidden'
    ) {
      return true;
    }
  }
  return false;
}

/** A bounded, read-only composed-tree scan. Open shadow roots are inspectable;
 * closed roots and iframe documents are not bypassed. No page-private state,
 * network requests, clipboard reads, or executable source are involved.
 */
export function pageElements(): {
  elements: HTMLElement[];
  shadows: number;
  limited: boolean;
} {
  const elements: HTMLElement[] = [];
  const pendingElements: Element[] = [];
  let shadowCount = 0;
  let limited = false;
  if (document.documentElement) {
    pendingElements.push(document.documentElement);
  }
  while (pendingElements.length) {
    const element = pendingElements.pop();
    if (!element) {
      break;
    }
    if (elements.length >= 24000) {
      limited = true;
      break;
    }
    if (element instanceof HTMLElement) {
      elements.push(element);
    }
    if (
      element.matches('script,style,template,svg,iframe,pre,code,#mitter-automation-control,[data-mitter-ui]')
    ) {
      continue;
    }
    const shadow = element.shadowRoot;
    if (shadow) {
      if (shadowCount >= 24) {
        limited = true;
        continue;
      }
      shadowCount++;
      pendingElements.push(...Array.from(shadow.children).reverse());
    } else {
      pendingElements.push(...Array.from(element.children).reverse());
    }
  }
  return { elements, shadows: shadowCount, limited };
}

/** One generation detector shared by inspect, explicit reply preview, prepare
 * and commit. In particular, roleless response rows must not lose their global
 * streaming marker just because normal transcript discovery has no assistant. */
const generationStopSelector =
  'button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating" i],button[aria-label="Stop streaming" i],button[aria-label="Stop response" i],button#composer-submit-button[aria-label="Stop" i]';

function generationElementVisible(element: HTMLElement): boolean {
  return (
    !contentHidden(element) &&
    !element.closest('pre,code,blockquote,nav,aside,[data-mitter-ui],#mitter-automation-control')
  );
}

export function generationStopControls(): HTMLElement[] {
  return pageElements().elements.filter(
    (element) =>
      element.matches(generationStopSelector) &&
      generationElementVisible(element) &&
      !element.matches(':disabled') &&
      element.getAttribute('aria-disabled') !== 'true',
  );
}

export function generationActive(): boolean {
  return pageElements().elements.some(
    (element) =>
      generationElementVisible(element) &&
      (element.matches('[data-is-streaming="true"]') ||
        (element.matches(generationStopSelector) &&
          !element.matches(':disabled') &&
          element.getAttribute('aria-disabled') !== 'true')),
  );
}
