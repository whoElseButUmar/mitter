/** Runs in Chrome after each journey step. Record data can legitimately repeat
 * across columns or records. Only compare static labels in the same group. */
export function repeatedRecordLabels(): string[] {
  const findings = new Set<string>();
  const record =
    'article,li,tr,[role="article"],[role="listitem"],[role="row"],[data-record],[data-row],.record,.card,.row,[class$="-row"],[class$="-card"],[class$="-item"]';
  const inline = 'span,small,b,strong,em';
  const label = ':is(' + inline + ',p,div)';
  const controls =
    'a,button,label,input,select,textarea,output,form,nav,th,dt,h1,h2,h3,h4,h5,h6,[role="heading"],[role="button"],[role="link"],[role="tab"],[role="option"],[contenteditable="true"]';
  const status = /(?:^|[\s_-])(?:status|state|badge|chip|pill)(?:$|[\s_-])/i;
  const actionGroup = /(?:^|[\s_-])(?:actions|badges|statuses)(?:$|[\s_-])/i;
  function labelKind(node: HTMLElement): 'status' | 'plain' | 'field' {
    let part = node;
    while (true) {
      if (part.matches('[role="status"],[data-status]') || status.test(part.className)) {
        return 'status';
      }
      if (part.className && !/(?:^|[\s_-])label(?:$|[\s_-])/i.test(part.className)) {
        return 'field';
      }
      const child = part.firstElementChild;
      if (part.children.length !== 1 || !(child instanceof HTMLElement) || !child.matches(inline)) {
        return 'plain';
      }
      part = child;
    }
  }
  function displayText(node: HTMLElement): string {
    if (
      node.matches(
        '[aria-label],[aria-labelledby],[data-field],[itemprop],[role="cell"],[role="gridcell"]',
      ) ||
      node.closest(controls) ||
      node.querySelector(':not(' + inline + ',svg[aria-hidden="true"],svg[aria-hidden="true"] *)') ||
      !node.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    ) {
      return '';
    }
    // checkVisibility includes clipped text used by screen readers.
    const box = node.getBoundingClientRect();
    if (
      box.width <= 1 ||
      box.height <= 1 ||
      node.closest('.sr-only,.ui-sr-only,.visually-hidden,.screen-reader-text')
    ) {
      return '';
    }
    const style = getComputedStyle(node);
    if (style.clipPath === 'inset(50%)' || style.clip === 'rect(0px, 0px, 0px, 0px)') {
      return '';
    }
    const text = node.innerText.replace(/\s+/g, ' ').trim();
    if (text.length > 64 || !/^\p{L}[\p{L}\p{M}\d'’ -]*$/u.test(text) || text.split(' ').length > 6) {
      return '';
    }
    return text;
  }
  for (const right of document.querySelectorAll(label + ' + ' + label)) {
    const left = right.previousElementSibling;
    const group = right.parentElement;
    if (!(right instanceof HTMLElement) || !(left instanceof HTMLElement) || !group?.closest(record)) {
      continue;
    }
    const kinds = [labelKind(left), labelKind(right)];
    if (kinds.includes('field') || (!kinds.includes('status') && !actionGroup.test(group.className))) {
      continue;
    }
    const text = displayText(right);
    if (text && text.toLowerCase() === displayText(left).toLowerCase()) {
      findings.add(text);
      if (findings.size === 20) {
        break;
      }
    }
  }
  return [...findings];
}
