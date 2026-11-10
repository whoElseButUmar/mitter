import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { adaptSqliteDatabase, openBetterSqlite, databaseVersion } from '../src/adapters/sqlite.js';
import { memoryStore, projectFixture, workerFixture } from './fixtures.mjs';
import { digest } from '../src/core/edit-plan.js';
const receiptSchema = z
  .object({
    signature: z.string(),
  })
  .describe('Test receipt.');
test('SQLite adapters preserve receivers and reject malformed native results', () => {
  const statement = {
    result: {
      changes: 1,
      lastInsertRowid: 2,
    },
    row: {
      value: '{"signature":"valid"}',
    },
    run(value) {
      assert.equal(this, statement);
      assert.equal(value, 'bound');

      return this.result;
    },
    get() {
      assert.equal(this, statement);

      return this.row;
    },
    all() {
      assert.equal(this, statement);

      return [this.row];
    },
  };
  const resource = {
    exec() {
      assert.equal(this, resource);
    },
    prepare() {
      assert.equal(this, resource);

      return statement;
    },
    close() {
      assert.equal(this, resource);
    },
  };
  const database = adaptSqliteDatabase(resource);
  database.exec('SELECT 1');
  const checked = database.prepare('SELECT ?');
  assert.deepEqual(checked.run('bound'), {
    changes: 1,
    lastInsertRowid: 2,
  });
  assert.deepEqual(checked.all(), [statement.row]);
  statement.row = {
    value: {
      unchecked: true,
    },
  };
  assert.throws(() => checked.get());
  statement.result = {
    changes: '1',
    lastInsertRowid: 2,
  };
  assert.throws(() => checked.run('bound'));
  assert.throws(() => checked.run(NaN));
  assert.throws(() =>
    adaptSqliteDatabase({
      prepare() {},
    }),
  );
  database.close();
});
test('Store requires schemas for trusted JSON and validates persisted ' + 'domain/SQL records', (t) => {
  const store = memoryStore(t);
  store.set('receipt', {
    signature: 'checked',
  });
  assert.deepEqual(store.get('receipt'), {
    signature: 'checked',
  });
  assert.deepEqual(store.get('receipt', receiptSchema), {
    signature: 'checked',
  });
  assert.equal(store.get('absent', receiptSchema), undefined);
  store.set('receipt', {
    signature: 12,
  });
  assert.throws(() => store.get('receipt', receiptSchema));
  assert.throws(() => store.set('unsupported', undefined));
  store.saveProject(projectFixture('/fixture'));
  store.saveWorker(workerFixture());
  assert.equal(store.projects()[0].id, 'project');
  assert.equal(store.workers()[0].id, 'worker');
  store.db.prepare('UPDATE workers SET value=?').run('{"state":"invented"}');
  assert.throws(() => store.workers());
  store.rememberEnvelope('envelope', 'worker');
  assert.equal(store.envelopeOwner('envelope'), 'worker');
  assert.equal(store.envelopeCount('worker'), 1);
  store.event('worker', 'test', 'bounded event');
  assert.equal(store.taskEvents('worker')[0].message, 'bounded event');
  const journal = {
    id: 'edit',
    workerId: 'worker',
    runId: 'run',
    path: 'source.ts',
    before: null,
    after: 'hello',
    beforeHash: 'missing',
    afterHash: digest('hello'),
    status: 'prepared',
    time: Date.now(),
  };
  assert.throws(
    () =>
      store.prepareWrite({
        ...journal,
        after: 'corrupt content',
      }),
    /Journal content/,
  );
  store.prepareWrite(journal);
  assert.deepEqual(store.journal('edit'), journal);
  assert.equal(store.changedFiles('run')[0].bytes, 5);
  store.db.prepare('UPDATE journal SET after_hash=?').run('not-a-hash');
  assert.throws(() => store.writes('run'));
});
test('Store rollback and isolated-worktree project persistence retain ' + 'existing API behavior', (t) => {
  const store = memoryStore(t);
  assert.throws(
    () =>
      store.transaction(() => {
        store.set('rolled-back', true);

        throw new Error('abort');
      }),
    /abort/,
  );
  assert.equal(store.get('rolled-back'), undefined);
  store.saveProject({
    ...projectFixture('/worktree'),
    sourceRoot: '/original',
  });
  assert.equal(store.projects()[0].root, '/original');
  assert.equal(store.projects()[0].sourceRoot, undefined);
});
test('automatic SQLite rollback preserves the operation error and leaves no partial mutation', (t) => {
  const store = memoryStore(t);
  store.set('collision', 'original');

  assert.throws(
    () =>
      store.transaction(() => {
        store.set('partial-mutation', 'not committed');
        store.db.prepare('INSERT OR ROLLBACK INTO kv VALUES (?,?)').run('collision', 'replacement');
      }),
    (error) => {
      assert.match(error.message, /UNIQUE constraint failed/);
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /UNIQUE constraint failed/);
      assert.match(error.errors[1].message, /no transaction is active/);
      return true;
    },
  );
  assert.equal(store.get('collision'), 'original');
  assert.equal(store.get('partial-mutation'), undefined);
  store.transaction(() => store.set('next-mutation', 'committed'));
  assert.equal(store.get('next-mutation'), 'committed');
});

test('better-sqlite3 uses the same checked boundary as node:sqlite', async () => {
  const database = await openBetterSqlite(':memory:');

  try {
    assert.equal(databaseVersion(database), 0);
    database.exec('CREATE TABLE fixture (value TEXT)');
    database.prepare('INSERT INTO fixture VALUES (?)').run('hello');
    assert.deepEqual(database.prepare('SELECT value FROM fixture').get(), {
      value: 'hello',
    });
  } finally {
    database.close();
  }
});
