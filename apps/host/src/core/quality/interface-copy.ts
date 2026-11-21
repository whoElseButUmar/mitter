import type { Page } from 'puppeteer-core';
import { z } from 'zod';
import { redundantSubtitles } from './redundant-subtitles.js';
import { repeatedRecordLabels } from './repeated-record-labels.js';
import { routineStorageNotices } from './storage-notices.js';
import { utilityPageCopy } from './utility-page-copy.js';

const copyKind = z
  .enum(['eyebrow', 'subtitle', 'tagline', 'header', 'footer', 'storage', 'empty', 'repeated'])
  .describe('The purpose of the interface copy.');
type CopyKind = z.infer<typeof copyKind>;
const copyCandidates = z
  .array(
    z
      .strictObject({
        kind: copyKind,
        text: z.string().max(220).describe('The visible text of the matching UI element.'),
        tag: z.string().max(30).describe('The HTML element containing the copy.'),
      })
      .describe('A rendered piece of interface copy that matched a promotional phrase.'),
  )
  .max(20)
  .describe('Bounded promotional matches from the current page state.');

// Only trusted user instructions reach this check. File contents, model replies and the
// quality manifest cannot grant exceptions. Read instructions in order so a follow-up can revoke one.
export function requestedInterfaceCopy(
  instructions: readonly string[],
  kind: CopyKind,
  text: string,
): boolean {
  const kinds: Record<CopyKind, string> = {
    eyebrow: 'eyebrows?|overlines?|kickers?',
    subtitle:
      'subtitles?|subheadings?|subheads?|(?:page|section|screen) (?:descriptions?|introductions?|summar(?:y|ies))|descriptions? (?:under|below|beneath) (?:each |the )?(?:titles?|headings?)',
    tagline: 'taglines?|slogans?',
    header: '(?:brand|header|topbar) (?:notes?|descriptions?|subtitles?|captions?|labels?)',
    footer: 'footer (?:labels?|text|copy|captions?)',
    empty: 'empty[- ]state (?:descriptions?|subtitles?|explanations?|second(?:ary)? lines?|copy)',
    repeated: '(?:repeated|duplicate) (?:record |status |state )?labels?',
    storage:
      '(?:local[- ]storage|storage|privacy|local[- ]only) (?:notices?|disclosures?|messages?|labels?|indicators?)',
  };
  let category = '(?:' + kinds[kind] + ')';
  if (kind !== 'storage' && kind !== 'empty' && kind !== 'repeated') {
    category = '(?:' + kinds[kind] + '|(?:promotional|marketing|brand) (?:copy|messaging))';
  }
  const wording = /(?:“([^”]+)”|‘([^’]+)’|"([^"]+)"|`([^`]+)`|(?<!\w)'([^'\n]+)')/g;
  const clause = /(?:“[^”]*”|‘[^’]*’|"[^"]*"|`[^`]*`|(?<!\w)'[^'\n]+'|[^.!?;\n])+/g;
  const negative =
    /\b(?:no|not|never|without|avoid|omit|remove|cut|skip|delete|drop|strip|exclude|don't|don’t|unless|only (?:if|when)|(?:if|when) (?:explicitly )?(?:asked|requested))\b/i;
  const verb =
    "(?:add|include|write|use|show|display|put|keep|retain|preserve|want|with|give (?:it|the app)|I(?:['’]d| would) like)";
  const modifier =
    '(?:(?:a|an|the|our|one|some|short|brief|one-line|descriptive|catchy|custom|hero|brand|page|footer|header|category|promotional)\\s+){0,5}';
  const asksForCategory = new RegExp('\\b' + verb + '\\s+' + modifier + category + '\\b', 'i');
  const firstCategory = new RegExp(
    '\\b' + verb + '\\s+' + modifier + '(?:' + Object.values(kinds).join('|') + ')\\s*$',
    'i',
  );
  const listedCategory = new RegExp('^' + modifier + category + '$', 'i');
  const namesCategory = new RegExp('\\b' + category + '\\b', 'i');
  const suppliedLine = new RegExp('^\\s*' + category + '\\s*:\\s*([^\\n]+)', 'i');
  const asksForWording =
    /\b(?:add|include|write|use|show|display|put|keep|retain|preserve|say|says|read|reads|title|label|repeat|duplicate)\b/i;
  const normalized = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  let allowed = false;

  for (const instruction of instructions) {
    const supplied = suppliedLine.exec(instruction)?.[1];
    if (supplied) {
      allowed = normalized(supplied) === normalized(text);
    }
    for (const part of instruction.match(clause) ?? []) {
      const quotes = Array.from(part.matchAll(wording), (match) => normalized(match[0]));
      const direction = part.replace(wording, ' ');
      const exact = quotes.includes(normalized(text));
      if (
        kind === 'repeated' &&
        !/\b(?:twice|repeat(?:ed)?|duplicates?|both (?:copies|labels)|two copies)\b/i.test(direction)
      ) {
        continue;
      }
      if (negative.test(direction)) {
        if (
          exact ||
          (namesCategory.test(direction) &&
            (quotes.length === 0 || /\b(?:like|such as|e\.g\.)\b/i.test(direction)))
        ) {
          allowed = false;
        }
      } else if (quotes.length > 0) {
        if (exact && (asksForWording.test(direction) || asksForCategory.test(direction))) {
          allowed = true;
        }
      } else if (
        kind === 'storage' &&
        /\b(?:mention|explain|disclose|indicate|state|show that|tell (?:the )?(?:user|users)|make (?:it )?clear)\s+(?:that |where )?(?:the |their |your |all )?(?:data|records|entries)\b[^,]{0,55}\b(?:stored|saved|kept|local|locally|browser|device)\b/i.test(
          direction,
        )
      ) {
        allowed = true;
      } else {
        const request = asksForCategory.exec(direction);
        if (request) {
          const rest = direction.slice(request.index + request[0].length);
          const supplied = /^\s*(?::|=|that (?:says|reads)|(?:saying|reading|called))\s*(.+)$/i.exec(rest);
          if (supplied?.[1]) {
            allowed = normalized(supplied[1]) === normalized(text);
          } else {
            allowed = true;
          }
        } else {
          const [first, ...list] = direction.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i);
          if (first && firstCategory.test(first) && list.some((item) => listedCategory.test(item.trim()))) {
            allowed = true;
          }
        }
      }
    }
  }
  return allowed;
}

