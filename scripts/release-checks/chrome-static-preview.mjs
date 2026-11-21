import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ChromePipe } from './chrome-pipe.mjs';
import { page, evaluate, waitFor, click } from './chrome-ui.mjs';

/** Render the built host's actual HTTP preview in a separate private browser. */
export async function checkStaticPreview(executable, directory, log, signal) {
  const { PreviewSessions } = await import('../../dist/apps/host/src/core/preview/sessions.js');
  const sessions = new PreviewSessions();
  const owned = path.join(directory, 'static-preview');
  const project = path.join(owned, 'project');
  for (const name of ['home', 'tmp', 'project']) {
    await mkdir(path.join(owned, name), { recursive: true, mode: 0o700 });
  }
  await writeFile(
    path.join(project, 'index.html'),
    `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="./styles.css"></head><body>
    <h1>Preview fixture</h1><output id="count"></output><form id="counter"><button id="add" type="submit">Add</button></form>
    <script type="module" src="./app.mjs"></script></body></html>`,
  );
  await writeFile(path.join(project, 'styles.css'), 'body { color: rgb(20, 40, 60); }');
  await writeFile(path.join(project, 'domain.mjs'), 'export const increment = (value) => value + 1;');
  await writeFile(
    path.join(project, 'app.mjs'),
    `import { increment } from './domain.mjs';
    const output = document.querySelector('#count');
    let value = Number(localStorage.getItem('count') || 0);
    output.textContent = String(value);
    window.previewDocumentToken = crypto.randomUUID();
    document.querySelector('#counter').addEventListener('submit', (event) => {
      event.preventDefault();
      value = increment(value); localStorage.setItem('count', String(value)); output.textContent = String(value);
    });`,
  );
  // An unlinked project file must never appear in the public snapshot.
  await writeFile(path.join(project, 'private.html'), '<p>Private project content</p>');
  let chrome;
  try {
    const projectRoot = await realpath(project);
    const boundary = { runId: 'preview_fixture', epoch: 0 };
    const first = await sessions.start('first', boundary, projectRoot, () => signal.throwIfAborted());
    const second = await sessions.start('second', boundary, projectRoot, () => signal.throwIfAborted());
    assert.equal(first.files, 4);
    assert.equal(second.files, 4);
    await writeFile(path.join(project, 'domain.mjs'), 'throw new Error("Changed after snapshot");');
    const origins = [new URL(first.url).origin, new URL(second.url).origin];
    assert.notEqual(origins[0], origins[1]);
    chrome = new ChromePipe(executable, owned, log, signal, origins);
    const app = await page(chrome, first.url);
    await waitFor(chrome, app.session, 'document.querySelector("#count")?.textContent === "0"', 'module app');
    assert.equal(
      await evaluate(chrome, app.session, 'getComputedStyle(document.body).color'),
      'rgb(20, 40, 60)',
    );
    assert.equal(await evaluate(chrome, app.session, 'Boolean(globalThis.chrome?.runtime?.id)'), false);
    await click(chrome, app.session, '#add');
    assert.equal(await evaluate(chrome, app.session, 'document.querySelector("#count").textContent'), '1');
    const documentToken = await evaluate(chrome, app.session, 'window.previewDocumentToken');
    assert.equal(typeof documentToken, 'string');
    await chrome.request('Page.reload', {}, app.session);
    await waitFor(
      chrome,
      app.session,
      'typeof window.previewDocumentToken === "string" && window.previewDocumentToken !== ' +
        JSON.stringify(documentToken) +
        ' && document.querySelector("#count")?.textContent === "1"',
      'preview reload persistence',
    );
    const independent = await page(chrome, second.url);
    await waitFor(
      chrome,
      independent.session,
      'document.querySelector("#count")?.textContent === "0"',
      'separate preview storage',
    );
    const excluded = await page(chrome, first.url.replace('/index.html', '/private.html'));
    assert.match(
      await evaluate(chrome, excluded.session, 'document.body.textContent'),
      /choose Run.*Open app/i,
    );
    assert.deepEqual(
      chrome.events.filter((event) => event.method === 'Runtime.exceptionThrown'),
      [],
    );
    return {
      modules: true,
      styles: true,
      clientForm: true,
      immutableSnapshot: true,
      reloadStorage: true,
      separateOrigins: true,
      privateFilesExcluded: true,
    };
  } finally {
    try {
      await chrome?.close();
    } finally {
      await sessions.close();
    }
  }
}
