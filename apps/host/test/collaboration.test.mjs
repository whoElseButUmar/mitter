import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Collaboration } from '../src/core/collaboration.js';
import { Followups } from '../src/core/followups.js';
import { digest } from '../src/core/workspace.js';
import { memoryStore, temporaryDirectory, workerFixture } from './fixtures.mjs';
test('cooperative holds reject cycles/foreign tasks and validate persisted ' + 'team data', (t) => {
  const store = memoryStore(t);
  const first = workerFixture();
  const second = {
    ...workerFixture(),
    id: 'second',
    name: 'Second',
  };
  const foreign = {
    ...workerFixture(),
    id: 'foreign',
    projectId: 'foreign-project',
  };
  const workers = new Map([
    [first.id, first],
    [second.id, second],
    [foreign.id, foreign],
  ]);
  const team = new Collaboration(store, workers);
  const pause = {
    type: 'team_pause',
    workerId: second.id,
    reason: 'Read shared files',
    seconds: 120,
  };
  const result = team.execute(first, pause, 'pause-first');
  assert.equal(team.reason(second.id).includes('Read shared files'), true);
  assert.deepEqual(team.execute(first, pause, 'pause-first'), result);
  assert.throws(
    () =>
      team.execute(
        second,
        {
          ...pause,
          workerId: first.id,
        },
        'pause-cycle',
      ),
    /circular dependency/,
  );
  assert.throws(
    () =>
      team.execute(
        first,
        {
          ...pause,
          workerId: foreign.id,
        },
        'pause-foreign',
      ),
    /same project/,
  );
  team.releaseOwner(first.id);
  assert.equal(team.reason(second.id), '');
  assert.equal(
    team.messages(first.projectId).some((message) => message.kind === 'resume'),
    true,
  );
  store.db.prepare('UPDATE team_messages SET value=?').run('{"message":12}');
  assert.throws(() => team.messages(first.projectId));
  store.set('miter.team.holds.v1', [
    {
      from: 'unchecked',
      until: 'forever',
    },
  ]);
  assert.throws(() => new Collaboration(store, workers));
});
test(
  'follow-ups validate DB records and exact selected source before ' + 'admitting or resuming work',
  async (t) => {
    const store = memoryStore(t);
    const root = await temporaryDirectory(t);
    const worker = workerFixture();
    const followups = new Followups(store);
    await fs.writeFile(path.join(root, 'source.txt'), 'selected source');
    const request = {
      id: 'request',
      instruction: 'Preserve current files',
      selection: {
        path: 'source.txt',
        hash: digest('selected source'),
        start: 0,
        end: 8,
        text: 'selected',
      },
    };
    const saved = await followups.enqueue(worker, root, request);
    assert.equal(saved.status, 'queued');
    assert.equal(followups.summaries(worker.id)[0].path, 'source.txt');
    assert.deepEqual(await followups.enqueue(worker, root, request), saved);
    await assert.rejects(
      followups.enqueue(worker, root, {
        ...request,
        instruction: 'different',
      }),
      /different work/,
    );
    await fs.writeFile(path.join(root, 'source.txt'), 'external change');
    await assert.rejects(followups.checkSelection(saved, root), /Selected file changed/);
    assert.equal(followups.get(saved.id).status, 'blocked');
    store.db.prepare('UPDATE task_followups SET value=?').run('{"status":"unchecked"}');
    assert.throws(() => followups.get(saved.id));
    assert.throws(() => followups.list(worker.id));
  },
);
