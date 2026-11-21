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

/** CSS results belong to one synchronous serialization. Never reuse this
 * reader after an await, when page styles or message ownership can change. */
export function createVisibilityReader(): (element: Element) => boolean {
  const styles = new Map<Element, { hiddenLayout: boolean; hiddenVisibility: boolean }>();
  return (element: Element): boolean => {
    for (let ancestor: Element | null = element; ancestor; ancestor = parentAcrossShadow(ancestor)) {
      let style = styles.get(ancestor);
      if (!style) {
        const computed = getComputedStyle(ancestor);
        style = {
          hiddenLayout:
            ancestor.hasAttribute('hidden') ||
            computed.display === 'none' ||
            computed.contentVisibility === 'hidden',
          hiddenVisibility: computed.visibility === 'hidden' || computed.visibility === 'collapse',
        };
        styles.set(ancestor, style);
      }
      // A child may override inherited visibility. Display/content-visibility
      // hiding on any ancestor still hides the entire subtree.
      if (style.hiddenLayout || (ancestor === element && style.hiddenVisibility)) {
        return true;
      }
    }
    return false;
  };
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

export const composerSelector =
  '#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,textarea[data-testid="composer-input"],[contenteditable="true"][data-testid="composer-input"],form [contenteditable="true"][role="textbox"]';

function generationElementVisible(element: HTMLElement): boolean {
  return (
    !contentHidden(element) &&
    !element.closest('pre,code,blockquote,nav,aside,[data-mitter-ui],#mitter-automation-control')
  );
}

function activeGenerationStop(element: HTMLElement): boolean {
  const knownControl = element.matches(generationStopSelector);
  if (!knownControl && !element.matches('button[aria-label="Stop" i]')) {
    return false;
  }
  if (
    element.matches(':disabled') ||
    element.getAttribute('aria-disabled') === 'true' ||
    !generationElementVisible(element)
  ) {
    return false;
  }
  if (knownControl) {
    return true;
  }

  // New composer layouts retain the accessible Stop label but omit the old ID.
  // A generic Stop elsewhere in the page must not hold or cancel this reply.
  const composer = element.closest('form')?.querySelector(composerSelector);
  return composer instanceof HTMLElement && !contentHidden(composer);
}

export function generationStopControls(): HTMLElement[] {
  return pageElements().elements.filter(activeGenerationStop);
}

export function generationActive(): boolean {
  return pageElements().elements.some(
    (element) =>
      (element.matches('[data-is-streaming="true"]') && generationElementVisible(element)) ||
      activeGenerationStop(element),
  );
}
