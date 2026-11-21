import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APP_COMPONENTS_JS,
  APP_FOUNDATION_CSS,
} from '../../../../../packages/protocol/src/task-skills/app-design.ts';
import {
  inspectWebApp,
  qualityPathSchema,
  webAppQualityManifestSchema,
  webAppInspectionInputSchema,
  webAppInspectionSchema,
} from './inspect.ts';

const styles = `
.control:focus-visible { outline:2px solid #245; outline-offset:2px; }
:root { scrollbar-width:thin; scrollbar-color:#777 #fff; }
.scroll { overflow:auto; scrollbar-width:thin; scrollbar-color:#777 #fff; scrollbar-gutter:stable; }
@media (forced-colors:active) { .scroll { scrollbar-width:auto; scrollbar-color:auto; } }
dialog.panel { max-block-size:calc(100dvh - 2rem); overflow:clip; display:flex; flex-direction:column; }
dialog.panel .content { min-block-size:0; overflow:auto; }
`;

function fixture(overrides = {}) {
  const manifest = {
    version: 1,
    entry: 'index.html',
    styles: ['ui/controls.css'],
    components: ['ui/components.mjs'],
    tests: ['model.test.mjs'],
    journeys: [
      {
        name: 'Open editor',
        steps: [
          { type: 'press', key: 'Tab' },
          { type: 'expect', selector: 'dialog', visible: false },
        ],
      },
    ],
  };
  const contents = {
    'miter.quality.json': JSON.stringify(manifest),
    'index.html':
      '<link rel="stylesheet" href="ui/controls.css"><dialog class="panel"><div class="content">Body</div></dialog><script type="module" src="app.mjs"></script>',
    'app.mjs': 'import { mount } from "./ui/components.mjs"; mount(document.body);',
    'ui/controls.css': styles,
    'ui/components.mjs': 'export function mount(root) { root.dataset.ready = "true"; }',
    'model.test.mjs': 'throw new Error("Inspection must never execute a declared test.");',
    ...overrides,
  };
  return { manifest, files: Object.entries(contents).map(([path, content]) => ({ path, content })) };
}

function rules(result) {
  return result.issues.map((issue) => issue.rule);
}

test('connected shared sources pass without executing declared tests or requiring specific filenames', () => {
  const { files } = fixture();
  const result = inspectWebApp(files, ['index.html', 'app.mjs']);
  assert.deepEqual(result, { applicable: true, issues: [], tests: ['model.test.mjs'] });
  assert.deepEqual(webAppInspectionSchema.parse(result), result);
});

test('backend changes and standalone CSS without an HTML entry stay outside this gate', () => {
  const { files } = fixture({
    'server.mjs': 'export const port = 3000; // document.body, <input type="date">',
  });
  assert.deepEqual(
    inspectWebApp(
      files.filter((file) => file.path !== 'miter.quality.json'),
      ['server.mjs'],
    ),
    { applicable: false, issues: [], tests: [] },
  );
  assert.equal(
    inspectWebApp([{ path: 'print.css', content: 'p {color:black}' }], ['print.css']).applicable,
    false,
  );
  assert.equal(inspectWebApp(files, ['app.mjs']).applicable, true);
  assert.equal(inspectWebApp(files, ['ui/controls.css']).applicable, true);
});

test('Next home pages include framework layouts but unrelated routes cannot supply compliance styles', () => {
  const { manifest } = fixture();
  const nextManifest = { ...manifest, entry: 'src/app/(office)/page.jsx', components: ['ui/Control.jsx'] };
  const { files } = fixture({
    'miter.quality.json': JSON.stringify(nextManifest),
    'src/app/(office)/page.jsx':
      'import Control from "../../../ui/Control"; export default function Page(){return <Control />}',
    'src/app/layout.jsx':
      'import "../../ui/controls.css"; export default function Layout({children}){return <body>{children}</body>}',
    'ui/Control.jsx': 'export default function Control(){ return <button>Open</button> }',
  });
  const next = files.filter((file) => !file.path.endsWith('.html'));
  assert.deepEqual(inspectWebApp(next, ['package.json'], 'next').issues, []);
  const wrong = next.map((file) => {
    if (file.path === 'src/app/layout.jsx') {
      return { ...file, path: 'src/app/another-route/layout.jsx' };
    }
    return file;
  });
  assert.ok(rules(inspectWebApp(wrong, ['package.json'], 'next')).includes('asset.unlinked'));
  assert.ok(rules(inspectWebApp(next, ['package.json'], 'vite')).includes('manifest.entry'));
  assert.deepEqual(
    rules(
      inspectWebApp(
        next.filter((file) => file.path !== 'miter.quality.json'),
        ['package.json'],
        'next',
      ),
    ),
    ['manifest.missing'],
  );
});

