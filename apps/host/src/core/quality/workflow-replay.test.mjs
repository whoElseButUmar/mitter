import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { connect } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { browserExecutable } from './browser-executable.ts';
import { attachRecording, beginRecording, replayWorkflow } from '../workflows/runtime.ts';
import { WorkflowPreview, visitWorkflowPage } from '../workflows/runtime-preview.ts';

const chrome = await browserExecutable();
const signal = () => AbortSignal.timeout(60_000);
const steps = [
  { type: 'fill', selector: '#note', value: 'Window seat' },
  { type: 'click', selector: '#save' },
  { type: 'expect', selector: '#saved', text: 'Window seat', visible: true },
];

async function fixture(t, backend) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'miter-workflow-fixture-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, 'index.html'),
    `<!doctype html>
    <title>Note</title><input id="note"><button id="save">Save</button><p id="saved"></p>
    <script type="module" src="app.mjs"></script>`,
  );
  let app = `save.onclick = () => { localStorage.note = note.value; location.hash='saved'; show(); };
    function show() { if (location.hash === '#saved') saved.textContent = localStorage.note || ''; }
    show();`;
  if (backend) {
    await fs.writeFile(path.join(root, 'miter.backend.json'), JSON.stringify({ entry: 'backend.mjs' }));
    await fs.writeFile(
      path.join(root, 'backend.mjs'),
      `
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      export async function handle(request, {dataDir}) {
        const db = new DatabaseSync(path.join(dataDir, 'notes.sqlite'));
        try {
          db.exec('CREATE TABLE IF NOT EXISTS notes (body TEXT)');
          if (request.method === 'POST') db.prepare('INSERT INTO notes VALUES (?)').run(await request.json());
          return Response.json(db.prepare('SELECT body FROM notes').all());
        } finally { db.close(); }
      }`,
    );
    app = `save.onclick = async () => {
      await fetch('./api/notes', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(note.value)});
      location.hash = 'saved';
      await show();
    };
    async function show() { if (location.hash === '#saved') saved.textContent=(await (await fetch('./api/notes')).json()).map(n=>n.body).join(','); }
    show();`;
  }
  await fs.writeFile(path.join(root, 'app.mjs'), app);
  return root;
}

test(
  'Chrome records trusted actions and the selected result without activating it',
  { skip: !chrome },
  async (t) => {
    const root = await fixture(t, false);
    const preview = await WorkflowPreview.create(root, signal());
    t.after(() => preview.close());
    const { page, url } = await preview.launch(true);
    const recording = await attachRecording(page, new URL(url).origin);
    t.after(() => recording.dispose());
    await visitWorkflowPage(page, url);
    await page.type('#note', 'Window seat');
    await page.click('#save');
    await page.evaluate(() => {
      document.querySelector('#saved').onclick = () => (document.body.dataset.activated = 'yes');
    });
    await recording.expect();
    assert.throws(() => recording.read(), /expected result/);
    await page.click('#saved');
    assert.equal(await page.evaluate(() => document.body.dataset.activated), undefined);
    assert.deepEqual(recording.read(), steps);
  },
);

test(
  'Chrome restart replay restores the route and reads the submitted value from disposable SQLite',
  { skip: !chrome || process.platform !== 'darwin' },
  async (t) => {
    const root = await fixture(t, true);
    const before = await fs.readdir(root);
    const result = await replayWorkflow(root, steps, true, signal());
    assert.equal(result.ok, true, result.detail);
    assert.deepEqual(await fs.readdir(root), before);
  },
);

test(
  'a browser-only record passes ordinary replay and fails after server restart',
  { skip: !chrome },
  async (t) => {
    const root = await fixture(t, false);
    assert.equal((await replayWorkflow(root, steps, false, signal())).ok, true);
    const result = await replayWorkflow(root, steps, true, signal());
    assert.equal(result.ok, false);
    assert.match(result.detail, /after server restart/);
  },
);

