import { APP_COMPONENTS_JS } from '../../../../../packages/protocol/src/task-skills/app-components.js';
import { APP_FOUNDATION_CSS } from '../../../../../packages/protocol/src/task-skills/app-design.js';
import { VITE_API_JS } from '../../../../../packages/protocol/src/task-skills/vite-api.js';

const notes = `export const MAX_NOTE_LENGTH = 1600;

export function noteBody(input) {
  if (!input || typeof input.body !== 'string') {
    return undefined;
  }
  const body = input.body.trim();
  if (!body || body.length > MAX_NOTE_LENGTH) {
    return undefined;
  }
  return body;
}
`;

const backend = `import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { noteBody } from './notes.mjs';

export async function handle(request, { dataDir }) {
  const path = new URL(request.url).pathname;
  const item = /^\\/api\\/notes\\/([1-9][0-9]*)$/.exec(path);
  if (path !== '/api/notes' && !item) {
    return Response.json({ error: 'Note not found.' }, { status: 404 });
  }

  const db = new DatabaseSync(join(dataDir, 'notes.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)');
    if (!item && request.method === 'GET') {
      return Response.json(db.prepare('SELECT id, body FROM notes ORDER BY id DESC').all());
    }
    if (!item && request.method === 'POST') {
      let input;
      try {
        input = await request.json();
      } catch {
        return Response.json({ error: 'Send a JSON note.' }, { status: 400 });
      }
      const body = noteBody(input);
      if (body === undefined) {
        return Response.json({ error: 'Enter a note of 1 to 1600 characters.' }, { status: 422 });
      }
      const { lastInsertRowid } = db.prepare('INSERT INTO notes (body) VALUES (?)').run(body);
      return Response.json({ id: Number(lastInsertRowid), body }, { status: 201 });
    }
    if (item && request.method === 'DELETE') {
      const { changes } = db.prepare('DELETE FROM notes WHERE id = ?').run(item[1]);
      if (!changes) {
        return Response.json({ error: 'Note not found.' }, { status: 404 });
      }
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { Allow: item ? 'DELETE' : 'GET, POST' } });
  } finally {
    db.close();
  }
}
`;

const frontend = `import { confirmAction, createActionButton } from './components.mjs';
import { noteBody } from './notes.mjs';

type Note = { id: number; body: string };
function isNote(value: unknown): value is Note {
  return typeof value === 'object' && value !== null && 'id' in value &&
    typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0 &&
    'body' in value && typeof value.body === 'string';
}

const form = document.querySelector('#note-form');
const body = document.querySelector('#note-body');
const save = document.querySelector('#save-note');
const list = document.querySelector('#notes');
const empty = document.querySelector('#empty');
const error = document.querySelector('#note-error');
const status = document.querySelector('#status');
if (!(form instanceof HTMLFormElement) || !(body instanceof HTMLTextAreaElement) ||
    !(save instanceof HTMLButtonElement) || !(list instanceof HTMLUListElement) ||
    !(empty instanceof HTMLElement) || !(error instanceof HTMLElement) || !(status instanceof HTMLElement)) {
  throw new Error('The notes form could not open.');
}
mount(form, body, save, list, empty, error, status);

function mount(form: HTMLFormElement, body: HTMLTextAreaElement, save: HTMLButtonElement,
    list: HTMLUListElement, empty: HTMLElement, error: HTMLElement, status: HTMLElement) {
  function appendNote(note: Note, newest = false) {
    const row = document.createElement('li');
    const text = document.createElement('p');
    text.className = 'note-text';
    text.textContent = note.body;
    const remove = createActionButton('Delete', note.body.slice(0, 40));
    remove.addEventListener('click', async () => {
      const confirmed = await confirmAction({
        root: document.body, title: 'Delete note?', message: note.body,
        confirmLabel: 'Delete note', trigger: remove, returnFocus: () => row.isConnected ? remove : body,
      });
      if (!confirmed) {
        return;
      }
      remove.disabled = true;
      try {
        const response = await fetch('/api/notes/' + note.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
        if (!response.ok) {
          throw new Error('Delete failed.');
        }
        row.remove();
        empty.hidden = list.childElementCount > 0;
        body.focus();
        status.textContent = 'Note deleted.';
      } catch {
        remove.disabled = false;
        status.textContent = 'Could not delete this note. Try again.';
        remove.focus();
      }
    });
    row.append(text, remove);
    if (newest) {
      list.prepend(row);
    } else {
      list.append(row);
    }
    empty.hidden = true;
  }

  async function load() {
    try {
      const response = await fetch('/api/notes');
      if (!response.ok) {
        throw new Error('Load failed.');
      }
      const records: unknown = await response.json();
      if (!Array.isArray(records) || !records.every(isNote)) {
        throw new Error('Invalid notes.');
      }
      for (const note of records) {
        appendNote(note);
      }
      empty.hidden = records.length > 0;
    } catch {
      status.textContent = 'Could not load your notes. Reload to try again.';
    } finally {
      save.disabled = false;
    }
  }

  body.addEventListener('input', () => {
    body.removeAttribute('aria-invalid');
    error.textContent = '';
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (save.disabled) {
      return;
    }
    const draft = body.value;
    const value = noteBody({ body: draft });
    if (value === undefined) {
      error.textContent = 'Write a note before saving.';
      body.setAttribute('aria-invalid', 'true');
      body.focus();
      return;
    }
    save.disabled = true;
    try {
      const response = await fetch('/api/notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: value }),
      });
      if (!response.ok) {
        throw new Error('Save failed.');
      }
      const note: unknown = await response.json();
      if (!isNote(note)) {
        throw new Error('Invalid note.');
      }
      appendNote(note, true);
      if (body.value === draft) {
        body.value = '';
      }
      status.textContent = 'Note saved.';
      body.focus();
    } catch {
      status.textContent = 'Could not save this note. Check the list before trying again.';
    } finally {
      save.disabled = false;
    }
  });
  void load();
}
`;