test('an existing manifest opts domain, manifest and configuration changes into repeated checks', () => {
  const { files } = fixture({
    'domain.mjs': 'export const valid = (name) => name.length > 0;',
    'package.json': '{}',
  });
  for (const changed of ['domain.mjs', 'miter.quality.json', 'package.json']) {
    const result = inspectWebApp(files, [changed]);
    assert.equal(result.applicable, true, changed);
    assert.deepEqual(result.tests, ['model.test.mjs']);
  }
  const missingEntry = inspectWebApp(
    files.filter((file) => file.path !== 'index.html'),
    ['miter.quality.json'],
  );
  assert.ok(
    missingEntry.issues.some((issue) => issue.path === 'index.html' && issue.rule === 'asset.missing'),
  );
  assert.equal(inspectWebApp(files, ['README.md']).applicable, false);
});

test('applicable UI work requires the exact manifest contract', () => {
  const { files, manifest } = fixture();
  assert.deepEqual(
    rules(
      inspectWebApp(
        files.filter((file) => file.path !== 'miter.quality.json'),
        ['index.html'],
      ),
    ),
    ['manifest.missing'],
  );
  for (const content of [
    '{',
    JSON.stringify({ ...manifest, command: 'node --test' }),
    JSON.stringify({ ...manifest, version: 2 }),
    JSON.stringify({ ...manifest, tests: [] }),
  ]) {
    const changed = files.map((file) => {
      if (file.path === 'miter.quality.json') {
        return { ...file, content };
      }
      return file;
    });
    assert.deepEqual(rules(inspectWebApp(changed, ['index.html'])), ['manifest.invalid']);
  }
});

test('manifest paths cannot escape the project or become test command arguments', () => {
  const { manifest } = fixture();
  for (const value of [
    '/tmp/a.test.mjs',
    '../a.test.mjs',
    'src/../a.test.mjs',
    './a.test.mjs',
    'src//a.test.mjs',
    'C:/a.test.mjs',
    'src\\a.test.mjs',
    '%2e%2e/a.test.mjs',
    'a.test.mjs?command=x',
    'a.test.mjs#x',
    'a\u0000.test.mjs',
  ]) {
    assert.equal(qualityPathSchema.safeParse(value).success, false, value);
    assert.equal(webAppQualityManifestSchema.safeParse({ ...manifest, tests: [value] }).success, false);
  }
  for (const value of ['node --test', 'node --test a.test.mjs', '--test.test.mjs']) {
    const result = webAppQualityManifestSchema.safeParse({ ...manifest, tests: [value] });
    assert.equal(result.success, false, 'Reject command-like test path: ' + value);
  }
  assert.equal(
    webAppQualityManifestSchema.safeParse({ ...manifest, tests: ['model.test.mjs', 'model.test.mjs'] })
      .success,
    false,
  );
});

test('missing and unlinked manifest assets are reported; missing tests are never returned for execution', () => {
  const { files } = fixture({
    'ui/components.mjs': 'export const unused = true;',
    'app.mjs': 'document.body.dataset.ready = "true";',
  });
  const result = inspectWebApp(
    files.filter((file) => file.path !== 'model.test.mjs'),
    ['index.html'],
  );
  assert.ok(
    result.issues.some((issue) => issue.path === 'ui/components.mjs' && issue.rule === 'asset.unlinked'),
  );
  assert.ok(result.issues.some((issue) => issue.path === 'model.test.mjs' && issue.rule === 'asset.missing'));
  assert.deepEqual(result.tests, []);
});

