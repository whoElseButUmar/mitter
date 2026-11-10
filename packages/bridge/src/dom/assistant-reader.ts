import { utf8Bytes, MAX_HANDOFF_BYTES } from '../../../protocol/src/reply-json.js';
import { contentHidden, htmlElements } from './page-elements.js';
import { headingRole } from './transcript-discovery.js';
import { ASSISTANT_READER_VERSION, type AssistantReadResult, type AssistantReadStats } from './types.js';

/** Read one logical fenced payload, not one HTML PRE element.
 * A code component may use an outer PRE for its toolbar and an inner PRE for
 * its highlighter. Ancestor/descendant wrappers are not separate proposals.
 * Distinct sibling payloads remain ambiguous, even when their text is equal.
 * Nothing here repairs JSON or reconstructs source from rendered Markdown.
 */
export function readAssistantMessage(body: HTMLElement): AssistantReadResult {
  const preElements: HTMLElement[] = [];
  if (body.tagName === 'PRE') {
    preElements.push(body);
  }
  preElements.push(...htmlElements(body, 'pre'));
  const hiddenCache = new Map<Element, boolean>();
  const isHidden = (element: Element): boolean => {
    const cached = hiddenCache.get(element);
    if (cached !== undefined) {
      return cached;
    }
    let isAbsent = false;
    // Do not use viewport intersection: offscreen/horizontally scrolled code
    // is still content. aria-hidden alone is not visual hiding either.
    const elementStyle = getComputedStyle(element);
    if (elementStyle.visibility === 'hidden' || elementStyle.visibility === 'collapse') {
      isAbsent = true;
    }
    for (let node: Element | null = element; node && !isAbsent; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.contentVisibility === 'hidden') {
        isAbsent = true;
      }
    }
    hiddenCache.set(element, isAbsent);
    return isAbsent;
  };
  const visiblePreElements = preElements.filter((node) => !isHidden(node));
  // Only leaf PREs can be payloads. Keep each sibling leaf separate, including
  // siblings under the same outer PRE; never select the first/last arbitrarily.
  const leafPreElements = visiblePreElements.filter(
    (node) => !visiblePreElements.some((other) => other !== node && node.contains(other)),
  );
  const candidates: Array<{ source: HTMLElement; text: string }> = [];
  let emptyBlocks = 0;
  for (const preElement of leafPreElements) {
    const codeElements = htmlElements(preElement, 'code');
    const visibleCodeElements = codeElements.filter((node) => !isHidden(node));
    if (codeElements.length && !visibleCodeElements.length) {
      emptyBlocks++;
      continue;
    }
    const outerCodeElements = visibleCodeElements.filter(
      (node) => !visibleCodeElements.some((other) => other !== node && other.contains(node)),
    );
    let payloadSources = outerCodeElements;
    if (!outerCodeElements.length) {
      payloadSources = [preElement];
    }
    for (const payloadElement of payloadSources) {
      // textContent preserves backticks, escapes and whitespace; innerText
      // measures layout and must never supply code that will be written to disk.
      const text = payloadElement.textContent || '';
      if (text.trim()) {
        candidates.push({ source: payloadElement, text });
      } else {
        emptyBlocks++;
      }
    }
  }
  // Some fenced highlighters use a block CODE inside a DIV, without PRE.
  // Inline Markdown CODE is still rejected. This changes only container
  // discovery: payload bytes always come from textContent, never reconstructed
  // from visible prose, an editor model, the clipboard or private app state.
  if (!preElements.length) {
    const visibleCodeElements = htmlElements(body, 'code').filter((node) => !isHidden(node));
    for (const payloadElement of visibleCodeElements.filter(
      (node) => !visibleCodeElements.some((other) => other !== node && other.contains(node)),
    )) {
      const style = getComputedStyle(payloadElement);
      const isBlockCode =
        payloadElement.matches('[class*="language-"]') ||
        !!payloadElement.closest('[data-testid="code-block"],.code-block') ||
        (['block', 'flex', 'grid'].includes(style.display) && /^pre/.test(style.whiteSpace));
      if (!isBlockCode) {
        continue;
      }
      const text = payloadElement.textContent || '';
      if (text.trim()) {
        candidates.push({ source: payloadElement, text });
      } else {
        emptyBlocks++;
      }
    }
  }
  const stats: AssistantReadStats = {
    extractor: ASSISTANT_READER_VERSION,
    preElements: preElements.length,
    visiblePreElements: visiblePreElements.length,
    nestedWrappers: visiblePreElements.length - leafPreElements.length,
    ignoredHiddenBlocks: preElements.length - visiblePreElements.length,
    emptyBlocks,
    logicalBlocks: candidates.length,
    payloadCharacters: candidates.slice(0, 8).map((candidate) => candidate.text.length),
  };
  const rejected = (issue: string): AssistantReadResult => ({
    text: body.innerText || body.textContent || '',
    format: 'rendered',
    issue,
    stats,
  });
  if (candidates.length > 1) {
    return rejected('MULTIPLE_BLOCKS');
  }
  const candidate = candidates[0];
  if (candidates.length === 1 && candidate) {
    const { source, text } = candidate;
    // Inspect residual text in the ORIGINAL tree so ancestor CSS visibility is
    // meaningful. Removing an entire outer PRE would hide surrounding prose.
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let residualText = '';
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parentElement = node.parentElement;
      if (source.contains(node) || !parentElement || isHidden(parentElement)) {
        continue;
      }
      if (parentElement.closest('button,[role="button"],svg,script,style,template,[aria-hidden="true"]')) {
        continue;
      }
      const label = parentElement.closest('h1,h2,h3,h4,h5,h6,[role="heading"]');
      if (
        label instanceof HTMLElement &&
        headingRole(label) &&
        !label.closest('pre,code,.markdown,[data-message-content]')
      ) {
        continue;
      }
      residualText += node.nodeValue || '';
    }
    residualText = residualText.trim();
    // Permit the code-language label, not arbitrary prose or another proposal.
    if (residualText && !/^(json|application\/json)$/i.test(residualText)) {
      return { ...rejected('EXTRA_CONTENT'), source };
    }
    return { text, format: 'code', stats, source };
  }
  if (preElements.length) {
    if (visiblePreElements.length) {
      return rejected('EMPTY_CODE_BLOCK');
    }
    return rejected('CODE_NOT_VISIBLE');
  }
  const text = body.innerText || body.textContent || '';
  if (body.querySelector('code,em,strong,del,s,a,table,ul,ol,blockquote')) {
    return { text, format: 'rendered', issue: 'MARKDOWN_TRANSFORMED', stats };
  }
  const plain = readPlainReplyText(body);
  let format: AssistantReadResult['format'] = 'plain';
  if (plain.issue) {
    format = 'rendered';
  }
  return {
    text: plain.text,
    format,
    issue: plain.issue,
    stats,
    source: body,
  };
}

