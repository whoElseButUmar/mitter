import { contentHidden, htmlElements } from './page-elements.js';

export function hasStreamRetry(root: ParentNode): boolean {
  return htmlElements(root, 'button,[role="button"]').some(
    (button) =>
      (button.getAttribute('aria-label') || button.textContent || '').trim() === 'Retry' &&
      !button.closest('pre,code,blockquote,form') &&
      !contentHidden(button),
  );
}

const outputSelector = '.bg-execution-output > pre.text-execution-output[tabindex="0"]';

function isAnalysisHeader(header: Element | null | undefined): header is HTMLElement {
  return (
    header instanceof HTMLElement &&
    header.classList.contains('group/activity-header') &&
    header.innerText.trim() === 'Analyzed'
  );
}

/** ChatGPT can quote a full handoff, nonce included, in its Python source or stdout. */
export function isAnalysisCode(element: HTMLElement): boolean {
  if (element.closest(outputSelector)) {
    return true;
  }
  const source = element.closest('[data-code-block="true"]');
  if (!source) {
    return false;
  }
  for (let node = source.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
    const header = node.previousElementSibling;
    if (isAnalysisHeader(header) && header.querySelector(':scope > button[aria-expanded="true"]')) {
      return true;
    }
  }
  return false;
}

const visible = (node: HTMLElement): string => node.innerText.replace(/\s+/g, ' ').trim();

/** Decorative search-result favicons can remain mounted inside ChatGPT's
 * closed web activity. Visible media and images in other branches still
 * count as intervening content. */
export function hasOnlyHiddenSearchIcons(activity: HTMLElement, toggle: HTMLElement): boolean {
  const icons = htmlElements(activity, 'img');
  if (!icons.length) {
    return true;
  }
  const header = toggle.parentElement;
  const label = toggle.nextElementSibling;
  const stack = activity.parentElement;
  if (
    !stack?.matches('[data-spacing="activity"]') ||
    !stack.closest('[data-talvt-turn-state="complete"]') ||
    !activity.querySelector('[data-chatgpt-agent-turn-start][hidden]') ||
    !header?.classList.contains('group/activity-header') ||
    !toggle.matches('button[type="button"][aria-expanded="false"]') ||
    !label?.id ||
    toggle.getAttribute('aria-labelledby') !== label.id ||
    !label.textContent?.trim().startsWith('Worked for ')
  ) {
    return false;
  }
  return icons.every((icon) => {
    const search = icon.closest('[class~="group/activity-header"]');
    const details = search?.closest('[data-spacing="activity"]');
    return (
      !!search &&
      !!details &&
      activity.contains(details) &&
      !!details.parentElement?.hidden &&
      /^Searched the web for\s+\S/.test(search.textContent?.trim() || '') &&
      icon.matches('img[alt=""][src^="https://www.google.com/s2/favicons?"]') &&
      contentHidden(icon)
    );
  });
}

function readAnalysisPanel(toggle?: HTMLElement, copy?: HTMLElement) {
  const header = toggle?.parentElement;
  const panel = header?.parentElement;
  if (!toggle || !panel || !isAnalysisHeader(header)) {
    return;
  }
  if (toggle.matches('button[type="button"][aria-expanded="false"]')) {
    if (
      panel.children.length === 1 &&
      header.children.length === 3 &&
      header.children[0] === toggle &&
      header.children[1]?.matches('span') &&
      header.children[1].textContent?.trim() === 'Analyzed' &&
      header.children[2]?.matches('span') &&
      header.children[2].textContent?.trim() === '' &&
      toggle.childElementCount === 0 &&
      toggle.innerText.trim() === '' &&
      visible(panel) === 'Analyzed' &&
      !header.querySelector('a,code,pre')
    ) {
      return { panel };
    }
    return;
  }
  const body = header.nextElementSibling;
  if (
    header.querySelector(':scope > button[aria-expanded="true"]') !== toggle ||
    panel.children.length !== 2 ||
    !(body instanceof HTMLElement) ||
    !copy ||
    (copy.getAttribute('aria-label') || copy.title || copy.innerText).trim() !== 'Copy code'
  ) {
    return;
  }
  const source = body.querySelector('[data-code-block="true"]');
  const stdout = source?.nextElementSibling;
  const output = stdout?.querySelector(outputSelector);
  const toolbar = source?.firstElementChild;
  const code = source?.lastElementChild?.firstElementChild;
  if (
    !source ||
    source.parentElement?.children.length !== 2 ||
    source.children.length !== 2 ||
    !(toolbar instanceof HTMLElement) ||
    !toolbar.contains(copy) ||
    !/^Python(?:\s+Copy code)?$/.test(toolbar.innerText.trim()) ||
    !(code instanceof HTMLElement) ||
    !code.matches('code') ||
    !(stdout instanceof HTMLElement) ||
    !(output instanceof HTMLElement)
  ) {
    return;
  }
  const stdoutText = visible(stdout);
  const outputText = visible(output);
  const bodyText = visible(body);
  if (
    (stdoutText !== outputText && stdoutText !== ('STDOUT/STDERR ' + outputText).trim()) ||
    bodyText !== [visible(toolbar), visible(code), stdoutText].filter(Boolean).join(' ') ||
    visible(panel) !== [visible(header), bodyText].join(' ')
  ) {
    return;
  }
  return { panel, code, output };
}

/** Each Python panel contributes one toggle and, while expanded, a copy control. */
export function isAnalyzedActivity(
  activity: HTMLElement,
  duration: HTMLElement,
  controls: HTMLElement[],
): boolean {
  if (controls.length < 2) {
    return false;
  }
  const sources = new Set<HTMLElement>();
  const outputs = new Set<Element>();
  const inOutput = (node: HTMLElement) => {
    const output = node.closest(outputSelector);
    return output !== null && outputs.has(output);
  };
  const regions = [duration];
  let previous = duration;
  for (let i = 1; i < controls.length; i++) {
    const read = readAnalysisPanel(controls[i], controls[i + 1]);
    if (!read || previous.compareDocumentPosition(read.panel) !== Node.DOCUMENT_POSITION_FOLLOWING) {
      return false;
    }
    previous = read.panel;
    regions.push(read.panel);
    if (read.code && read.output) {
      sources.add(read.code);
      outputs.add(read.output);
      i++;
    }
  }

  // The code and output of a tool can repeat the exact assistant envelope. Only
  // skip this branch when every panel and every visible character is accounted for.
  return (
    activity.querySelectorAll('pre').length === outputs.size &&
    htmlElements(activity, 'code').every((node) => sources.has(node) || inOutput(node)) &&
    htmlElements(activity, 'a').every(
      (node) =>
        inOutput(node) ||
        !!node
          .closest('[data-markdown-text-style="assistant-message"]')
          ?.closest('[class~="group/activity-header"]'),
    ) &&
    visible(activity) === regions.map(visible).join(' ')
  );
}