/** Inspect rendered copy so templates, components and content inserted by JavaScript follow the same rule. */
export async function inspectInterfaceCopy(
  page: Page,
  instructions: readonly string[] = [],
  initial = false,
): Promise<string[]> {
  const raw: unknown = await page.evaluate(() => {
    const found: { kind: CopyKind; text: string; tag: string }[] = [];
    const seen = new Set<string>();
    const excluded =
      'button,a,input,select,textarea,label,output,pre,code,blockquote,li,td,th,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="listitem"],[role="row"],[role="status"],[role="alert"],[role="log"],[aria-live]';
    const patterns = [
      [
        'eyebrow',
        /^your next (?:great |big )?(?:getaway|adventure|escape|chapter)(?: (?:starts|begins) (?:right )?here)?$/,
      ],
      ['subtitle', /^(?:everything|all) you need (?:all )?(?:ready to go|in one place|at your fingertips)$/],
      [
        'tagline',
        /^(?:a little )?less (?:to (?:think|worry) about|hassle|stress|effort|planning) (?:a (?:lot|little) )?more (?:to (?:enjoy|explore|love)|time (?:for [\p{L} ]+|to [\p{L} ]+)|adventure|joy)$/u,
      ],
      ['tagline', /^(?:plan|worry|stress|pack) less (?:enjoy|travel|explore|live|do) more$/],
      [
        'tagline',
        /^(?:made|built|designed) (?:for|around) (?:you|your (?:everyday|busy life|next adventure))$/,
      ],
      [
        'subtitle',
        /^(?:a|the) (?:smarter|better|simpler|easier) way to (?:manage|organize|plan|work|create|build|do) (?:your|every|more|less|together)\b/u,
      ],
    ] as const;
    const eyebrow = '.eyebrow,.overline,.kicker,[data-eyebrow],[data-overline],[data-kicker]';
    const title = 'h1,[role="heading"][aria-level="1"]';
    const visible = (element: Element) =>
      element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const labelsControl = (element: Element) =>
      element.id &&
      document.querySelector(
        '[aria-labelledby~="' +
          CSS.escape(element.id) +
          '"],[aria-describedby~="' +
          CSS.escape(element.id) +
          '"]',
      );
    const pageTitles: string[][] = [];
    const pageCategories = new Set<string>();
    let primaryTitle: Element | undefined;
    const contextWords = new Set<string>();
    for (const label of document.querySelectorAll(
      title + ',header,header a[href],header > span,[role="banner"],' + eyebrow,
    )) {
      if (!(label instanceof HTMLElement) || !visible(label) || label.closest('dialog,article,footer')) {
        continue;
      }
      const words = wordsOf(label.innerText);
      if (label.matches(title) && words.length) {
        pageTitles.push(words);
        primaryTitle ??= label;
      }
      for (const word of words) {
        contextWords.add(word);
      }
    }
    const contextLabel =
      'nav,address,time,data,[role],[aria-current],[aria-label],[aria-labelledby],[itemprop],[data-tenant],[data-location],[data-organization]';
    function pageOverline(element: Element): boolean {
      const heading = element.nextElementSibling;
      if (
        !heading?.matches(title) ||
        element.matches(contextLabel) ||
        element.closest('nav,[role="navigation"],address,[aria-current]') ||
        labelsControl(element)
      ) {
        return false;
      }
      const section = heading.closest('section,article,aside,dialog');
      return (
        !section ||
        heading === primaryTitle ||
        (Boolean(heading.id) &&
          section.getAttribute('aria-labelledby')?.split(/\s+/).includes(heading.id) === true)
      );
    }
    for (const label of document.querySelectorAll(eyebrow)) {
      if (label instanceof HTMLElement && visible(label) && pageOverline(label)) {
        for (const word of wordsOf(label.innerText)) {
          pageCategories.add(word);
        }
      }
    }
    for (const heading of document.querySelectorAll('main :is(h1,h2,h3,[role="heading"])')) {
      if (visible(heading)) {
        for (const word of wordsOf([heading.textContent, heading.id].join(' '))) {
          pageCategories.add(word);
        }
      }
    }
    for (const element of document.querySelectorAll(
      'p,span,small,div,header,footer,aside,strong,em,h1,h2,h3,h4,h5,h6',
    )) {
      if (!(element instanceof HTMLElement) || element.closest(excluded) || element.children.length > 6) {
        continue;
      }
      // Read individual copy blocks, not a container's concatenated title, controls and records.
      const footer = element.matches('footer,[role="contentinfo"]');
      const inline = 'span,strong,b,i,em,small,br';
      if (
        Array.from(element.children).some(
          (child) => !child.matches(inline) && !(footer && child.matches('p')),
        )
      ) {
        continue;
      }
      const candidate = element.textContent ?? '';
      if (!candidate.trim() || candidate.length > 260) {
        continue;
      }
      const text = element.innerText.replace(/\s+/g, ' ').trim();
      const words = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
      const match = patterns.find(([, pattern]) => pattern.test(words));
      let kind: CopyKind | undefined = match?.[0];
      // A component named as a slogan explicitly identifies the purpose of its copy.
      // A subtitle or an uppercase heading can just as easily be useful navigation.
      if (
        element.matches(
          '.tagline,.slogan,[data-tagline],[data-slogan],[class$="-tagline"],[class$="-slogan"]',
        )
      ) {
        kind = 'tagline';
      }
      if (
        !kind &&
        element.matches(eyebrow) &&
        pageOverline(element) &&
        /^\p{L}+(?:[ -]\p{L}+){0,3}$/u.test(words)
      ) {
        kind = 'eyebrow';
      }
      if (
        !kind &&
        element.parentElement?.matches('header,[role="banner"]') &&
        /(?:^|[\s_-])(?:note|subtitle|description|caption|descriptor)(?:$|[\s_-])/.test(element.className) &&
        element.parentElement.querySelector(':scope > :is(.brand,.wordmark,[data-brand],a[href="/"])') &&
        !element.matches(contextLabel) &&
        !element.querySelector(contextLabel) &&
        !labelsControl(element) &&
        /^[\p{L}][\p{L}’' -]*$/u.test(text)
      ) {
        const terms = wordsOf(text);
        if (terms.length > 1 && terms.length <= 8 && pageCategories.has(terms.at(-1) ?? '')) {
          kind = 'header';
        }
      }
      if (
        !kind &&
        footer &&
        !element.matches('.credit,.credits,.copyright,[data-credit]') &&
        !element.closest('dialog,article,section,aside,form') &&
        !element.querySelector(
          excluded + ',address,time,nav,img,svg,[aria-label],.credit,.credits,.copyright,[data-credit]',
        ) &&
        !element.hasAttribute('aria-label') &&
        !labelsControl(element) &&
        /^[\p{L}][\p{L}’' -]*[\p{L}]$/u.test(text)
      ) {
        const terms = wordsOf(text);
        if (
          terms.length <= 8 &&
          terms.every((term) => contextWords.has(term)) &&
          (pageTitles.some((parts) => parts.every((part) => terms.includes(part))) ||
            words === wordsOf(document.title).join(' '))
        ) {
          kind = 'footer';
        }
      }
      if (
        !kind ||
        !text ||
        text.length > 220 ||
        !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      ) {
        continue;
      }
      if (
        kind !== 'footer' &&
        element.closest('.tagline,.slogan,[data-tagline],[data-slogan],footer,[role="contentinfo"]')
      ) {
        kind = 'tagline';
      } else if (element.closest('.eyebrow,.overline,.kicker')) {
        kind = 'eyebrow';
      } else if (element.closest('.subtitle,.subheading,.subhead,.intro')) {
        kind = 'subtitle';
      }
      const key = kind + ' ' + text;
      if (seen.has(key)) {
        continue;
      }
      found.push({ kind, text, tag: element.localName });
      seen.add(key);
      if (found.length === 20) {
        break;
      }
    }
    return found;
  });
  const candidates = copyCandidates.parse(raw);
  for (const candidate of copyCandidates.parse(await page.evaluate(utilityPageCopy))) {
    if (!candidates.some(({ text }) => text === candidate.text)) {
      candidates.push(candidate);
    }
  }
  const findings = candidates
    .filter(({ kind, text }) => !requestedInterfaceCopy(instructions, kind, text))
    .map(({ kind, text, tag }) => {
      if (kind === 'empty') {
        return `Remove the repeated empty-state line “${text}”. Keep the primary label and any new reason, constraint or next action.`;
      }
      if (kind === 'footer') {
        return `Remove the explanatory footer “${text}”. Keep functional links, notices and credits.`;
      }
      if (kind === 'header') {
        return `Remove the descriptive header note “${text}”. Keep the brand, navigation and functional context.`;
      }
      if (kind === 'subtitle') {
        return `Remove the unrequested subtitle “${text}”. Give the page heading, controls and records that space.`;
      }
      return `Remove the unrequested promotional ${kind} “${text}” from <${tag}>. Omit it instead of replacing it with another slogan.`;
    });
  const descriptions = z
    .array(z.string().max(180))
    .max(20)
    .parse(await page.evaluate(redundantSubtitles));
  const promotional = new Set(candidates.map(({ text }) => text));
  for (const text of descriptions) {
    if (!promotional.has(text) && !requestedInterfaceCopy(instructions, 'subtitle', text)) {
      findings.push(
        `Remove the redundant subtitle “${text}”. Its heading, controls or empty state already communicate this. Keep those in place.`,
      );
    }
  }
  const notices = z
    .array(z.string().max(140))
    .max(20)
    .parse(await page.evaluate(routineStorageNotices, initial));
  for (const text of notices) {
    if (!requestedInterfaceCopy(instructions, 'storage', text)) {
      findings.push(
        `Remove the default storage label “${text}”. Keep persistence, actionable warnings and save feedback after changes.`,
      );
    }
  }
  const labels = z
    .array(z.string().max(64))
    .max(20)
    .parse(await page.evaluate(repeatedRecordLabels));
  for (const text of labels) {
    if (!requestedInterfaceCopy(instructions, 'repeated', text)) {
      findings.push(
        `Remove the repeated “${text}” label. Show the status once per record and preserve its actions.`,
      );
    }
  }
  return findings;
}
