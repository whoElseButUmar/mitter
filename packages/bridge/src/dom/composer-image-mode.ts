import { contentHidden, htmlElements } from './page-elements.js';

export const composerImageModePill =
  '[data-inline-selection-pill][data-system-hint-type="picture_v2"][data-prompt-link-href="chatgpt-system-hint://picture_v2"]';

export const sentImageModePill =
  '[data-prompt-link-href="chatgpt-system-hint://picture_v2"][data-prompt-link-label="Create image"][data-layout="selection-pill"]';

export type ImageModeSelection = 'opening' | 'selecting';

function usableButton(element: HTMLElement): element is HTMLButtonElement {
  return (
    element instanceof HTMLButtonElement &&
    !element.disabled &&
    element.getAttribute('aria-disabled') !== 'true' &&
    !contentHidden(element)
  );
}

/** The picker lives in a portal. Require the owned composer's open control
 * and one visible provider option before selecting it. */
export function advanceImageModeSelection(
  composer: HTMLElement,
  previous: ImageModeSelection | undefined,
  beforeClick: (next: ImageModeSelection) => void,
): void {
  const form = composer.closest('form');
  if (!form || previous === 'selecting') {
    return;
  }

  const pickers = htmlElements(
    form,
    'button[data-composer-navigation-target="add-context"][aria-label="Add files and more"]',
  ).filter(usableButton);
  const picker = pickers[0];
  if (!picker || pickers.length !== 1) {
    return;
  }

  if (picker.getAttribute('aria-expanded') === 'true') {
    const options = htmlElements(
      document,
      '[data-mention-section-id="chatgpt-primary"] button[data-list-navigation-item]',
    ).filter((button) => {
      const row = button.querySelector('[data-menu-row-content]');
      return (
        usableButton(button) &&
        !!row &&
        /^Create image\s*Visualize anything$/.test((row.textContent || '').trim())
      );
    });
    const option = options[0];
    if (option && options.length === 1) {
      beforeClick('selecting');
      option.click();
    }
    return;
  }

  // A closed picker that we already asked to open may have been dismissed.
  if (previous === undefined && picker.getAttribute('aria-expanded') === 'false') {
    beforeClick('opening');
    picker.click();
  }
}
