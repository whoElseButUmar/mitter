import path from 'node:path';
import { z } from 'zod';
import { MAX_TEXT } from '../../../../../packages/protocol/src/index.js';
import { browserJourneysSchema } from './browser-contract.js';

const manifestPath = 'miter.quality.json';
const sourceLimit = 256;
const totalByteLimit = 4 * 1024 * 1024;
const nextHome = /^(?:src\/)?(?:app\/(?:\([\w.-]+\)\/)*page|pages\/index)\.[jt]sx?$/;

export const qualityPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !/[\\:%?#\u0000-\u001f\u007f]/.test(value) &&
      value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
    'Use a project-relative POSIX path without traversal, URLs or encoded separators.',
  )
  .describe('A literal project-relative file path; the caller still confines filesystem access.');

export const qualitySourceSchema = z
  .strictObject({
    path: qualityPathSchema,
    content: z
      .string()
      .max(MAX_TEXT)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_TEXT, 'Source exceeds 120 KB of UTF-8.')
      .describe('The complete source text, limited to the existing 120 KB file-read budget.'),
  })
  .describe('One complete source already collected through the host’s confined file reader.');

export type QualitySource = z.infer<typeof qualitySourceSchema>;

export const qualityTestPathSchema = qualityPathSchema
  .regex(/^(?!-)[\w./-]+\.test\.mjs$/)
  .describe(
    'One literal .test.mjs path using letters, digits, underscore, hyphen, dot and slash; no command arguments or globs.',
  );

export const webAppInspectionInputSchema = z
  .strictObject({
    files: z.array(qualitySourceSchema).max(sourceLimit).describe('At most 256 complete project sources.'),
    changedPaths: z.array(qualityPathSchema).max(sourceLimit).describe('Paths changed by the current task.'),
  })
  .refine(
    ({ files }) => new Set(files.map((file) => file.path)).size === files.length,
    'Each source path must occur exactly once.',
  )
  .refine(
    ({ files }) =>
      files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content, 'utf8'), 0) <= totalByteLimit,
    'Collected sources exceed 4 MiB of UTF-8.',
  )
  .describe('Bounded, complete inputs to source inspection; this is not a browser or test execution.');

function paths(extension: RegExp, label: string, maximum: number) {
  return z
    .array(qualityPathSchema.refine((value) => extension.test(value), label))
    .min(1)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, 'Do not repeat manifest paths.')
    .describe(label);
}

export const webAppQualityManifestSchema = z
  .strictObject({
    version: z.literal(1).describe('Version of the web-app quality manifest.'),
    entry: qualityPathSchema
      .refine(
        (value) => /\.html?$/i.test(value) || nextHome.test(value),
        'Use an HTML entry or Next.js home page.',
      )
      .describe('The project-relative HTML entry or Next.js home page used to follow shared sources.'),
    styles: paths(/\.css$/i, 'Existing shared CSS files linked or imported by the entry.', 32),
    components: paths(
      /\.(?:[cm]?js|jsx|tsx?)$/i,
      'Existing shared component modules reached from the entry.',
      32,
    ),
    tests: z
      .array(qualityTestPathSchema)
      .min(1)
      .max(16)
      .refine((values) => new Set(values).size === values.length, 'Do not repeat manifest paths.')
      .describe('Existing project-relative .test.mjs files, never commands or arguments.'),
    journeys: browserJourneysSchema,
  })
  .describe('miter.quality.json declares connected web-app sources and separately executable test files.');

export type WebAppQualityManifest = z.infer<typeof webAppQualityManifestSchema>;

