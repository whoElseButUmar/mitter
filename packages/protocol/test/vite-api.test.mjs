import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parseProposalAction } from '../src/proposal.ts';
import { readBundledTaskSkill } from '../src/task-skills.ts';

test('the Vite adapter serves the same API and declared screens in dev and preview', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'miter-vite-api-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousDir = process.env.MITER_DATA_DIR;
  t.after(() => {
    if (previousDir === undefined) {
      delete process.env.MITER_DATA_DIR;
    } else {
      process.env.MITER_DATA_DIR = previousDir;
    }
  });
  process.env.MITER_DATA_DIR = join(root, 'storage');

  const { instructions } = readBundledTaskSkill('engineering-quality');
  const example = instructions.match(/copy (\{"type":"write","path":"vite-api\.mjs".+?\})/);
  assert.ok(example, 'New projects receive the exact asset write in their required skill read.');
  const write = parseProposalAction(JSON.parse(example[1]));
  await writeFile(join(root, write.path), write.content);
  const { viteApi } = await import(pathToFileURL(join(root, write.path)));
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const plugin = viteApi(
      async (request, { dataDir }) => {
        assert.equal(new URL(request.url).pathname, '/api/items');
        assert.equal(dataDir, process.env.MITER_DATA_DIR);
        const db = new DatabaseSync(join(dataDir, 'app.sqlite'));
        try {
          db.exec('CREATE TABLE IF NOT EXISTS items(name TEXT)');
          if (request.method === 'POST') {
            db.prepare('INSERT INTO items VALUES (?)').run((await request.json()).name);
            return Response.json({ saved: true }, { status: 201 });
          }
          return Response.json(db.prepare('SELECT name FROM items').all());
        } finally {
          db.close();
        }
      },
      (path) => path === '/items',
    );
    assert.equal(plugin.config().appType, 'mpa');
    const middleware = [];
    plugin[hook]({ middlewares: { use: (fn) => middleware.push(fn) } });
    const server = createServer((req, res) => {
      let index = 0;
      function next() {
        if (index < middleware.length) {
          return middleware[index++](req, res, next);
        }
        if (req.url !== '/index.html?sort=name') {
          res.statusCode = 404;
        }
        res.end();
      }
      next();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = 'http://127.0.0.1:' + server.address().port;
      if (hook === 'configureServer') {
        const saved = await fetch(origin + '/api/items', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Tripod' }),
        });
        assert.equal(saved.status, 201);
      }
      assert.deepEqual(await (await fetch(origin + '/api/items')).json(), [{ name: 'Tripod' }]);
      assert.equal((await fetch(origin + '/items?sort=name')).status, 200);
      for (const resource of ['/llms.txt', '/.well-known/ard.json', '/robots.txt', '/unknown']) {
        assert.equal((await fetch(origin + resource)).status, 404);
      }
    } finally {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  }
});
