import assert from 'node:assert/strict';
import { test } from 'node:test';
import { domFixture } from './dom-fixture.mjs';
import { htmlDocument } from '../src/preview.js';

function asset(path, text, mime = 'text/plain', size = new TextEncoder().encode(text).length) {
  return {
    path,
    bytes: new TextEncoder().encode(text),
    mime,
    size,
    stamp: 'stamp',
  };
}

// A parsed-document fixture checks resource orchestration and DOM writes, not browser HTML parsing.
function parsedDocument(context, source) {
  const fixture = domFixture();
  fixture.root.innerHTML = source;
  fixture.document.documentElement = fixture.root;
  fixture.document.querySelector = (selector) => fixture.root.querySelector(selector);
  Object.defineProperty(fixture.root, 'outerHTML', {
    get: () =>
      '<html data-miter-preview="' +
      fixture.root.getAttribute('data-miter-preview') +
      '">' +
      fixture.root.textContent +
      '</html>',
  });
  context.mock.method(globalThis.DOMParser.prototype, 'parseFromString', (text, mime) => {
    assert.equal(text, source);
    assert.equal(mime, 'text/html');
    return fixture.document;
  });
  return fixture;
}

// Node has no native DOMParser. Install a placeholder so node:test can restore its mocked value.
if (!('DOMParser' in globalThis)) {
  globalThis.DOMParser = class {
    parseFromString() {
      throw new Error('Install the parsed-document fixture before parsing.');
    }
  };
}

test('HTML assembly removes unsafe elements and caches local resources', async (context) => {
  const source =
    '<base href="https://remote.test"><meta http-equiv="refresh"><iframe></iframe>' +
    '<object></object><embed><link rel="stylesheet" href="style.css">' +
    '<script src="app.js" type="module"></script><script src="https://remote.test/x"></script>' +
    '<img src="image.png" srcset="remote 2x"><source src="image.png">' +
    '<style>@import "remote.css";body{background:url(image.png)}</style>';
  const { root } = parsedDocument(context, source);
  const calls = [];
  const files = new Map([
    ['style.css', asset('style.css', 'a{background:url(image.png)}', 'text/css')],
    ['app.js', asset('app.js', 'const literal = "</script>";\r\n', 'text/javascript')],
    ['image.png', asset('image.png', 'image bytes', 'image/png')],
  ]);
  const result = await htmlDocument(asset('index.html', source, 'text/html'), async (path) => {
    calls.push(path);
    const file = files.get(path);
    assert.ok(file, 'Unexpected dependency: ' + path);
    return file;
  });
  assert.deepEqual(calls, ['style.css', 'image.png', 'app.js']);
  assert.equal(root.querySelector('base,meta,iframe,object,embed,link'), null);
  assert.equal(root.querySelectorAll('script').length, 1);
  assert.equal(root.querySelector('script').getAttribute('src'), null);
  assert.equal(root.querySelector('script').textContent, 'const literal = "<\\/script>";\r\n');
  assert.equal(root.querySelector('img').getAttribute('srcset'), null);
  assert.match(root.querySelector('img').getAttribute('src'), /^data:image\/png;base64,/);
  assert.ok(root.querySelectorAll('style').every((style) => !style.textContent.includes('@import')));
  assert.ok(result.warnings.includes('External scripts are disabled.'));
  assert.ok(result.warnings.includes('CSS @import is disabled in the isolated preview.'));
  assert.ok(result.warnings.some((warning) => warning.includes('Module imports')));
  assert.equal(root.getAttribute('data-miter-preview'), 'isolated');
  assert.match(result.html, /^<!doctype html><html data-miter-preview="isolated">/);
});

test('HTML assembly reports failed resources without fetching CSS imports', async (context) => {
  const source =
    '<link rel="stylesheet" href="missing.css"><script src="missing.js"></script>' +
    '<img src="missing.png"><style>@import "never-read.css";a{background:url(missing.png)}</style>';
  const { root } = parsedDocument(context, source);
  const calls = [];
  const result = await htmlDocument(asset('index.html', source, 'text/html'), async (path) => {
    calls.push(path);
    throw new Error('unavailable');
  });
  assert.deepEqual(calls, ['missing.css', 'missing.js', 'missing.png']);
  assert.equal(root.querySelector('link,script'), null);
  assert.equal(root.querySelector('img').getAttribute('src'), null);
  assert.match(root.querySelector('style').textContent, /url\(""\)/);
  assert.equal(new Set(result.warnings).size, result.warnings.length);
});

test('HTML assembly bounds resource count and total bytes', async (context) => {
  const source = Array.from({ length: 42 }, (_, index) => '<img src="image' + index + '.png">').join('');
  const { root } = parsedDocument(context, source);
  const calls = [];
  const result = await htmlDocument(asset('index.html', source, 'text/html'), async (path) => {
    calls.push(path);
    return asset(path, '', 'image/png');
  });
  assert.equal(calls.length, 40);
  assert.equal(root.querySelectorAll('img').filter((image) => image.getAttribute('src') === null).length, 2);
  assert.equal(result.warnings.length, 2);

  const largeSource = '<img src="large.png">';
  const large = parsedDocument(context, largeSource);
  const bounded = await htmlDocument(asset('index.html', largeSource, 'text/html'), async (path) =>
    asset(path, '', 'image/png', 24 * 1024 * 1024),
  );
  assert.equal(large.root.querySelector('img').getAttribute('src'), null);
  assert.deepEqual(bounded.warnings, ['Could not load large.png']);
});