const styles = `html { background: #faf9f6; }
body.ui {
  --ui-bg: #fff; --ui-text: #292a2b; --ui-accent: #344d42; --ui-hover: #edf1ed;
  --ui-border: #778079; --ui-radius: .375rem;
  margin: 0; min-height: 100vh; background: #faf9f6; font-family: system-ui, sans-serif;
}
main { max-inline-size: 42rem; margin: 0 auto; padding: clamp(1rem, 5vw, 4rem) 1rem; }
h1 { margin: 0 0 1.5rem; font: 600 clamp(2rem, 5vw, 3rem)/1.12 Georgia, serif; overflow-wrap: anywhere; }
h2 { margin: 0; font-size: 1.25rem; }
form, section { margin-block: 1.5rem; }
form { display: grid; gap: .5rem; }
label { font-weight: 600; }
textarea { min-block-size: 7rem; }
form button { justify-self: start; }
ul { list-style: none; margin: .5rem 0 0; padding: 0; }
li { display: flex; align-items: start; justify-content: space-between; gap: 1rem; border-top: 1px solid #bbc2bc; padding-block: .875rem; }
.note-text, .ui-dialog-body p { margin: .5rem 0; white-space: pre-wrap; overflow-wrap: anywhere; min-inline-size: 0; }
#empty { color: #46504b; }
#status:empty, #note-error:empty { display: none; }
#note-error, #status { margin: 0; }
`;

