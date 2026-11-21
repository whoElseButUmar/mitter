import assert from 'node:assert/strict';
import { test } from 'node:test';
import { javascriptReferences } from './module-references.ts';

test('JavaScript parsing distinguishes real imports from quotes, comments, regexes and template text', () => {
  const source = [
    "const example = \"import './private.js'; fetch('/api');\";",
    "// import './ignored.js';",
    "/* export * from './also-ignored.js'; */",
    'const expression = /["\'`]|import|export|\\/\\/|\\/\\*/g;',
    "const template = `import './template-text.js'`;",
    "import { value } from './real.mjs';",
    "export { value } from './reexport.mjs';",
    "export * from './all.mjs';",
  ].join('\n');
  assert.deepEqual(javascriptReferences(source), ['./real.mjs', './reexport.mjs', './all.mjs']);
});

test('literal imports inside template expressions are collected and computed imports fail explicitly', () => {
  assert.deepEqual(
    javascriptReferences("const value = `${await import('./actual.mjs')}`; import(`./literal.mjs`);"),
    ['./actual.mjs', './literal.mjs'],
  );
  assert.throws(
    () => javascriptReferences('const value = `${await import(chosenModule)}`;'),
    /Computed module imports/,
  );
  assert.throws(() => javascriptReferences('import { unclosed'), /invalid JavaScript/);
});

test(
  'long malformed imports and unterminated comments produce bounded parse outcomes',
  { timeout: 3000 },
  () => {
    assert.throws(() => javascriptReferences('import ' + ' '.repeat(200000)), /invalid JavaScript/);
    assert.throws(() => javascriptReferences('/*'.repeat(100000)), /invalid JavaScript/);
    assert.deepEqual(javascriptReferences('// import ./ignored\n'.repeat(10000)), []);
  },
);
