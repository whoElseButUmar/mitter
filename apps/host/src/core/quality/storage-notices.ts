/** Runs inside Chrome. Match complete boilerplate lines, leaving warnings and action feedback intact. */
export function routineStorageNotices(initial: boolean): string[] {
  const findings = new Set<string>();
  const context =
    /\b(?:settings|preferences|privacy|(?:data|browser|local) storage|storage (?:options|notice)|backup and restore)\b/i;
  const headings = 'h1,h2,h3,h4,[role="heading"],legend';
  const visible = (element: Element) =>
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  if (
    /\/(?:privacy|settings|preferences)(?:[/.]|$)/i.test(location.pathname) ||
    Array.from(document.querySelectorAll('h1,[role="heading"][aria-level="1"]')).some(
      (heading) => visible(heading) && context.test(heading.textContent ?? ''),
    )
  ) {
    return [];
  }
  const landmarks = 'section,article,dialog,form,fieldset,[role="dialog"],[role="region"],[role="tabpanel"]';
  function inSettings(element: Element): boolean {
    for (
      let region = element.closest(landmarks);
      region;
      region = region.parentElement?.closest(landmarks) ?? null
    ) {
      const label = region.getAttribute('aria-label') ?? '';
      const ids = (region.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
      if (
        context.test(label) ||
        ids.some((id) => context.test(document.getElementById(id)?.textContent ?? ''))
      ) {
        return true;
      }
      const heading = region.querySelector(headings);
      if (
        heading &&
        visible(heading) &&
        heading.closest(landmarks) === region &&
        context.test(heading.textContent ?? '')
      ) {
        return true;
      }
    }
    return false;
  }
  const place = '(?:in|on|to) (?:this|your|the) (?:web )?(?:browser|device|computer)';
  const locationText = '(?:locally(?: ' + place + ')?|' + place + '(?: ' + place + ')?)';
  const subject =
    '(?:(?:all|your|this|the) ){0,2}(?:(?:register|app|project|member|board) )?(?:data|inventory|records|entries|items|projects|tickets|changes|lists)';
  const statement = new RegExp(
    '^' +
      subject +
      ' (?:(?:is|are) (?:only )?(?:saved|stored|kept)(?: only)?|stays?|remains?) (?:only )?' +
      locationText +
      '(?: only)?$',
    'i',
  );
  const quietLabel = new RegExp(
    '^(?:local(?:-only)? (?:register|workspace|board|ledger|list|storage)|(?:saved|stored) ' +
      locationText +
      ')$',
    'i',
  );
  const excluded =
    headings +
    ',nav,[role="navigation"],a,button,label,pre,code,td,li,option,[role="alert"],[role="log"],[role="button"],[contenteditable="true"]';
  for (const element of document.querySelectorAll(
    'p,span,small,div,header,footer,aside,output,[aria-live],[role="status"]',
  )) {
    if (!(element instanceof HTMLElement) || element.closest(excluded) || element.childElementCount > 2) {
      continue;
    }
    const words = element.textContent?.trim() ?? '';
    if (!words || words.length > 140 || !/\b(?:browser|device|computer|local|locally)\b/i.test(words)) {
      continue;
    }
    if (
      !visible(element) ||
      element.querySelector(headings + ',p,div,button,a,input,label,time,[role],[aria-live]')
    ) {
      continue;
    }
    const text = element.innerText.replace(/\s+/g, ' ').trim();
    const line = text.replace(/\.$/, '');
    const feedback = element.closest('output,[role="status"],[aria-live]');
    if (feedback && !initial) {
      continue;
    }
    const idle = initial && quietLabel.test(line);
    if ((idle || statement.test(line)) && !inSettings(element)) {
      if (element.id && document.querySelector('[aria-labelledby~="' + CSS.escape(element.id) + '"]')) {
        continue;
      }
      findings.add(text);
      if (findings.size === 20) {
        break;
      }
    }
  }
  return [...findings];
}
