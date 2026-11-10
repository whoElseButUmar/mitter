import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { parseRequest } from '../../../packages/protocol/src/index.js';
import { progressKey } from '../../../packages/bridge/src/progress.js';
import {
  digest,
  fixture,
  importBatch,
  makeEnvelope,
  makeProgress,
  makeWorker,
  registerScript,
  runToBoundary,
} from '../src/core/service/test-fixture.mjs';
import { parseLocalDraft, parseLocalProposal } from '../src/core/service/request-parsing.js';
import { pickFolder } from '../src/core/desktop.js';
import { prepareNativeTerminal, checkDarwinHelper } from '../src/core/pty-runtime.js';
import { openRuntime } from '../src/runtime.js';
import { memoryStore, temporaryDirectory } from './fixtures.mjs';

function capture(owned) {
  return {
    worker: structuredClone(owned.worker),
    projects: structuredClone([...owned.service.projects.values()]),
    savedWorkers: owned.store.workers(),
    savedProjects: owned.store.projects(),
    values: owned.store.db.prepare('SELECT key,value FROM kv ORDER BY key').all(),
    events: owned.store.events(),
    envelopes: owned.store.db.prepare('SELECT * FROM envelopes ORDER BY id').all(),
    journal: owned.store.db.prepare('SELECT * FROM journal ORDER BY id').all(),
    followups: owned.store.db.prepare('SELECT * FROM task_followups ORDER BY id').all(),
    messages: owned.store.db.prepare('SELECT * FROM team_messages ORDER BY id').all(),
  };
}

async function unchangedRejection(owned, method, params, expected) {
  const before = capture(owned);
  await assert.rejects(owned.service.handle(method, params), expected);
  assert.deepEqual(capture(owned), before);
}

function friendlySchemaError(message) {
  return (error) => {
    assert.match(error.message, message);
    assert.ok(error.cause instanceof ZodError);
    assert.equal(error.message.includes('invalid_type'), false);
    return true;
  };
}

test('direct JSON/CLI params reject non-objects before dispatch while native null migration remains supported', async (t) => {
  const owned = await fixture(t);

  for (const params of [null, [], 'not an object', 12, false, undefined]) {
    await unchangedRejection(owned, 'state', params, /Expected params/);
  }

  const legacy = await owned.service.dispatch(parseRequest({ id: 'legacy', method: 'state', params: null }));
  assert.equal(legacy.ok, true);
  assert.equal(legacy.result.protocol, 'mitter/1');
});

test('project context validates every update field before changing in-memory or saved configuration', async (t) => {
  const owned = await fixture(t);
  const params = { projectId: owned.project.id, save: true, mission: 'Original', conventions: 'Keep files.' };
  await owned.service.handle('project.context', params);

  await unchangedRejection(
    owned,
    'project.context',
    { ...params, mission: 'Must not replace the mission.', conventions: 12 },
    /Invalid conventions/,
  );
  await unchangedRejection(
    owned,
    'project.context',
    { ...params, save: 'true' },
    friendlySchemaError(/Invalid project context save/),
  );
  assert.deepEqual(await owned.service.handle('project.context', { projectId: owned.project.id }), {
    mission: 'Original',
    conventions: 'Keep files.',
  });
});

test('invalid project names are rejected before filesystem resolution or catalog insertion', async (t) => {
  const owned = await fixture(t);
  let resolutions = 0;
  t.mock.method(fs, 'realpath', async () => {
    resolutions++;
    throw new Error('Invalid input must not reach the filesystem.');
  });

  await unchangedRejection(owned, 'project.add', { root: owned.root, name: 12 }, /Invalid project name/);
  assert.equal(resolutions, 0);
  t.mock.restoreAll();
});

test('malformed approval booleans cannot deny, consume a token, grant trust, or launch a command', async (t) => {
  const owned = await fixture(t);
  const profile = await registerScript(
    owned.service,
    owned.project,
    owned.root,
    "require('node:fs').writeFileSync('approval-ran.txt', 'ran');",
  );
  await importBatch(owned.service, owned.worker, [{ type: 'command', profileId: profile.id }]);
  await runToBoundary(owned.service, owned.worker);
  assert.ok(owned.worker.pending);
  const params = { workerId: owned.worker.id, token: owned.worker.pending.token, approve: true };

  for (const changed of [{ approve: 'false' }, { approve: null }, { trustRun: 'true' }, { trustRun: {} }]) {
    await unchangedRejection(
      owned,
      'worker.approve',
      { ...params, ...changed },
      friendlySchemaError(/Invalid (approval choice|command trust)/),
    );
  }

  await assert.rejects(fs.access(path.join(owned.root, 'approval-ran.txt')), { code: 'ENOENT' });
  assert.deepEqual(await owned.service.handle('worker.approve', { ...params, approve: false }), {
    denied: true,
  });
  assert.equal(owned.worker.error, 'Action denied by user.');
});