/** Plain JSON is read from text nodes, not innerText (which collapses string
 * whitespace). Only layout separators OUTSIDE strings may be reconstructed.
 * A paragraph/BR inside a quoted value is ambiguous and requires fenced code.
 * This reader does not turn Markdown markup back into source characters.
 */
function readPlainReplyText(body: HTMLElement): {
  text: string;
  issue?: string;
} {
  let text = '';
  let insideString = false;
  let escapedCharacter = false;
  let issue: string | undefined;
  const appendText = (value: string) => {
    if (utf8Bytes(text) + utf8Bytes(value) > MAX_HANDOFF_BYTES) {
      issue = 'PAYLOAD_TOO_LARGE';
      return;
    }
    text += value;
    for (const character of value) {
      if (insideString) {
        if (escapedCharacter) {
          escapedCharacter = false;
        } else if (character === '\\') {
          escapedCharacter = true;
        } else if (character === '"') {
          insideString = false;
        }
      } else if (character === '"') {
        insideString = true;
      }
    }
  };
  const appendSeparator = () => {
    if (!text || text.endsWith('\n')) {
      return;
    }
    if (insideString) {
      issue = 'PLAIN_STRING_LAYOUT';
      return;
    }
    appendText('\n');
  };
  const visit = (node: Node) => {
    if (issue) {
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.nodeValue || '');
      return;
    }
    if (!(node instanceof HTMLElement)) {
      return;
    }
    if (
      node.matches(
        'button,[role="button"],svg,script,style,template,[data-mitter-ui],#mitter-automation-control',
      )
    ) {
      return;
    }
    if (contentHidden(node)) {
      if (node.textContent?.trim()) {
        issue = 'PLAIN_HIDDEN_CONTENT';
      }
      return;
    }
    const isBlock = node !== body && node.matches('p,div,section,article,br');
    if (isBlock) {
      appendSeparator();
    }
    for (const child of Array.from(node.childNodes)) {
      visit(child);
    }
    if (isBlock) {
      appendSeparator();
    }
  };
  visit(body);
  if (issue !== undefined) {
    return { text, issue };
  }
  return { text };
}