test('comments and string descriptions cannot connect decoy component or stylesheet files', () => {
  const { files } = fixture({
    'index.html':
      '<!-- <link rel="stylesheet" href="ui/controls.css"> --><script type="module" src="app.mjs"></script>',
    'app.mjs':
      'const note = "import \'./ui/components.mjs\'"; /* import "./ui/components.mjs" */ document.body.textContent = note;',
  });
  const result = inspectWebApp(files, ['index.html']);
  assert.ok(
    result.issues.some((issue) => issue.path === 'ui/components.mjs' && issue.rule === 'asset.unlinked'),
  );
  assert.ok(
    result.issues.some((issue) => issue.path === 'ui/controls.css' && issue.rule === 'asset.unlinked'),
  );
  assert.ok(rules(result).includes('focus.visible'), 'Unlinked shared CSS must not satisfy focus rules.');
});

test('literal module chains and CSS imports connect shared sources across directories', () => {
  const { files } = fixture({
    'index.html': '<link rel="stylesheet" href="theme.css"><script type="module" src="src/app.mjs"></script>',
    'theme.css': '@import url("./ui/controls.css");',
    'src/app.mjs': 'const icon = "📅"; export { mount } from "../ui/components.mjs";',
  });
  assert.deepEqual(inspectWebApp(files, ['index.html']).issues, []);
});

test('RoomLedger native date and time controls are rejected in HTML, JSX and string templates', () => {
  for (const markup of [
    '<input type="date">',
    "<input type='time'>",
    '<input type=month>',
    '<input type={"week"}/>',
    '<input type="datetime-local">',
  ]) {
    const { files } = fixture({ 'ui/components.mjs': 'export const markup = `' + markup + '`;' });
    const result = inspectWebApp(files, ['index.html']);
    assert.ok(
      result.issues.some(
        (issue) => issue.path === 'ui/components.mjs' && issue.rule === 'control.native-date',
      ),
      markup,
    );
  }
  const { files } = fixture({
    'index.html':
      '<input TYPE="DATE"><link rel="stylesheet" href="ui/controls.css"><script type="module" src="app.mjs"></script>',
  });
  assert.ok(
    inspectWebApp(files, ['index.html']).issues.some(
      (issue) => issue.path === 'index.html' && issue.rule === 'control.native-date',
    ),
  );
});

test('created input type assignments and native dialog calls are caught and deduplicated', () => {
  for (const assignment of ['field.type = "date";', 'field.setAttribute("type", "time");']) {
    const { files } = fixture({
      'ui/components.mjs':
        'const field = document.createElement("input"); ' +
        assignment +
        ' window.alert("No"); confirm("Sure?"); prompt("Name"); alert("Again");',
    });
    const result = inspectWebApp(files, ['index.html']);
    assert.deepEqual(rules(result), ['control.native-date', 'dialog.native']);
  }
});

test('comments and ordinary strings do not produce native-control or native-dialog findings', () => {
  const { files } = fixture({
    'index.html':
      '<!-- <input type="date"><dialog> --><link rel="stylesheet" href="ui/controls.css"><script type="module" src="app.mjs"></script>',
    'ui/components.mjs':
      '/* alert("bad"); const field = document.createElement("input"); field.type="date"; */\n// prompt("bad");\nconst label = "📅 alert( confirm( prompt("; export const html = `<!-- <input type="time"> -->`;',
  });
  assert.deepEqual(inspectWebApp(files, ['index.html']).issues, []);
});

test('RoomLedger blanket focus rings fail even alongside valid focus-visible controls', () => {
  const { files } = fixture({
    'ui/controls.css': styles + '\nbutton:focus, input:focus-visible { outline:2px solid blue; }',
  });
  assert.deepEqual(rules(inspectWebApp(files, ['ui/controls.css'])), ['focus.blanket']);
});

test('WorkshopDesk instructor suggestions and search wrapper ring fail the connected source gate', () => {
  const { files } = fixture({
    'index.html': `<link rel="stylesheet" href="ui/controls.css"><script type="module" src="app.mjs"></script>
      <label for="session-instructor">Instructor</label>
      <input class="ui-control" id="session-instructor" name="instructor" required list="known-instructors">
      <datalist id="known-instructors"></datalist>
      <input class="ui-control" name="capacity" type="number" min="1" max="500" step="1" required>`,
    'ui/controls.css':
      styles +
      '\n.search-field:focus-within { outline:2px solid #2856c7; outline-offset:2px; }' +
      '\n.search-field input:focus-visible { outline:none; }',
  });
  const result = inspectWebApp(files, ['index.html', 'ui/controls.css']);
  assert.deepEqual(rules(result), ['control.native-datalist', 'focus.blanket']);
  assert.equal(result.issues.find((issue) => issue.rule === 'control.native-datalist').path, 'index.html');
});