test('malformed reconciliation, forwarding epochs, and incomplete delivery identity reject before import or run', async (t) => {
  const owned = await fixture(t);
  const envelope = makeEnvelope(owned.worker, [{ type: 'list', path: '.' }]);
  const params = { workerId: owned.worker.id, text: JSON.stringify(envelope) };

  await unchangedRejection(
    owned,
    'worker.import',
    { ...params, reconcile: 'true' },
    friendlySchemaError(/Invalid handoff reconciliation/),
  );

  for (const epoch of ['0', null, -1, 0.5, false]) {
    await unchangedRejection(owned, 'worker.import', { ...params, epoch }, /epoch must be an integer/);
  }

  await owned.service.handle('worker.import', params);
  await unchangedRejection(
    owned,
    'worker.run',
    { workerId: owned.worker.id, envelopeHash: digest('unpaired receipt') },
    /requires its envelope ID and exact hash/,
  );
  await unchangedRejection(owned, 'worker.import', { ...params, reconcile: false }, /already imported/);
});

test('browse and prompt purposes no longer silently substitute defaults for malformed values', async (t) => {
  const owned = await fixture(t);
  let opens = 0;
  t.mock.method(fs, 'open', async () => {
    opens++;
    throw new Error('Malformed request must not read project context.');
  });

  for (const invalid of [null, 12, {}, false]) {
    await unchangedRejection(
      owned,
      'worker.browse',
      { workerId: owned.worker.id, path: invalid },
      friendlySchemaError(/Invalid browse path/),
    );
    await unchangedRejection(
      owned,
      'worker.prompt',
      { workerId: owned.worker.id, kind: invalid },
      friendlySchemaError(/Choose bootstrap, review, fix or next/),
    );
  }

  assert.equal(opens, 0);
  t.mock.restoreAll();
  assert.equal((await owned.service.handle('worker.browse', { workerId: owned.worker.id })).root, owned.root);
  assert.match(
    await owned.service.handle('worker.prompt', { workerId: owned.worker.id }),
    /Work toward the goal/,
  );
});

test('explicit invalid team recipients cannot silently become broadcast messages', async (t) => {
  const owned = await fixture(t);

  for (const to of [null, 0, false, '', {}]) {
    await unchangedRejection(owned, 'worker.teamMessage', {
      workerId: owned.worker.id,
      id: 'team_boundary',
      message: 'Context must not be broadcast.',
      to,
    });
  }

  await owned.service.handle('worker.teamMessage', {
    workerId: owned.worker.id,
    id: 'team_boundary',
    message: 'An intentionally recipient-free message.',
  });
  assert.equal(owned.service.team.messages(owned.project.id).length, 1);
});

test('falsy saved progress is damaged data, not absence, at stop and follow-up activation boundaries', async (t) => {
  const owned = await fixture(t);
  let writes = 0;
  const save = owned.store.saveWorker.bind(owned.store);
  t.mock.method(owned.store, 'saveWorker', (worker) => {
    writes++;
    save(worker);
  });

  for (const value of [null, false, 0, '']) {
    owned.store.set(progressKey(owned.worker.id), value);
    const before = writes;
    await unchangedRejection(
      owned,
      'worker.stop',
      { workerId: owned.worker.id, id: 'damaged_progress_stop' },
      /Saved progress is incompatible. It was not overwritten/,
    );
    await unchangedRejection(
      owned,
      'worker.followupActivate',
      { workerId: owned.worker.id },
      /Saved progress is incompatible; it was not reset/,
    );
    assert.equal(writes, before);
  }
});

test('progress with a different task, project, or goal cannot be summarized, extended, or overwritten', async (t) => {
  const owned = await fixture(t);
  const next = makeProgress(owned.worker);

  for (const changed of [
    { workerId: 'other_worker' },
    { projectId: 'other_project' },
    { goalHash: 'a'.repeat(64) },
  ]) {
    owned.store.set(progressKey(owned.worker.id), { ...next, ...changed });
    assert.deepEqual(owned.service.snapshot().bridgeProgress, []);
    await unchangedRejection(
      owned,
      'worker.bridgeLoad',
      { workerId: owned.worker.id },
      /Saved progress belongs to a different task goal/,
    );
    await unchangedRejection(
      owned,
      'worker.bridgeExtend',
      { workerId: owned.worker.id, confirm: true },
      /No compatible saved progress for this task/,
    );
    await unchangedRejection(
      owned,
      'worker.bridgeSave',
      { workerId: owned.worker.id, progress: next },
      /Saved progress belongs to a different task goal/,
    );
  }
});

