/** Runs inside Chrome. Compare heading descriptions with controls in the same rendered view. */
export function redundantSubtitles(): string[] {
  const headings = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  const controls = 'button,a[href],input:not([type="hidden"]),select,textarea,[role="button"]';
  const functional = 'label,output,[aria-live],[role="status"],[role="alert"],[role="log"]';
  const copyBlock = 'p,small,span,div';
  const found = new Set<string>();
  const vocabulary = new Map<Element, Set<string>>();

  function visible(element: Element): element is HTMLElement {
    if (
      !(element instanceof HTMLElement) ||
      !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    ) {
      return false;
    }
    const bounds = element.getBoundingClientRect();
    return bounds.width > 1 && bounds.height > 1;
  }

  // Normalize ordinary English plurals so a "Record payment" button supplies "payments".
  function words(text: string): string[] {
    return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((word) =>
      word.replace(/([^aeiou])ies$/, '$1y').replace(/([^s])s$/, '$1'),
    );
  }

  function controlWords(scope: Element): Set<string> {
    let known = vocabulary.get(scope);
    if (known) {
      return known;
    }
    known = new Set<string>();
    for (const item of scope.querySelectorAll([headings, controls, 'label,th,legend'].join(','))) {
      if (visible(item)) {
        const labels = [item.innerText, item.getAttribute('aria-label'), item.getAttribute('placeholder')];
        for (const word of words(labels.join(' '))) {
          known.add(word);
        }
      }
    }
    vocabulary.set(scope, known);
    return known;
  }

  const selection = /^(?:choose|select|pick) (?:a |an |the |one )?([\p{L}-]+)\b/iu;
  for (const heading of document.querySelectorAll(headings)) {
    if (!visible(heading)) {
      continue;
    }
    const wrapper = heading.parentElement;
    let description = heading.nextElementSibling;
    if (!description && wrapper?.children.length === 1) {
      description = wrapper.nextElementSibling;
    }
    if (
      !description?.matches(copyBlock) ||
      !visible(description) ||
      description.closest(functional) ||
      description.querySelector([headings, controls, functional, 'img,svg,time'].join(','))
    ) {
      continue;
    }
    const text = description.innerText.replace(/\s+/g, ' ').trim();
    if (
      !text ||
      text.length > 180 ||
      /[\d:;?!]/.test(text) ||
      /\b(?:before|after|only|must|cannot|required|except|until|when|unless|without)\b/i.test(text) ||
      (description.id &&
        document.querySelector(
          ':is(' + controls + ')[aria-describedby~="' + CSS.escape(description.id) + '"]',
        ))
    ) {
      continue;
    }
    const scope =
      heading.closest('section,article,dialog,[role="region"],[role="dialog"],main') ?? document.body;
    if (!scope.querySelector(controls)) {
      continue;
    }
    const terms = words(text);
    const title = words(heading.innerText);

    // Leave the empty-state instruction in place. Only flag a heading that repeats its choice
    // and names a destination already identified by the heading (e.g. "to view their card").
    const choice = selection.exec(text);
    if (choice) {
      const destination =
        /^ to (?:see|view|preview|open) (?:its |their |the |a |an )?([\p{L}-]+)[.!]?$/iu.exec(
          text.slice(choice[0].length),
        );
      if (
        destination?.[1] &&
        title.includes(words(destination[1])[0] ?? '') &&
        Array.from(scope.querySelectorAll('p,small')).some(
          (other) =>
            !description.contains(other) &&
            !other.contains(description) &&
            visible(other) &&
            selection.exec(other.innerText.trim())?.[1]?.toLowerCase() === choice[1]?.toLowerCase(),
        )
      ) {
        found.add(text);
      }
      continue;
    }
    const repeatsHeading = title.join(' ') === terms.join(' ');
    const listsFeatures =
      /\band\b|,|\.\s+\p{L}|^(?:manage|track|view|browse|organize|review|search|filter)\b/iu.test(text);
    if (repeatsHeading) {
      found.add(text);
    } else if (listsFeatures && terms.length <= 16) {
      const topics = terms.filter(
        (term) => !/^(?:a|an|the|your|and|manage|track|view|browse|organize|review)$/.test(term),
      );
      const known = controlWords(scope);
      if (topics.length && topics.every((term) => known.has(term))) {
        found.add(text);
      }
    }
    if (found.size >= 20) {
      break;
    }
  }
  return [...found].slice(0, 20);
}