test('native suggestions are rejected in linked HTML, JSX, templates and direct DOM creation', () => {
  for (const markup of ['<datalist id="names"></datalist>', '<INPUT LIST=names>', '<input list="names">']) {
    const { files } = fixture({
      'index.html':
        markup +
        '<link rel="stylesheet" href="ui/controls.css"><script type="module" src="app.mjs"></script>',
    });
    assert.deepEqual(rules(inspectWebApp(files, ['index.html'])), ['control.native-datalist'], markup);
  }
  for (const source of [
    'export const view = <input list="names"/>;',
    'export const view = <datalist id="names"/>;',
    'export const view = `<input list="names"><datalist id="names"></datalist>`;',
    'const options = document.createElement("datalist"); document.body.append(options);',
    'document.body.append(document.createElement("DATALIST"));',
    'const field = document.createElement("input"); field.setAttribute("list", "names");',
  ]) {
    const { files } = fixture({ 'ui/components.mjs': source });
    const result = inspectWebApp(files, ['index.html']);
    assert.deepEqual(rules(result), ['control.native-datalist'], source);
    assert.equal(result.issues[0].path, 'ui/components.mjs');
  }
});

test('suggestion checks do not reject disconnected examples, comments or accessible component equivalents', () => {
  const { files } = fixture({
    'index.html':
      '<!-- <input list="names"><datalist id="names"></datalist> -->' +
      '<link rel="stylesheet" href="ui/controls.css"><script type="module" src="app.mjs"></script>',
    'unused.mjs': 'document.createElement("datalist");',
    'ui/components.mjs': `
      // document.createElement('datalist');
      /* const field = document.createElement('input'); field.setAttribute('list', 'names'); */
      const example = "document.createElement('datalist')";
      const field = document.createElement('input');
      const note = "field.setAttribute('list', 'names')";
      export const custom = <Datalist list="names"/>;
      export const markup = '<input data-list="names" role="combobox" aria-controls="suggestions" aria-expanded="false"><div role="listbox" id="suggestions"></div><input type="text"><datalist-widget></datalist-widget>';
    `,
  });
  assert.deepEqual(inspectWebApp(files, ['index.html']).issues, []);
});

test('wrapper rings follow focus-visible while non-ring focus-within styling remains available', () => {
  for (const selector of [
    '.field:has(:focus-visible)',
    '.field:has(:is(input, button):focus-visible)',
    '.field:focus-within:has(:focus-visible)',
  ]) {
    const { files } = fixture({
      'ui/controls.css':
        styles + '\n.field:focus-within { color:#123; }\n' + selector + ' { outline:2px solid blue; }',
    });
    assert.deepEqual(inspectWebApp(files, ['ui/controls.css']).issues, [], selector);
  }
  for (const selector of ['.search-field:focus-within', '.search-field:focus-within, button:focus-visible']) {
    const { files } = fixture({
      'ui/controls.css': styles + '\n' + selector + ' { box-shadow:0 0 0 2px blue; }',
    });
    assert.deepEqual(rules(inspectWebApp(files, ['ui/controls.css'])), ['focus.blanket'], selector);
  }
});

test('a wrapper ring finding identifies the stylesheet that owns the rule', () => {
  const prepared = fixture({ 'app.css': '.search:focus-within { outline:2px solid blue; }' });
  const files = prepared.files.map((file) => {
    if (file.path === 'miter.quality.json') {
      return {
        ...file,
        content: JSON.stringify({ ...prepared.manifest, styles: ['ui/controls.css', 'app.css'] }),
      };
    }
    if (file.path === 'index.html') {
      return { ...file, content: file.content + '<link rel="stylesheet" href="app.css">' };
    }
    return file;
  });
  const result = inspectWebApp(files, ['app.css']);
  assert.deepEqual(rules(result), ['focus.blanket']);
  assert.equal(result.issues[0].path, 'app.css');
});