test('falsy verification receipts remain quarantined before approval or command side effects, including on retry', async (t) => {
  for (const value of [null, false, 0, '']) {
    await t.test(JSON.stringify(value), async (t) => {
      const owned = await fixture(t);
      const profile = await registerScript(
        owned.service,
        owned.project,
        owned.root,
        "require('node:fs').appendFileSync('verification-ran.txt', 'run');",
      );
      owned.worker.checks = [{ type: 'command', profileId: profile.id }];
      const envelope = await importBatch(owned.service, owned.worker, [
        { type: 'finish', summary: 'Verify.' },
      ]);
      const key = 'verification:' + envelope.id + '_0';
      owned.store.set(key, value);
      owned.worker.autoCommands = true;

      for (let attempt = 0; attempt < 2; attempt++) {
        await runToBoundary(owned.service, owned.worker);
        assert.match(owned.worker.error, /command verification attempt already ran or was interrupted/);
        assert.equal(owned.worker.error.includes('invalid_type'), false);
        assert.equal(owned.worker.pending, undefined);
        assert.equal(owned.store.get(key), value);
        assert.equal(owned.store.get('command:' + envelope.id + '_0_check_0'), undefined);
        await assert.rejects(fs.access(path.join(owned.root, 'verification-ran.txt')), { code: 'ENOENT' });
      }
    });
  }
});

test('invalid control acknowledgements cannot replace steering authority or retire the current plan', async (t) => {
  const owned = await fixture(t);
  await importBatch(owned.service, owned.worker, [{ type: 'list', path: '.' }]);
  const request = { id: 'damaged_control', instruction: 'A new steering instruction.', autoStart: false };

  for (const value of [null, false, 0, '', { signature: 'a'.repeat(64), result: { ready: true } }]) {
    owned.store.set('miter.controlOperation.' + request.id, value);
    await unchangedRejection(
      owned,
      'worker.steer',
      { workerId: owned.worker.id, request },
      friendlySchemaError(/Saved run-control acknowledgement is invalid. It was not overwritten/),
    );
  }
});

test('follow-up persistence rejects malformed records before cache invalidation or indexed-column writes', async (t) => {
  const owned = await fixture(t);
  const followup = await owned.service.handle('worker.followup', {
    workerId: owned.worker.id,
    request: { id: 'retained_followup', instruction: 'Retain the current files.', autoStart: false },
  });
  const summaries = owned.service.followups.summaries(owned.worker.id);
  const before = capture(owned);

  assert.throws(() => owned.service.followups.save({ ...followup, createdAt: 'invalid timestamp' }));
  assert.equal(owned.service.followups.summaries(owned.worker.id), summaries);
  assert.deepEqual(capture(owned), before);
});

test('local proposal staging holds only checked actions and a deferred summary validator', () => {
  for (const summary of [undefined, null, 12, '', 'x'.repeat(4001)]) {
    const raw = { summary, actions: [{ type: 'diff' }] };
    const draft = parseLocalDraft(raw);
    assert.deepEqual(draft.actions, [{ type: 'diff' }]);
    assert.equal('summary' in draft, false);
    raw.summary = 'Later mutation must not replace the original summary.';
    assert.throws(draft.readSummary, /Invalid summary/);
  }

  const literal = '\ufeff  summary\r\n';
  assert.equal(parseLocalProposal({ summary: literal, actions: [{ type: 'diff' }] }).summary, literal);
});

test('a model driver cannot coerce a non-string result into an admitted local proposal', async (t) => {
  let coerced = 0;
  const owned = await fixture(t, {
    workers: [makeWorker({ mode: 'local' })],
    models: {
      async propose() {
        return {
          toString() {
            coerced++;
            return JSON.stringify({
              summary: 'Must not execute.',
              actions: [{ type: 'finish', summary: 'Done.' }],
            });
          },
        };
      },
      close() {},
    },
  });
  owned.service.settings.coderModelPath = '/configured/model.gguf';
  await runToBoundary(owned.service, owned.worker);
  assert.equal(coerced, 0);
  assert.equal(owned.worker.error, 'Local model returned invalid text. No actions were proposed.');
  assert.equal(owned.store.envelopeCount(owned.worker.id), 0);
  assert.deepEqual(owned.worker.queue, []);
  assert.equal(owned.worker.completion, undefined);
});

