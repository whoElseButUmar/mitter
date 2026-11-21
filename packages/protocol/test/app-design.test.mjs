import assert from 'node:assert/strict';
import { test } from 'node:test';
import { format } from 'prettier';
import { APP_DESIGN_GUIDANCE, APP_FOUNDATION_CSS } from '../src/task-skills/app-design.ts';

test('app foundation is bounded, valid CSS without network assets or a framework runtime', async () => {
  const formatted = await format(APP_FOUNDATION_CSS, { parser: 'css' });

  assert.ok(formatted.length > 0);
  assert.ok(APP_FOUNDATION_CSS.length <= 8000, 'The controls, modal and scrollbar reference stays bounded.');
  assert.doesNotMatch(APP_FOUNDATION_CSS, /@import|url\(|<script|@tailwind|@apply/i);
  assert.doesNotMatch(APP_FOUNDATION_CSS, /(?:^|[\s,{}])(?:body|html)\s*\{/);
});

test('global foundation rules style scrollbars without changing document layout or overflow', () => {
  let documentRules = 0;

  for (const [, selector, declarations] of APP_FOUNDATION_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.includes(':root') || selector.includes('::-webkit-scrollbar')) {
      continue;
    }

    documentRules++;

    for (const declaration of declarations.split(';')) {
      const property = declaration.split(':')[0].trim();

      if (property) {
        assert.match(property, /^(?:scrollbar-(?:width|color|gutter)|--ui-scroll-(?:thumb|track))$/);
      }
    }
  }

  assert.ok(documentRules > 0, 'Document scrollbars need their own styles.');
  assert.match(APP_FOUNDATION_CSS, /:root\s*\{\s*scrollbar-gutter:stable;/);
});

test('every foundation color and shape token has a local default', () => {
  const themeBlock = APP_FOUNDATION_CSS.match(/^\.ui\s*\{([^}]+)\}/);
  assert.ok(themeBlock);
  const definitions = new Set();

  for (const match of themeBlock[1].matchAll(/(--ui-[\w-]+)\s*:/g)) {
    definitions.add(match[1]);
  }

  const references = [...APP_FOUNDATION_CSS.matchAll(/var\((--ui-[\w-]+)\)/g)];
  assert.ok(references.length > 0);

  for (const match of references) {
    assert.ok(definitions.has(match[1]), 'Missing theme default: ' + match[1]);
  }

  assert.doesNotMatch(APP_FOUNDATION_CSS, /outline\s*:\s*(?:none|0)\b/);
  assert.doesNotMatch(APP_FOUNDATION_CSS, /scrollbar-width\s*:\s*none\b/);
  assert.doesNotMatch(APP_FOUNDATION_CSS, /forced-color-adjust\s*:\s*none\b/);
});

function tokenContrast(first, second) {
  const colors = new Map();

  for (const match of APP_FOUNDATION_CSS.matchAll(/(--ui-[\w-]+)\s*:\s*(#[0-9a-f]{3,6})\s*;/gi)) {
    colors.set(match[1], match[2]);
  }

  function luminance(hex) {
    let digits = hex.slice(1);

    if (digits.length === 3) {
      digits = [...digits].map((digit) => digit + digit).join('');
    }

    const channels = digits.match(/../g).map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;

      if (value <= 0.04045) {
        return value / 12.92;
      }

      return ((value + 0.055) / 1.055) ** 2.4;
    });

    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }

  const a = luminance(colors.get(first));
  const b = luminance(colors.get(second));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('scrollbar defaults remain visible against the track and modal background', () => {
  for (const token of ['--ui-scroll-track', '--ui-bg']) {
    assert.ok(tokenContrast('--ui-scroll-thumb', token) >= 3, 'Scrollbar thumb contrast against ' + token);
  }
});

test('the first-load shell remains readable while the app retrieves records', () => {
  assert.match(
    APP_DESIGN_GUIDANCE,
    /<main><h1>Orders<\/h1><p class="ui-loading" role="status">Loading orders…<\/p><\/main>/,
  );
  assert.match(APP_DESIGN_GUIDANCE, /aria-busy="true".+sibling role="status"/);
  assert.match(APP_DESIGN_GUIDANCE, /Keep text, rows, headers and ancestors at full opacity/);
  assert.match(
    APP_FOUNDATION_CSS,
    /\.ui \.ui-loading \{ color:var\(--ui-text\); background:var\(--ui-bg\); \}/,
  );
  assert.doesNotMatch(
    APP_FOUNDATION_CSS,
    /(?:\[aria-busy[^\]]*\]|\.ui-loading)[^{}]*\{[^}]*opacity\s*:\s*0?\./,
  );
  assert.ok(tokenContrast('--ui-text', '--ui-bg') >= 4.5);
});

test('design guidance scopes widgets to requested UI and distinguishes CSS from accessible behavior', () => {
  assert.match(APP_DESIGN_GUIDANCE, /do not add UI to backend tasks/);
  assert.match(APP_DESIGN_GUIDANCE, /not a requirement to install React or dependencies/);
  assert.match(APP_DESIGN_GUIDANCE, /CSS classes alone do not provide behavior/);
  assert.match(APP_DESIGN_GUIDANCE, /Text inputs can match :focus-visible after mouse focus too/);
  assert.match(APP_DESIGN_GUIDANCE, /cannot theme every OS popup/);
  assert.match(APP_DESIGN_GUIDANCE, /local-date parsing \(no UTC day shifts\)/);
  assert.match(APP_DESIGN_GUIDANCE, /"asset":"components\.mjs"/);
  assert.match(APP_DESIGN_GUIDANCE, /miter\.quality\.json/);
});

test('quantity fields remove native spinner chrome without replacing numeric input semantics', async () => {
  const css = await format(APP_FOUNDATION_CSS, { parser: 'css' });
  assert.match(css, /\.ui input\[type="number"\]\s*\{\s*appearance: textfield;/);
  for (const pseudo of ['inner', 'outer']) {
    assert.match(css, new RegExp('input\\[type="number"\\]::-webkit-' + pseudo + '-spin-button'));
  }
  assert.match(css, /::-webkit-outer-spin-button\s*\{\s*-webkit-appearance: none;\s*margin: 0;/);
  assert.doesNotMatch(css, /input\[type="number"\][^{]*\{[^}]*(?:pointer-events|display|visibility)\s*:/);
  assert.match(
    APP_DESIGN_GUIDANCE,
    /retain type="number", min\/max\/step, numeric editing, ArrowUp\/ArrowDown/,
  );
  assert.match(APP_DESIGN_GUIDANCE, /Do not intercept ordinary editing keys/);
});

test('suggestion and wrapper guidance closes the WorkshopDesk native-popup and focus gaps', () => {
  assert.match(APP_DESIGN_GUIDANCE, /Do not use native datalist\/input\[list\]/);
  assert.match(APP_DESIGN_GUIDANCE, /plain text input when suggestions are optional/);
  assert.match(APP_DESIGN_GUIDANCE, /wrapper ring must follow its child with :has\(:focus-visible\)/);
  assert.match(APP_DESIGN_GUIDANCE, /retain the child's ring as the fallback/);
  assert.match(APP_DESIGN_GUIDANCE, /without JavaScript modality tracking/);
  assert.match(APP_DESIGN_GUIDANCE, /Text inputs can match :focus-visible after mouse focus too/);
});

test('date fields reserve readable input space and wrap independently of viewport width', async () => {
  const css = await format(APP_FOUNDATION_CSS, { parser: 'css' });
  const field = css.match(/\.ui \.ui-date-field\s*\{([^}]+)\}/);
  const input = css.match(/\.ui \.ui-date-field > \.ui-control\s*\{([^}]+)\}/);
  const trigger = css.match(/\.ui \.ui-date-field > \.ui-button\s*\{([^}]+)\}/);
  assert.ok(field && input && trigger);
  assert.match(field[1], /display: flex;/);
  assert.match(field[1], /flex-wrap: wrap;/);
  assert.match(input[1], /min-inline-size: min\(100%, calc\(10ch \+ 1\.5rem \+ 2px\)\);/);
  assert.match(input[1], /font-variant-numeric: tabular-nums;/);
  assert.match(trigger[1], /flex: 0 0 auto;/);
  assert.match(trigger[1], /max-inline-size: 100%;/);
  assert.doesNotMatch(field[1] + input[1] + trigger[1], /(?:^|;)\s*(?:width|min-width|order):/);
  assert.doesNotMatch(css.slice(css.indexOf('@media')), /\.ui-date-field/);
  assert.match(APP_DESIGN_GUIDANCE, /full date readable in narrow columns even on wide screens/);
  assert.match(APP_DESIGN_GUIDANCE, /widen or stack the parent columns/);
});