test('commented focus rules and scrollbars outside the forced-colors block are not evidence', () => {
  const badStyles = styles
    .replace(
      '.control:focus-visible { outline:2px solid #245; outline-offset:2px; }',
      '/* :focus-visible { outline:2px solid blue; } */',
    )
    .replace(
      '@media (forced-colors:active) { .scroll { scrollbar-width:auto; scrollbar-color:auto; } }',
      '@media (forced-colors:active) { .scroll {color:CanvasText} } .unrelated {scrollbar-width:auto}',
    );
  const { files } = fixture({ 'ui/controls.css': badStyles });
  assert.deepEqual(rules(inspectWebApp(files, ['ui/controls.css'])), [
    'focus.visible',
    'scrollbar.forced-colors',
  ]);
});

test('RoomLedger default scrollbars and scrolling modal shell need explicit shared fixes', () => {
  const badStyles = styles
    .replaceAll('scrollbar-width:thin;', 'scrollbar-width:auto;')
    .replaceAll('scrollbar-color:#777 #fff;', '')
    .replace('scrollbar-gutter:stable;', '')
    .replace('overflow:clip;', 'overflow:auto;')
    .replace('min-block-size:0;', '');
  const { files } = fixture({ 'ui/controls.css': badStyles });
  assert.deepEqual(rules(inspectWebApp(files, ['ui/controls.css'])), [
    'modal.body',
    'modal.shell',
    'scrollbar.document',
    'scrollbar.scrollbar-color',
    'scrollbar.scrollbar-gutter',
    'scrollbar.scrollbar-width',
  ]);
});

test('body and named scroll-area styles do not satisfy document scrollbar coverage', () => {
  for (const selector of [
    'body',
    '.ui',
    '.ui *',
    'html .scroll',
    ':where(html) .scroll',
    ':where(body)',
    ':is(.ui, body)',
    ':where(body):is(.ui, :root)',
    ':is(html .scroll, body)',
    '.pane\\,html',
    'html::before',
  ]) {
    const { files } = fixture({ 'ui/controls.css': styles.replace(':root {', selector + ' {') });
    assert.deepEqual(rules(inspectWebApp(files, ['ui/controls.css'])), ['scrollbar.document'], selector);
  }
});

test('linked root, universal and wrapped root selectors theme the document scrollbar', () => {
  for (const selector of [
    'html',
    ':root',
    '*',
    ':root, .ui, .ui *',
    ':where(html, body)',
    ':is(.ui, :root)',
    ':where(:is(html, body))',
  ]) {
    const { files } = fixture({ 'ui/controls.css': styles.replace(':root {', selector + ' {') });
    assert.deepEqual(inspectWebApp(files, ['ui/controls.css']).issues, [], selector);
  }
});

test('document width and color may be separate root rules but must both be connected', () => {
  const rootRule = ':root { scrollbar-width:thin; scrollbar-color:#777 #fff; }';
  const { files } = fixture({
    'ui/controls.css': styles.replace(
      rootRule,
      'html { scrollbar-width:thin; } :root { scrollbar-color:#777 #fff; }',
    ),
  });
  assert.deepEqual(inspectWebApp(files, ['ui/controls.css']).issues, []);
  for (const replacement of [
    '/* ' + rootRule + ' */',
    ':root { scrollbar-width:thin; }',
    ':root { scrollbar-color:#777 #fff; }',
  ]) {
    const unthemed = fixture({
      'ui/controls.css': styles.replace(rootRule, replacement),
      'unused.css': rootRule,
    });
    assert.deepEqual(rules(inspectWebApp(unthemed.files, ['ui/controls.css'])), ['scrollbar.document']);
  }
});

test('apps with no dialog do not acquire a modal implementation requirement', () => {
  const { files } = fixture({
    'index.html':
      '<link rel="stylesheet" href="ui/controls.css"><script type="module" src="app.mjs"></script>',
    'ui/controls.css': styles.split('dialog.panel')[0],
  });
  assert.deepEqual(inspectWebApp(files, ['index.html']).issues, []);
});