test('file review verifies both retained content hashes rather than trusting well-formed hash strings', async (t) => {
  const owned = await fixture(t);
  const before = '\ufeffbefore\r\n';
  const after = '\ufeffafter\r\n';
  await fs.writeFile(path.join(owned.root, 'source.txt'), before);
  const envelope = await importBatch(owned.service, owned.worker, [
    { type: 'write', path: 'source.txt', content: after, expectedHash: digest(before) },
  ]);
  await runToBoundary(owned.service, owned.worker);
  const id = envelope.id + '_0';
  const original = owned.store.fileChange(owned.worker.runId, 'source.txt');
  assert.equal(original.before, before);
  assert.equal(original.after, after);

  for (const column of ['before_text', 'after_text']) {
    if (column === 'before_text') {
      owned.store.db.prepare('UPDATE journal SET before_text=? WHERE id=?').run('corrupt before', id);
    } else {
      owned.store.db.prepare('UPDATE journal SET after_text=? WHERE id=?').run('corrupt after', id);
    }

    await unchangedRejection(
      owned,
      'worker.change',
      { workerId: owned.worker.id, path: 'source.txt' },
      /Journal content does not match its recorded file hashes/,
    );
    assert.equal(await fs.readFile(path.join(owned.root, 'source.txt'), 'utf8'), after);
    owned.store.db.prepare('UPDATE journal SET before_text=?,after_text=? WHERE id=?').run(before, after, id);
  }
});

test('database existence checks validate the returned envelope identity rather than truthiness', (t) => {
  const store = memoryStore(t);
  const prepare = store.db.prepare.bind(store.db);
  let row;
  t.mock.method(store.db, 'prepare', (sql) => {
    if (sql === 'SELECT id FROM envelopes WHERE id=?') {
      return { get: () => row };
    }
    return prepare(sql);
  });

  for (const invalid of [null, false, {}, { id: 12 }, { id: 'another_batch' }]) {
    row = invalid;
    assert.throws(() => store.hasEnvelope('batch'));
  }

  row = undefined;
  assert.equal(store.hasEnvelope('batch'), false);
  row = { id: 'batch' };
  assert.equal(store.hasEnvelope('batch'), true);
});

test('terminal startup and helper repair validate configuration before loading or filesystem effects', async (t) => {
  const root = await temporaryDirectory(t);
  let resolutions = 0;
  t.mock.method(fs, 'realpath', async () => {
    resolutions++;
    throw new Error('Invalid options must not resolve a dependency.');
  });

  await assert.rejects(prepareNativeTerminal({ root, repair: 'true' }), (error) => {
    assert.equal(error.code, 'PTY_OPTIONS');
    assert.ok(error.cause instanceof ZodError);
    return true;
  });
  await assert.rejects(
    checkDarwinHelper(root, path.join(root, 'build/Release/pty.node'), {
      arch: process.arch,
      repair: 'false',
    }),
    (error) => {
      assert.equal(error.code, 'PTY_OPTIONS');
      assert.ok(error.cause instanceof ZodError);
      return true;
    },
  );
  assert.equal(resolutions, 0);
  t.mock.restoreAll();
  const state = path.join(root, 'not-created');
  await assert.rejects(openRuntime({ dataDir: state, lock: 'false' }));
  await assert.rejects(fs.access(state), { code: 'ENOENT' });
});

test('folder-picker driver output cannot invoke implicit coercion or reach filesystem resolution', async (t) => {
  let resolutions = 0;
  let coerced = 0;
  t.mock.method(fs, 'realpath', async () => {
    resolutions++;
    throw new Error('Malformed picker output must not reach the filesystem.');
  });

  await assert.rejects(
    pickFolder(
      async () => ({
        toString: () => {
          coerced++;
          return '/unchecked';
        },
      }),
      'darwin',
    ),
    (error) => {
      assert.match(error.message, /folder picker returned an invalid selection/);
      assert.ok(error.cause.cause instanceof ZodError);
      assert.equal(error.message.includes('invalid_type'), false);
      return true;
    },
  );
  assert.equal(resolutions, 0);
  assert.equal(coerced, 0);
  t.mock.restoreAll();
  assert.deepEqual(await pickFolder(async () => '  ', 'darwin'), { cancelled: true });
});