// This integration installs a pinned Vite in the actual managed sandbox. The
// default host suite above exercises Chrome and SQLite without package downloads.
test(
  'real Vite restarts keep SQLite and drop process memory on a nested route',
  {
    skip: !chrome || process.platform !== 'darwin' || !process.env.MITER_TEST_FRAMEWORK_WORKFLOW,
    timeout: 600_000,
  },
  async (t) => {
    const root = await fixture(t, false);
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        scripts: { dev: 'vite' },
        devDependencies: { vite: '8.3.4' },
      }),
    );
    await fs.writeFile(
      path.join(root, 'index.html'),
      `<!doctype html>
    <title>Notes</title><input id="note"><button id="save">Save</button><p id="saved"></p>
    <script type="module" src="/app.mjs"></script>`,
    );
    await fs.writeFile(
      path.join(root, 'app.mjs'),
      `
    async function show() {
      if (location.pathname !== '/receipts/last') return;
      const response = await fetch('/api/note');
      saved.textContent = (await response.json()).note;
    }
    save.onclick = async () => {
      await fetch('/api/note', { method: 'POST', body: note.value });
      history.pushState({}, '', '/receipts/last');
      await show();
    };
    show();`,
    );
    for (const durable of [true, false]) {
      let database = "':memory:'";
      if (durable) {
        database = "join(process.env.MITER_DATA_DIR, 'notes.sqlite')";
      }
      await fs.writeFile(
        path.join(root, 'vite.config.mjs'),
        `
      import {DatabaseSync} from 'node:sqlite';
      import {join} from 'node:path';
      export default { plugins: [{ name: 'notes', configureServer(server) {
        const db = new DatabaseSync(${database});
        db.exec('CREATE TABLE IF NOT EXISTS notes(note TEXT)');
        server.middlewares.use('/api/note', async (req,res) => {
          if (req.method === 'POST') {
            let body = '';
            for await (const chunk of req) body += chunk;
            db.prepare('INSERT INTO notes VALUES (?)').run(body);
          }
          res.setHeader('Content-Type','application/json');
          res.end(JSON.stringify(db.prepare('SELECT note FROM notes LIMIT 1').get() ?? {note:''}));
        });
      }}] };`,
      );
      const result = await replayWorkflow(root, steps, true, AbortSignal.timeout(280_000));
      assert.equal(result.ok, durable, result.detail);
      if (!durable) {
        assert.match(result.detail, /after server restart/);
      }
    }
  },
);

test(
  'closing a workflow releases its Chrome process, preview listener and private profile',
  { skip: !chrome },
  async (t) => {
    const root = await fixture(t, false);
    const preview = await WorkflowPreview.create(root, signal());
    try {
      const { page, url } = await preview.launch(true);
      await visitWorkflowPage(page, url);
      const child = page.browser().process();
      const profile = child.spawnargs
        .find((arg) => arg.startsWith('--user-data-dir='))
        .slice('--user-data-dir='.length);
      const port = Number(new URL(url).port);
      await preview.close();
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
      await assert.rejects(fs.access(profile), { code: 'ENOENT' });
      await assert.rejects(
        new Promise((resolve, reject) => {
          const socket = connect(port, '127.0.0.1');
          socket.once('error', reject);
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
        }),
        { code: 'ECONNREFUSED' },
      );
    } finally {
      await preview.close();
    }
  },
);

test(
  'a visible recording can arm selection and close during a host shutdown',
  {
    skip: !chrome || !process.env.MITER_TEST_FRAMEWORK_WORKFLOW,
  },
  async (t) => {
    const root = await fixture(t, false);
    const controller = new AbortController();
    const recording = await beginRecording(root, controller.signal);
    try {
      await recording.expect();
      await assert.rejects(recording.finish(), /expected result/);
      controller.abort();
      await recording.closed;
    } finally {
      await recording.close();
    }
  },
);