test('the packaged date picker and foundation pass the modal body gate as shipped', () => {
  const { files } = fixture({
    'index.html':
      '<html class="ui"><head><link rel="stylesheet" href="ui/controls.css"></head><body><label>Due date<input id="due"></label><script type="module" src="app.mjs"></script></body></html>',
    'app.mjs': `import { createDatePicker } from './ui/components.mjs';
      createDatePicker(document.querySelector('#due'));`,
    'ui/controls.css': APP_FOUNDATION_CSS,
    'ui/components.mjs': APP_COMPONENTS_JS,
  });
  assert.deepEqual(inspectWebApp(files, ['app.mjs']).issues, []);
});

test('modal scrolling rules can be composed on the same literal body element', () => {
  const shared = styles.replace(
    'dialog.panel .content { min-block-size:0; overflow:auto; }',
    '.body { min-block-size:0; }',
  );
  const { files } = fixture({
    'index.html':
      '<link rel="stylesheet" href="ui/controls.css"><dialog class="panel"><section class="body scroll">Body</section></dialog><script type="module" src="app.mjs"></script>',
    'ui/controls.css': shared,
  });
  assert.deepEqual(inspectWebApp(files, ['index.html']).issues, []);
  const separated = files.map((file) => {
    if (file.path === 'index.html') {
      return { ...file, content: file.content.replace('class="body scroll"', 'class="body"') };
    }
    return file;
  });
  assert.deepEqual(rules(inspectWebApp(separated, ['index.html'])), ['modal.body']);
});

test('data attributes and textual documentation do not change a text input into a date control', () => {
  const { files } = fixture({
    'ui/components.mjs': 'export const html = `<input data-type="date" type="text">`;',
  });
  assert.deepEqual(inspectWebApp(files, ['index.html']).issues, []);
  const native = fixture({ 'ui/components.mjs': 'export const html = `<input type=date/>`;' });
  assert.ok(rules(inspectWebApp(native.files, ['index.html'])).includes('control.native-date'));
});

test('findings are deterministic, bounded and collapsed by path/rule', () => {
  const { files } = fixture();
  for (let index = 0; index < 25; index++) {
    files.push({
      path: 'part-' + index + '.mjs',
      content: 'alert("one"); alert("two"); export const html = `<input type="date"><input type="time">`;',
    });
  }
  files.push({
    path: 'many.html',
    content:
      files
        .filter((file) => file.path.startsWith('part-'))
        .map((file) => '<script type="module" src="' + file.path + '"></script>')
        .join('') +
      '<link rel="stylesheet" href="ui/controls.css"><script type="module" src="app.mjs"></script>',
  });
  const declaration = files.find((file) => file.path === 'miter.quality.json');
  const manifest = JSON.parse(declaration.content);
  declaration.content = JSON.stringify({ ...manifest, entry: 'many.html' });
  const result = inspectWebApp(files, ['many.html']);
  assert.equal(result.issues.length, 20);
  assert.equal(result.issues.at(-1).rule, 'inspection.limit');
  assert.equal(new Set(result.issues.map((issue) => issue.path + issue.rule)).size, 20);
  assert.deepEqual(inspectWebApp([...files].reverse(), ['many.html']), result);
});

test('source collection bounds count UTF-8 bytes and reject duplicate or unsafe inputs', () => {
  assert.equal(
    webAppInspectionInputSchema.safeParse({
      files: [{ path: 'large.js', content: 'é'.repeat(60001) }],
      changedPaths: [],
    }).success,
    false,
  );
  assert.equal(
    webAppInspectionInputSchema.safeParse({
      files: [
        { path: 'same.js', content: '' },
        { path: 'same.js', content: '' },
      ],
      changedPaths: [],
    }).success,
    false,
  );
  assert.equal(
    webAppInspectionInputSchema.safeParse({
      files: Array.from({ length: 257 }, (_, index) => ({ path: index + '.js', content: '' })),
      changedPaths: [],
    }).success,
    false,
  );
  assert.equal(
    webAppInspectionInputSchema.safeParse({
      files: Array.from({ length: 40 }, (_, index) => ({ path: index + '.js', content: 'x'.repeat(120000) })),
      changedPaths: [],
    }).success,
    false,
  );
  assert.throws(() => inspectWebApp([{ path: '../outside.html', content: '' }], ['../outside.html']));
});
