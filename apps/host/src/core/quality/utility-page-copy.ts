/** Runs in Chrome. Inspect the page title, masthead and footer of an interactive work screen. */
export function utilityPageCopy() {
  const found: { kind: 'header' | 'subtitle' | 'footer' | 'empty'; text: string; tag: string }[] = [];
  const main = document.querySelector('main,[role="main"]') ?? document.body;
  const visible = (node: Element) =>
    node.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const excluded = 'article,aside,dialog,nav,address,[role="dialog"],[role="navigation"]';
  const workArea = Array.from(
    main.querySelectorAll(
      'input:not([type="hidden"]),select,textarea,[contenteditable="true"],[role="grid"],[role="tree"],[role="listbox"]',
    ),
  ).some((node) => visible(node) && !node.closest(excluded + ',header,footer,[role="search"]'));
  const hasRecords = Array.from(main.querySelectorAll('table,[role="table"],[role="list"],ul,ol')).some(
    (node) => visible(node) && !node.closest(excluded + ',header,footer'),
  );
  const protectedContent =
    'a,button,input,select,textarea,label,output,time,data,kbd,code,address,nav,' +
    'img,svg,[aria-live],[aria-label],[aria-labelledby],[role]:not([role="contentinfo"]),[itemprop],[data-tenant],[data-organization],[data-location]';
  const isTarget = (node: Element) =>
    node.id &&
    document.querySelector(
      ['aria-labelledby', 'aria-describedby', 'aria-details', 'aria-errormessage', 'for']
        .map((attribute) => '[' + attribute + '~="' + CSS.escape(node.id) + '"]')
        .join(',') +
        ',a[href="#' +
        CSS.escape(node.id) +
        '"]',
    );
  // Compare the complete paired claims. An extra qualifier, reason or action carries new information.
  const outcomes: Record<string, string> = {
    payment: 'paid',
    review: 'reviewed',
    approval: 'approved',
    assignment: 'assigned',
    signature: 'signed',
    repair: 'repaired',
  };
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!]$/, '');
  for (const state of main.querySelectorAll('.empty-state,[data-empty-state],[class~="emptyState"]')) {
    const heading = state.querySelector(':scope > :is(strong,b,h1,h2,h3,h4,h5,h6,[role="heading"])');
    const note = heading?.nextElementSibling;
    if (
      !(heading instanceof HTMLElement) ||
      !(note instanceof HTMLElement) ||
      !note.matches('span,p,small,div') ||
      !visible(heading) ||
      !visible(note) ||
      note.matches(protectedContent) ||
      note.querySelector(protectedContent) ||
      [note, ...note.querySelectorAll('[id]')].some(isTarget)
    ) {
      continue;
    }
    const label = normalize(heading.innerText);
    const text = note.innerText.replace(/\s+/g, ' ').trim();
    const detail = normalize(text);
    if (!/^no\b/.test(label) || !detail || label.length > 180 || text.length > 180) {
      continue;
    }
    const pending = /^no ([a-z-]+(?: [a-z-]+){0,2}) (?:need|require|await) (?:an? )?([a-z]+)$/.exec(label);
    const undone = /^no un([a-z]+) ([a-z-]+(?: [a-z-]+){0,2})$/.exec(label);
    const complete = /^all (?:recorded |listed )?([a-z-]+(?: [a-z-]+){0,2}) (?:are|have been) ([a-z]+)$/.exec(
      detail,
    );
    const records = pending?.[1] ?? undone?.[2];
    const outcome = outcomes[pending?.[2] ?? ''] ?? undone?.[1];
    if (label === detail || (complete && complete[1] === records && complete[2] === outcome)) {
      found.push({ kind: 'empty', text, tag: note.localName });
      if (found.length === 20) {
        return found;
      }
    }
  }
  if (!workArea && !(hasRecords && main.querySelector('button,[role="button"]'))) {
    return found;
  }
  function inertText(element: Element | null): string {
    if (
      !(element instanceof HTMLElement) ||
      !visible(element) ||
      element.closest(excluded) ||
      element.matches(protectedContent) ||
      element.querySelector(protectedContent) ||
      /(?:^|[\s_-])(?:tenant|location|organi[sz]ation|credit|copyright|legal|empty|warning|error|feedback|status|receipt|notice)(?:$|[\s_-])/i.test(
        element.className + ' ' + element.id,
      ) ||
      [element, ...element.querySelectorAll('[id]')].some(isTarget)
    ) {
      return '';
    }
    return element.innerText.replace(/\s+/g, ' ').trim();
  }
  // Keep instructions tied to an operation, conditions, real constraints, empty states and credit/legal copy.
  const purposeful =
    /\b(?:press|tap|click|use|enter|choose|select|scan|drag|swipe|type|hold|sign in|contact|confirm|retry|undo|remember|start by|before|after|until|when|unless|only|must|cannot|required|minimum|maximum|limit|up to|at least|depend\w*|varies|due|deadline|per|each|except|expires?|no|not|none|nothing|empty|yet|error|failed|unable|offline|unsaved|successfully|privacy|terms|licen[cs]e|copyright|credits?|attribution|rights reserved|provided by|powered by|created by|designed by|maintained by|tax|fees?)\b|[\d©®:@?!]/i;
  // Storage copy has its own rules for settings, explicit privacy notices and post-action feedback.
  const storageCopy = /\b(?:browser|device|locally|local storage|backups?)\b/i;
  const textBlock = 'p,small,span,div';
  const titles = 'h1,[role="heading"][aria-level="1"]';
  for (const title of main.querySelectorAll(titles)) {
    if (!visible(title) || title.closest(excluded + ',form,footer,li')) {
      continue;
    }
    // Designers often wrap the h1 for layout while its description sits in the enclosing section.
    let titleBlock = title;
    while (
      !titleBlock.nextElementSibling &&
      titleBlock.parentElement !== main &&
      titleBlock.parentElement?.matches('div,header,section,hgroup') &&
      titleBlock.parentElement.children.length === 1
    ) {
      titleBlock = titleBlock.parentElement;
    }
    let note = titleBlock.nextElementSibling;
    while (note?.matches('div') && note.children.length === 1) {
      note = note.firstElementChild;
    }
    if (
      !note?.matches(textBlock) ||
      !titleBlock.parentElement?.matches('header,section,hgroup,div,main,[role="main"]') ||
      note.querySelector('section,article,form,h1,h2,h3,li,table,p,div')
    ) {
      continue;
    }
    const text = inertText(note);
    const directInstruction =
      /^\p{L}+ (?:the|a|an|your|this|that|each)\b/iu.test(text) &&
      !/^(?:track|browse|manage|organize|monitor|view|review)\b/i.test(text);
    if (
      text.length < 8 ||
      text.length > 180 ||
      purposeful.test(text) ||
      storageCopy.test(text) ||
      directInstruction ||
      /\b(?:closed|disabled|unavailable|blocked|cancelled|canceled|pending|paused|overdue|out of service|waiting for)\b/i.test(
        text,
      ) ||
      !/^[\p{L}][\p{L}\p{M}’', -]+[.!]?$/u.test(text) ||
      text.split(/\s+/).length < 4
    ) {
      continue;
    }
    // These are statements of purpose, not operational instructions or units of record data.
    if (
      /[.]$/.test(text) ||
      /(?:intro|subtitle|description|subhead|lede|lead|summary)/i.test(note.className)
    ) {
      found.push({ kind: 'subtitle', text, tag: note.localName });
    }
  }
  const words = (text: string) =>
    (text.toLowerCase().match(/[\p{L}]+/gu) ?? [])
      .filter((word) => word.length > 2)
      .map((word) => word.replace(/([^aeiou])ies$/, '$1y').replace(/([^s])s$/, '$1'));
  const topics = new Set(
    [...main.querySelectorAll('h1,h2,h3,label,legend,th,button')]
      .filter(visible)
      .flatMap((node) => words(node.textContent ?? '')),
  );
  for (const footer of document.querySelectorAll('footer,[role="contentinfo"]')) {
    if (
      footer.closest(excluded + ',section,form') ||
      footer.matches('.credit,.credits,.copyright,[data-credit]') ||
      footer.querySelector('.credit,.credits,.copyright,[data-credit]')
    ) {
      continue;
    }
    const text = inertText(footer);
    if (
      text.length < 12 ||
      text.length > 180 ||
      purposeful.test(text) ||
      storageCopy.test(text) ||
      !words(text).some((word) => topics.has(word))
    ) {
      continue;
    }
    if (
      /\b(?:remain|stay|appear|show|move|keep)s?\b|\b(?:go|goes)\s+(?:in|to)\b|\b(?:is|are|will be|can be)\s+\w+(?:ed|en)\b|^(?:manage|track|browse|organize|review)\b/i.test(
        text,
      )
    ) {
      found.push({ kind: 'footer', text, tag: footer.localName });
    }
  }
  // A short generic site role identifies the kind of tool, not a named tenant or a person.
  for (const brand of document.querySelectorAll('header a[href],[role="banner"] a[href]')) {
    const header = brand.parentElement;
    if (
      !header?.matches('header,[role="banner"]') ||
      header.children.length !== 2 ||
      !(
        brand.matches('.brand,.wordmark,[data-brand]') ||
        ['/', '#'].includes(brand.getAttribute('href') ?? '')
      )
    ) {
      continue;
    }
    const note = brand.nextElementSibling ?? brand.previousElementSibling;
    const text = inertText(note);
    // Require supporting domain evidence from the page, never infer an organization from its name alone.
    const domain = words(text)[0] ?? '';
    const metadata = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
    if (
      note?.matches('span,small,p') &&
      /(?:^|[-_\s])(?:label|note|descriptor)(?:$|[-_\s])/.test(note.className) &&
      (topics.has(domain) || words(metadata).includes(domain) || words(note.className).includes(domain)) &&
      /^[\p{Lu}]?[\p{Ll}]+(?: [\p{Ll}]+){0,2} (?:desk|dashboard|workspace|portal|tracker|manager|console)$/u.test(
        text,
      )
    ) {
      found.push({ kind: 'header', text, tag: note.localName });
    }
  }
  return found.slice(0, 20);
}