function html(name: string) {
  const title = name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Write, save and manage notes.">
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="./favicon.svg">
  <link rel="stylesheet" href="./foundation.css">
  <link rel="stylesheet" href="./styles.css">
  <script type="module" src="./main.ts"></script>
</head>
<body class="ui">
  <main>
    <h1>${title}</h1>
    <form id="note-form" novalidate>
      <label for="note-body">New note</label>
      <textarea id="note-body" class="ui-control" required maxlength="1600" rows="4" aria-describedby="note-error"></textarea>
      <p id="note-error" class="ui-error" role="alert"></p>
      <button id="save-note" type="submit" class="ui-button" data-variant="primary" disabled>Save note</button>
    </form>
    <p id="status" role="status"></p>
    <section aria-labelledby="saved-title">
      <h2 id="saved-title">Saved notes</h2>
      <p id="empty" hidden>No notes yet.</p>
      <ul id="notes"></ul>
    </section>
  </main>
</body>
</html>
`;
}

const journeys = [
  {
    name: 'Save and read back a note',
    steps: [
      { type: 'fill', selector: '#note-body', value: 'Collect the studio keys' },
      { type: 'click', selector: '#save-note' },
      { type: 'expect', selector: '#notes .note-text', text: 'Collect the studio keys', visible: true },
      { type: 'reload' },
      { type: 'expect', selector: '#notes .note-text', text: 'Collect the studio keys', visible: true },
      { type: 'click', selector: '#notes button' },
      { type: 'expect', selector: 'dialog button:first-child', focused: true },
      { type: 'press', key: 'Escape' },
      { type: 'expect', selector: 'dialog', count: 0 },
      { type: 'expect', selector: '#notes button', focused: true },
    ],
  },
  {
    name: 'Recover from an empty note',
    steps: [
      { type: 'click', selector: '#save-note' },
      { type: 'expect', selector: '#note-error', text: 'Write a note before saving.', visible: true },
      { type: 'expect', selector: '#note-body', focused: true },
      { type: 'fill', selector: '#note-body', value: 'Return the folder' },
      { type: 'expect', selector: '#note-error', visible: false },
    ],
  },
];

const tests = `import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_NOTE_LENGTH, noteBody } from './notes.mjs';

test('trim outer whitespace and preserve multiline notes', () => {
  assert.equal(noteBody({ body: '  First line\\nSecond line  ' }), 'First line\\nSecond line');
});
test('reject missing and overlength notes', () => {
  for (const input of [null, {}, { body: 23 }, { body: '  ' }, { body: 'x'.repeat(MAX_NOTE_LENGTH + 1) }]) {
    assert.equal(noteBody(input), undefined);
  }
  assert.equal(noteBody({ body: 'x'.repeat(MAX_NOTE_LENGTH) }).length, MAX_NOTE_LENGTH);
});
`;

function json(value: unknown) {
  return JSON.stringify(value, null, 2) + '\n';
}

export function viteSqliteStarter(name: string): ReadonlyMap<string, string> {
  return new Map([
    [
      'package.json',
      json({
        name: 'notes-app',
        private: true,
        type: 'module',
        engines: { node: '>=26' },
        scripts: {
          dev: 'vite',
          build: 'tsc --noEmit && vite build',
          preview: 'vite preview',
          test: 'node --test notes.test.mjs',
        },
        devDependencies: { typescript: '5.9.3', vite: '8.3.8' },
      }),
    ],
    [
      'tsconfig.json',
      json({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          strict: true,
          noEmit: true,
          allowJs: true,
          checkJs: false,
          skipLibCheck: true,
        },
        include: ['main.ts'],
      }),
    ],
    ['index.html', html(name)],
    [
      'favicon.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="2" width="26" height="28" rx="5" fill="#344d42"/><path stroke="#fff" stroke-width="2" d="M9 10h14M9 16h14M9 22h8"/></svg>\n',
    ],
    ['foundation.css', APP_FOUNDATION_CSS],
    ['styles.css', styles],
    ['components.mjs', APP_COMPONENTS_JS],
    ['main.ts', frontend],
    ['notes.mjs', notes],
    ['api.mjs', backend],
    ['vite-api.mjs', VITE_API_JS],
    [
      'vite.config.mjs',
      "import { viteApi } from './vite-api.mjs';\nimport { handle } from './api.mjs';\n\nexport default { plugins: [viteApi(handle)] };\n",
    ],
    ['notes.test.mjs', tests],
    ['miter.backend.json', json({ entry: 'api.mjs', files: ['notes.mjs'] })],
    [
      'miter.quality.json',
      json({
        version: 1,
        entry: 'index.html',
        styles: ['foundation.css', 'styles.css'],
        components: ['components.mjs'],
        tests: ['notes.test.mjs'],
        journeys,
      }),
    ],
    [
      'README.md',
      '# Notes\n\nRequires Node.js 26 and pnpm. Run `pnpm install` and `pnpm dev` to start the app. Run `pnpm test` for the note validation tests.\n\nFor a built preview, run `pnpm build` and `pnpm preview`. Both servers provide the notes API. Miter supplies `MITER_DATA_DIR` for the SQLite database. Outside Miter, set `APP_DATA_DIR` to choose a location, or use the default per-project directory under `~/.local/share/vite-apps`.\n',
    ],
  ]);
}