export const webAppInspectionSchema = z
  .strictObject({
    applicable: z.boolean().describe('Changed browser UI sources and an HTML entry or manifest were found.'),
    issues: z
      .array(
        z
          .strictObject({
            path: qualityPathSchema,
            rule: z.string().min(1).max(80).describe('Stable name of the failed source-baseline rule.'),
            message: z
              .string()
              .min(1)
              .max(500)
              .describe('A concrete change needed to satisfy this baseline.'),
          })
          .describe('One source finding, not a claim about runtime behavior.'),
      )
      .max(20)
      .describe('At most 20 findings, deduplicated by source path and rule.'),
    tests: z
      .array(qualityTestPathSchema)
      .max(16)
      .describe('Validated, existing .test.mjs paths; no test was run here.'),
  })
  .describe(
    'Deterministic source checks only; passing does not prove accessibility, runtime behavior or product quality.',
  );

export type WebAppInspection = z.infer<typeof webAppInspectionSchema>;
type Issue = WebAppInspection['issues'][number];
type Literal = { value: string; start: number };
type SourceText = { code: string; masked: string; literals: Literal[] };
type CssRule = { selector: string; declarations: Map<string, string> };

/** Preserve positions while excluding comments and quoted prose from executable-code checks. */
function sourceText(source: string, script: boolean): SourceText {
  const code = source.split('');
  const masked = source.split('');
  const literals: Literal[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '"' || character === "'" || character === '`') {
      const start = index;
      const quote = character;
      index++;
      let value = '';
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) {
          value += source.slice(index, index + 2);
          index += 2;
        } else {
          value += source.slice(index, index + 1);
          index++;
        }
      }
      index = Math.min(source.length, index + 1);
      literals.push({ value: value.replace(/\\(['"`\\])/g, '$1'), start });
      for (let position = start; position < index; position++) {
        masked[position] = ' ';
      }
      continue;
    }
    const blockComment = source.startsWith('/*', index);
    const lineComment = script && source.startsWith('//', index);
    if (blockComment || lineComment) {
      let end = source.indexOf('\n', index + 2);
      if (blockComment) {
        end = source.indexOf('*/', index + 2);
        if (end >= 0) {
          end += 2;
        }
      }
      if (end < 0) {
        end = source.length;
      }
      while (index < end) {
        code[index] = ' ';
        masked[index] = ' ';
        index++;
      }
      continue;
    }
    index++;
  }
  return { code: code.join(''), masked: masked.join(''), literals };
}

function htmlText(source: string) {
  return source.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => ' '.repeat(comment.length));
}

function attribute(attributes: string, name: string) {
  const match = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(
    attributes,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

function htmlParts(content: string) {
  const scripts: { attributes: string; content: string }[] = [];
  const styles: string[] = [];
  const markup = htmlText(content).replace(
    /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi,
    (whole, tag: string, attributes: string, body: string) => {
      if (tag.toLowerCase() === 'script') {
        scripts.push({ attributes, content: body });
      } else {
        styles.push(body);
      }
      return ' '.repeat(whole.length);
    },
  );
  return { markup, scripts, styles };
}

function moduleReferences(source: SourceText) {
  const references: string[] = [];
  for (const literal of source.literals) {
    const prefix = source.masked.slice(Math.max(0, literal.start - 300), literal.start);
    if (/\bimport\s*(?:\(\s*)?$/.test(prefix) || /\b(?:import|export)\b[^;]*\bfrom\s*$/.test(prefix)) {
      if (/^\.{1,2}\/|^\//.test(literal.value)) {
        references.push(literal.value);
      }
    }
  }
  return references;
}

function sourceReferences(file: QualitySource) {
  const references: string[] = [];
  if (/\.html?$/i.test(file.path)) {
    const html = htmlParts(file.content);
    for (const tag of html.markup.matchAll(/<link\b([^>]*)>/gi)) {
      const attributes = tag[1] ?? '';
      if (attribute(attributes, 'rel').toLowerCase().split(/\s+/).includes('stylesheet')) {
        references.push(attribute(attributes, 'href'));
      }
    }
    for (const script of html.scripts) {
      references.push(attribute(script.attributes, 'src'));
      references.push(...moduleReferences(sourceText(script.content, true)));
    }
  } else if (/\.css$/i.test(file.path)) {
    const css = sourceText(file.content, false);
    for (const literal of css.literals) {
      if (/@import\s*(?:url\(\s*)?$/i.test(css.masked.slice(0, literal.start))) {
        references.push(literal.value);
      }
    }
    for (const match of css.masked.matchAll(/@import\s+url\(\s*([^\s)'";]+)\s*\)/gi)) {
      references.push(match[1] ?? '');
    }
  } else {
    references.push(...moduleReferences(sourceText(file.content, true)));
  }
  return references;
}

function linkedPath(from: string, reference: string, sources: Map<string, QualitySource>) {
  if (!reference || /^[a-z][a-z\d+.-]*:|^\/\//i.test(reference) || /[%\\]/.test(reference)) {
    return undefined;
  }
  const filename = reference.split(/[?#]/)[0] ?? '';
  let resolved = path.posix.join(path.posix.dirname(from), filename);
  if (filename.startsWith('/')) {
    resolved = filename.slice(1);
  }
  if (!qualityPathSchema.safeParse(resolved).success) {
    return undefined;
  }
  for (const candidate of [
    resolved,
    resolved + '.js',
    resolved + '.mjs',
    resolved + '.jsx',
    resolved + '.ts',
    resolved + '.tsx',
    resolved + '/index.js',
    resolved + '/index.jsx',
    resolved + '/index.ts',
    resolved + '/index.tsx',
  ]) {
    if (sources.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function reachableSources(entries: string[], sources: Map<string, QualitySource>) {
  const reached = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || reached.has(current)) {
      continue;
    }
    const file = sources.get(current);
    if (!file) {
      continue;
    }
    reached.add(current);
    for (const reference of sourceReferences(file)) {
      const linked = linkedPath(current, reference, sources);
      if (linked) {
        pending.push(linked);
      }
    }
  }
  return reached;
}

function cssRules(content: string): CssRule[] {
  const css = sourceText(content, false);
  const rules: CssRule[] = [];
  for (const match of css.masked.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorLength = match[1]?.length ?? 0;
    const selector =
      css.code
        .slice(match.index, match.index + selectorLength)
        .split(';')
        .at(-1)
        ?.trim() ?? '';
    if (!selector || selector.startsWith('@')) {
      continue;
    }
    const declarations = new Map<string, string>();
    for (const declaration of (match[2] ?? '').matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) {
      declarations.set((declaration[1] ?? '').toLowerCase(), (declaration[2] ?? '').trim().toLowerCase());
    }
    rules.push({ selector, declarations });
  }
  return rules;
}

function property(rule: CssRule, name: string, value: RegExp) {
  return value.test(rule.declarations.get(name) ?? '');
}

function selectorList(selector: string) {
  const selectors: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index];
    if (character === '\\') {
      index++;
    } else if (character === '(' || character === '[') {
      depth++;
    } else if (character === ')' || character === ']') {
      depth--;
    } else if (character === ',' && depth === 0) {
      selectors.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(selector.slice(start).trim());
  return selectors;
}

/** Recognize explicit root targets; a body/descendant theme does not style the viewport. */
function targetsDocumentRoot(selector: string) {
  const pending = selectorList(sourceText(selector, false).masked);
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    if (/^(?:html|:root|\*)$/i.test(current)) {
      return true;
    }
    const wrapper = /^:(?:where|is)\(/i.exec(current);
    if (!wrapper) {
      continue;
    }
    let depth = 1;
    let end = wrapper[0].length;
    while (end < current.length && depth > 0) {
      if (current[end] === '(') {
        depth++;
      } else if (current[end] === ')') {
        depth--;
      }
      end++;
    }
    if (depth === 0 && end === current.length) {
      pending.push(...selectorList(current.slice(wrapper[0].length, end - 1)));
    }
  }
  return false;
}

function scrollingBody(rule: CssRule) {
  return (
    (property(rule, 'overflow', /^(?:auto|scroll)$/) || property(rule, 'overflow-y', /^(?:auto|scroll)$/)) &&
    (property(rule, 'min-block-size', /^0(?:px)?$/) || property(rule, 'min-height', /^0(?:px)?$/))
  );
}

/** Recognize ordinary class composition on literal elements, without inventing a computed DOM. */
function composedScrollingBody(rules: CssRule[], markup: string[]) {
  const relevant = rules.filter((rule) =>
    ['overflow', 'overflow-y', 'min-height', 'min-block-size'].some((name) => rule.declarations.has(name)),
  );
  const observed = new Set<string>();
  for (const source of markup) {
    for (const element of source.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
      const tag = (element[1] ?? '').toLowerCase();
      const attributes = element[2] ?? '';
      const classes = new Set(
        (attribute(attributes, 'class') || attribute(attributes, 'className')).split(/\s+/),
      );
      const id = attribute(attributes, 'id');
      const key = [tag, id, ...[...classes].sort()].join(' ');
      if (observed.has(key)) {
        continue;
      }
      observed.add(key);
      if (observed.size > 512) {
        return false;
      }
      const declarations = new Map<string, string>();
      for (const rule of relevant) {
        const matches = rule.selector.split(',').some((selector) => {
          const target =
            selector
              .trim()
              .split(/[\s>+~]+/)
              .at(-1) ?? '';
          if (!/^(?:[a-z][\w-]*|\*)?(?:[.#][\w-]+)*$/i.test(target) || !target) {
            return false;
          }
          const targetTag = /^[a-z][\w-]*/i.exec(target)?.[0];
          if (targetTag && targetTag.toLowerCase() !== tag) {
            return false;
          }
          return [...target.matchAll(/([.#])([\w-]+)/g)].every((part) => {
            if (part[1] === '#') {
              return part[2] === id;
            }
            return classes.has(part[2] ?? '');
          });
        });
        if (matches) {
          for (const [name, value] of rule.declarations) {
            declarations.set(name, value);
          }
        }
      }
      if (scrollingBody({ selector: tag, declarations })) {
        return true;
      }
    }
  }
  return false;
}

function forcedColorsFallback(content: string) {
  const css = sourceText(content, false).masked;
  for (const media of css.matchAll(/@media[^{]*\(\s*forced-colors\s*:\s*active\s*\)[^{]*\{/gi)) {
    const start = media.index + media[0].length;
    let depth = 1;
    let end = start;
    while (end < css.length && depth > 0) {
      if (css[end] === '{') {
        depth++;
      } else if (css[end] === '}') {
        depth--;
      }
      end++;
    }
    if (
      depth === 0 &&
      cssRules(css.slice(start, end - 1)).some(
        (rule) => property(rule, 'scrollbar-color', /^auto$/) || property(rule, 'scrollbar-width', /^auto$/),
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasNativeDate(markup: string) {
  return /<input\b[^>]*\s+type\s*=\s*(?:\{\s*)?['"]?(?:date|time|datetime-local|month|week)(?=['"\s}>/])/i.test(
    markup,
  );
}

function hasNativeDatalist(markup: string, jsx = false) {
  const pattern = '<(?:datalist(?=[\\s/>])|input\\b[^>]*\\slist\\s*=)';
  let flags = 'i';
  if (jsx) {
    flags = '';
  }
  return new RegExp(pattern, flags).test(markup);
}

function inspectScript(content: string) {
  const source = sourceText(content, true);
  let nativeDate = hasNativeDate(htmlText(source.code));
  let nativeDatalist = hasNativeDatalist(htmlText(source.masked), true);
  let modal = /\.showModal\s*\(/.test(source.masked);
  for (const literal of source.literals) {
    nativeDate ||= hasNativeDate(htmlText(literal.value));
    nativeDatalist ||= hasNativeDatalist(htmlText(literal.value));
    modal ||= /<dialog\b|\brole\s*=\s*['"]dialog['"]/i.test(htmlText(literal.value));
  }
  for (const created of source.code.matchAll(
    /\b(?:const|let|var)\s+([\w$]+)\s*=\s*document\.createElement\(\s*['"]input['"]\s*\)/g,
  )) {
    if (!source.masked.slice(created.index, created.index + 5).trim()) {
      continue;
    }
    const identifier = (created[1] ?? '').replace(/\$/g, '\\$');
    const assignType = new RegExp(
      '\\b' +
        identifier +
        '\\s*(?:\\.type\\s*=\\s*|\\.setAttribute\\(\\s*[\'\"]type[\'\"]\\s*,\\s*)[\'\"](?:date|time|datetime-local|month|week)[\'\"]',
      'i',
    );
    nativeDate ||= assignType.test(source.code);
    const assignList = new RegExp(
      '\\b' + identifier + '\\s*\\.setAttribute\\(\\s*[\'\"]list[\'\"]\\s*,',
      'gi',
    );
    for (const assignment of source.code.matchAll(assignList)) {
      nativeDatalist ||= !!source.masked.slice(assignment.index, assignment.index + 1).trim();
    }
  }
  for (const created of source.code.matchAll(/\bdocument\.createElement\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (created[1]?.toLowerCase() === 'datalist') {
      nativeDatalist ||= !!source.masked.slice(created.index, created.index + 1).trim();
    }
  }
  const nativeDialog = /(?<![\w$.])(?:(?:window|globalThis)\s*\.\s*)?(?:alert|confirm|prompt)\s*\(/.test(
    source.masked,
  );
  return {
    nativeDate,
    nativeDatalist,
    nativeDialog,
    modal,
    markup: [htmlText(source.code), ...source.literals.map((literal) => htmlText(literal.value))],
  };
}

function applies(files: Map<string, QualitySource>, changedPaths: readonly string[]) {
  if (files.has(manifestPath)) {
    return changedPaths.some((filename) =>
      /\.(?:html?|css|[cm]?js|jsx|tsx?|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|mp3|ogg|wav|mp4|webm)$/i.test(
        filename,
      ),
    );
  }
  const hasEntry = [...files.keys()].some((filename) => /\.html?$/i.test(filename));
  if (!hasEntry) {
    return false;
  }
  return changedPaths.some((filename) => {
    if (/\.(?:html?|css|jsx|tsx)$/i.test(filename)) {
      return true;
    }
    const file = files.get(filename);
    if (!file || !/\.(?:[cm]?js|ts)$/i.test(filename)) {
      return false;
    }
    const script = sourceText(file.content, true);
    return (
      /\b(?:document|window|customElements)\s*\.|<\w+[\s>]/.test(script.masked) ||
      script.literals.some((literal) => /<[a-z][\w-]*(?:\s|>)/i.test(htmlText(literal.value)))
    );
  });
}

export function inspectWebApp(
  files: readonly QualitySource[],
  changedPaths: readonly string[],
  framework?: 'vite' | 'next',
): WebAppInspection {
  const input = webAppInspectionInputSchema.parse({ files, changedPaths });
  const sources = new Map(input.files.map((file) => [file.path, file]));
  if (!framework && !applies(sources, input.changedPaths)) {
    return webAppInspectionSchema.parse({ applicable: false, issues: [], tests: [] });
  }
  const findings = new Map<string, Issue>();
  function issue(filename: string, rule: string, message: string) {
    findings.set(filename + '\n' + rule, { path: filename, rule, message });
  }
  function result(tests: string[]) {
    const issues = [...findings.values()].sort((left, right) => {
      const first = left.path + '\n' + left.rule;
      const second = right.path + '\n' + right.rule;
      if (first < second) {
        return -1;
      }
      if (first > second) {
        return 1;
      }
      return 0;
    });
    if (issues.length > 20) {
      issues.length = 19;
      issues.push({
        path: manifestPath,
        rule: 'inspection.limit',
        message: 'More source findings remain. Fix these findings and run the baseline check again.',
      });
    }
    return webAppInspectionSchema.parse({ applicable: true, issues, tests });
  }
  const manifestFile = sources.get(manifestPath);
  if (!manifestFile) {
    issue(
      manifestPath,
      'manifest.missing',
      'Add miter.quality.json version 1 with entry, styles, components, .test.mjs tests and browser journeys. Read engineering-quality for the exact schema.',
    );
    return result([]);
  }
  let manifest: WebAppQualityManifest;
  try {
    manifest = webAppQualityManifestSchema.parse(JSON.parse(manifestFile.content));
  } catch {
    issue(
      manifestPath,
      'manifest.invalid',
      'Use version:1, an HTML entry or Next.js home page, nonempty styles/components/tests/journeys arrays and unique relative paths. Each journey needs name and steps with an action and expect assertion. Read engineering-quality for the exact schema.',
    );
    return result([]);
  }
  const entries = [manifest.entry];
  if (framework === 'next') {
    if (!nextHome.test(manifest.entry)) {
      issue(
        manifestPath,
        'manifest.entry',
        'Set entry to the Next.js source page rendered at the home route.',
      );
    } else {
      const pages = manifest.entry.includes('pages/');
      const directory = path.posix.dirname(manifest.entry);
      let appRoot = 'app';
      if (manifest.entry.startsWith('src/')) {
        appRoot = 'src/app';
      }
      for (const filename of sources.keys()) {
        const parent = path.posix.dirname(filename);
        if (
          (pages && parent === directory && /^_app\.[jt]sx?$/.test(path.posix.basename(filename))) ||
          (!pages &&
            (parent === appRoot || parent.startsWith(appRoot + '/')) &&
            (parent === directory || directory.startsWith(parent + '/')) &&
            /^(?:layout|template)\.[jt]sx?$/.test(path.posix.basename(filename)))
        ) {
          entries.push(filename);
        }
      }
    }
  } else if (!/\.html?$/i.test(manifest.entry) || (framework === 'vite' && manifest.entry !== 'index.html')) {
    issue(
      manifestPath,
      'manifest.entry',
      'Use the HTML entry served by the app. The Vite home route uses index.html.',
    );
  }
  const reached = reachableSources(entries, sources);
  for (const filename of [manifest.entry, ...manifest.styles, ...manifest.components, ...manifest.tests]) {
    if (!sources.has(filename)) {
      issue(
        filename,
        'asset.missing',
        'Create this declared file or correct its manifest path; the complete source must be available to inspection.',
      );
    } else if (!manifest.tests.includes(filename) && !reached.has(filename)) {
      issue(
        filename,
        'asset.unlinked',
        'Link or import this declared shared source from the entry using a literal local path. An unused file does not satisfy the baseline.',
      );
    }
  }
  const sharedStyleSources = manifest.styles
    .filter((filename) => reached.has(filename))
    .map((filename) => ({ path: filename, content: sources.get(filename)?.content ?? '' }));
  const sharedStyles = sharedStyleSources.map((source) => source.content).join('\n');
  const rules = sharedStyleSources.flatMap((source) =>
    cssRules(source.content).map((rule) => ({ ...rule, path: source.path })),
  );
  const stylePath = manifest.styles[0] ?? manifestPath;
  const visibleRing = (rule: CssRule) =>
    property(rule, 'outline', /^(?!none\b|0(?:px)?(?:\s|$)).+/) ||
    property(rule, 'box-shadow', /^(?!none\b).+/);
  if (!rules.some((rule) => /:focus-visible\b/.test(rule.selector) && visibleRing(rule))) {
    issue(
      stylePath,
      'focus.visible',
      'Add a visible :focus-visible ring to the connected shared control styles; CSS must retain browser focus behavior.',
    );
  }
  const blanketFocusRule = rules.find(
    (rule) =>
      selectorList(rule.selector).some(
        (selector) => /:focus(?:-within)?(?![-\w])/.test(selector) && !/:focus-visible/.test(selector),
      ) && visibleRing(rule),
  );
  if (blanketFocusRule) {
    issue(
      blanketFocusRule.path,
      'focus.blanket',
      'Move blanket :focus/:focus-within rings to :focus-visible; wrapper rings must follow a child with :has(:focus-visible). Keep the child ring unless a visible wrapper ring replaces it.',
    );
  }
  for (const [name, value] of [
    ['scrollbar-width', /^thin$/],
    ['scrollbar-color', /\S+\s+\S+/],
    ['scrollbar-gutter', /\bstable\b/],
  ]) {
    if (typeof name !== 'string' || !(value instanceof RegExp)) {
      throw new Error('Invalid built-in scrollbar rule.');
    }
    if (!rules.some((rule) => property(rule, name, value))) {
      issue(
        stylePath,
        'scrollbar.' + name,
        'Define ' + name + ' in connected shared scroll-area styles, preserving native overflow scrolling.',
      );
    }
  }
  const documentRules = rules.filter((rule) => targetsDocumentRoot(rule.selector));
  if (
    !documentRules.some((rule) => property(rule, 'scrollbar-width', /^thin$/)) ||
    !documentRules.some((rule) => property(rule, 'scrollbar-color', /\S+\s+\S+/))
  ) {
    issue(
      stylePath,
      'scrollbar.document',
      'Set scrollbar-width:thin and scrollbar-color on html, :root or a universal selector in connected shared CSS. Styling only body or named scroll areas leaves the document scrollbar unthemed.',
    );
  }
  if (!forcedColorsFallback(sharedStyles)) {
    issue(
      stylePath,
      'scrollbar.forced-colors',
      'Add an explicit forced-colors:active fallback that restores native scrollbar color or width to auto.',
    );
  }
  let modal = false;
  const markupSources: string[] = [];
  for (const filename of reached) {
    const file = sources.get(filename);
    if (!file || /\.css$/i.test(filename)) {
      continue;
    }
    let markup = '';
    let scripts = [file.content];
    if (/\.html?$/i.test(filename)) {
      const html = htmlParts(file.content);
      markup = html.markup;
      markupSources.push(markup);
      scripts = html.scripts.map((script) => script.content);
      modal ||= /<dialog\b|\brole\s*=\s*['"]dialog['"]/i.test(markup);
    }
    let nativeDate = hasNativeDate(markup);
    let nativeDatalist = hasNativeDatalist(markup);
    for (const script of scripts) {
      const checks = inspectScript(script);
      markupSources.push(...checks.markup);
      nativeDate ||= checks.nativeDate;
      nativeDatalist ||= checks.nativeDatalist;
      modal ||= checks.modal;
      if (checks.nativeDialog) {
        issue(
          filename,
          'dialog.native',
          'Replace native alert/confirm/prompt calls with shared accessible in-app feedback or dialog components.',
        );
      }
    }
    if (nativeDate) {
      issue(
        filename,
        'control.native-date',
        'Replace native date/time/datetime-local/month/week inputs with the shared styled date or time component, preserving manual entry and validation.',
      );
    }
    if (nativeDatalist) {
      issue(
        filename,
        'control.native-datalist',
        'Replace native datalist/input[list] suggestions with a styled accessible combobox, or use a plain text input when suggestions are optional. Styling the input does not style the browser popup.',
      );
    }
  }
  if (modal) {
    if (
      !rules.some(
        (rule) =>
          property(rule, 'overflow', /^(?:hidden|clip)$/) &&
          (rule.declarations.has('max-block-size') || rule.declarations.has('max-height')),
      )
    ) {
      issue(
        stylePath,
        'modal.shell',
        'Constrain the shared modal shell to the viewport and clip its overflow; put scrolling on an inner body.',
      );
    }
    if (!rules.some(scrollingBody) && !composedScrollingBody(rules, markupSources)) {
      issue(
        stylePath,
        'modal.body',
        'Give the shared modal body native overflow:auto/scroll and min-block-size:0 (or min-height:0) so it can shrink inside the clipped shell.',
      );
    }
  }
  return result(manifest.tests.filter((filename) => sources.has(filename)));
}
