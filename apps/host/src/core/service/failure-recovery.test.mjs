import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  digest,
  fixture,
  importBatch,
  makeEnvelope,
  makeProgress,
  makeWorker,
  registerScript,
  runToBoundary,
} from './test-fixture.mjs';

const { commandJournalSchema, retiredQueueSchema } = await import('./schemas.ts');
const { referenceWorkflow } = await import('../workflow.ts');
const { loadXStateWorkflow } = await import('../../adapters/xstate.ts');
const { progressKey } = await import('../../../../../packages/bridge/src/progress.ts');
const { recoverDrainedHandoff } = await import('./state-migration.ts');

async function approveCurrent(service, worker, trustRun = false) {
  assert.ok(worker.pending);
  await service.handle('worker.approve', {
    workerId: worker.id,
    token: worker.pending.token,
    approve: true,
    trustRun,
  });
  await service.wait(worker.id);
}

test('a failed command returns evidence for a fresh approved repair and archives every stale batch', async (context) => {
  const { service, worker, project, root, store } = await fixture(context);
  await fs.writeFile(path.join(root, 'answer.txt'), 'wrong');
  const profile = await registerScript(
    service,
    project,
    root,
    "const fs = require('node:fs'); fs.appendFileSync('runs.txt', 'run\\n'); " +
      "if (fs.readFileSync('answer.txt', 'utf8') !== 'fixed') { console.error('Expected fixed answer'); process.exit(7); }",
  );
  const first = await importBatch(service, worker, [
    { type: 'write', path: 'kept.txt', content: 'already applied', expectedHash: 'missing' },
    { type: 'command', profileId: profile.id },
    { type: 'write', path: 'stale.txt', content: 'must not run', expectedHash: 'missing' },
  ]);
  const later = await importBatch(service, worker, [
    { type: 'write', path: 'later.txt', content: 'also stale', expectedHash: 'missing' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'awaiting_approval');
  await approveCurrent(service, worker, true);
  assert.equal(worker.state, 'review');
  assert.match(worker.error, /Expected fixed answer/);
  assert.equal(worker.runId, 'run_1');
  assert.deepEqual(worker.queue, []);
  assert.equal(worker.pending, undefined);
  assert.equal(worker.approvedFingerprint, undefined);
  assert.equal(worker.autoCommands, false);
  assert.equal(worker.completion, undefined);
  assert.equal(await fs.readFile(path.join(root, 'kept.txt'), 'utf8'), 'already applied');
  for (const name of ['stale.txt', 'later.txt']) {
    await assert.rejects(fs.access(path.join(root, name)), { code: 'ENOENT' });
  }
  const retired = retiredQueueSchema.parse(
    store.get(`miter.retiredQueue.failure.${worker.runId}.${first.id}`),
  );
  assert.equal(retired.cursor, 2);
  assert.deepEqual(retired.queue, [first, later]);
  const report = await service.handle('worker.report', { workerId: worker.id });
  assert.match(report, /Expected fixed answer/);
  assert.match(report, /"code":7/);
  assert.match(report, /The queued remainder was discarded/);
  await assert.rejects(
    service.handle('worker.import', { workerId: worker.id, text: JSON.stringify(first) }),
    /already imported/,
  );

  const repaired = await importBatch(service, worker, [
    { type: 'write', path: 'answer.txt', content: 'fixed', expectedHash: digest('wrong') },
    { type: 'command', profileId: profile.id },
    { type: 'finish', summary: 'Fixed and tested.' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'awaiting_approval');
  assert.equal(await fs.readFile(path.join(root, 'runs.txt'), 'utf8'), 'run\n');
  await approveCurrent(service, worker);
  assert.equal(worker.state, 'complete');
  assert.equal(await fs.readFile(path.join(root, 'runs.txt'), 'utf8'), 'run\nrun\n');
  const oldResult = commandJournalSchema.parse(store.get(`command:${first.id}_1`));
  const newResult = commandJournalSchema.parse(store.get(`command:${repaired.id}_1`));
  assert.equal(oldResult.result.code, 7);
  assert.equal(newResult.result.code, 0);
});

test('failed completion checks return to review and a new finish runs fresh approved checks', async (context) => {
  const { service, worker, project, root, store } = await fixture(context);
  const profile = await registerScript(
    service,
    project,
    root,
    "const fs = require('node:fs'); fs.appendFileSync('checks.txt', 'check\\n'); " +
      "if (!fs.existsSync('fixed.txt')) { console.error('Missing fixed file'); process.exit(3); }",
  );
  worker.checks = [
    { type: 'command', profileId: profile.id },
    { type: 'exists', path: 'fixed.txt' },
    { type: 'contains', path: 'fixed.txt', text: 'ready' },
  ];
  const first = await importBatch(service, worker, [{ type: 'finish', summary: 'Premature finish.' }]);
  await runToBoundary(service, worker);
  await approveCurrent(service, worker, true);
  assert.equal(worker.state, 'review');
  assert.equal(worker.completion, undefined);
  assert.equal(worker.humanAcceptanceReady, false);
  assert.deepEqual(worker.queue, []);
  assert.equal(worker.autoCommands, false);
  assert.match(worker.error, /Missing fixed file/);
  assert.match(worker.error, /Missing required file fixed\.txt/);
  const failed = worker.observations.map((value) => JSON.parse(value)).find((value) => value.results);
  assert.equal(failed.ok, false);
  assert.equal(failed.verification, 'failed');
  assert.deepEqual(
    failed.results.map((result) => result.ok),
    [false, false, false],
  );
  assert.match(await service.handle('worker.report', { workerId: worker.id }), /Missing fixed file/);

  await importBatch(service, worker, [
    { type: 'write', path: 'fixed.txt', content: 'ready', expectedHash: 'missing' },
    { type: 'finish', summary: 'Fresh checks passed.' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'awaiting_approval');
  assert.equal(await fs.readFile(path.join(root, 'checks.txt'), 'utf8'), 'check\n');
  await approveCurrent(service, worker);
  assert.equal(worker.state, 'complete');
  assert.equal(worker.completion.verification, 'passed');
  assert.equal(await fs.readFile(path.join(root, 'checks.txt'), 'utf8'), 'check\ncheck\n');

  worker.state = 'paused';
  worker.completion = undefined;
  worker.queue = [first];
  worker.cursor = 0;
  store.saveWorker(worker);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'blocked');
  assert.match(worker.error, /Cached test output is not fresh verification/);
  assert.equal(await fs.readFile(path.join(root, 'checks.txt'), 'utf8'), 'check\ncheck\n');
});

test('a false file check permits repair while confinement errors still block', async (context) => {
  const { service, worker, root } = await fixture(context);
  await fs.writeFile(path.join(root, 'answer.txt'), 'wrong');
  worker.checks = [{ type: 'contains', path: 'answer.txt', text: 'fixed' }];
  await importBatch(service, worker, [{ type: 'finish', summary: 'Check answer.' }]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.equal(worker.completion, undefined);

  await fs.symlink(path.dirname(root), path.join(root, 'outside'));
  worker.checks = [{ type: 'exists', path: 'outside' }];
  const unsafe = await importBatch(service, worker, [{ type: 'finish', summary: 'Unsafe check.' }]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'blocked');
  assert.equal(worker.queue[0].id, unsafe.id);
  assert.match(worker.error, /Symbolic links are not allowed/);
});

test('missing project files return a creation base and the remaining reads continue', async (context) => {
  const { service, worker, root } = await fixture(context);
  await fs.writeFile(path.join(root, 'index.html'), '<title>Gym</title>');
  await importBatch(service, worker, [
    { type: 'read', path: 'vite.config.js' },
    { type: 'read', path: 'src/config/theme.js' },
    { type: 'read', path: 'index.html' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.equal(worker.error, undefined);
  assert.deepEqual(worker.queue, []);
  const results = worker.observations.map((entry) => JSON.parse(entry)).filter((entry) => entry.result);
  for (const filename of ['vite.config.js', 'src/config/theme.js']) {
    const { result } = results.find((entry) => entry.action.path === filename);
    assert.equal(result.exists, false);
    assert.equal(result.base, 'missing');
    assert.match(result.message, /create it/);
  }
  assert.ok(results.some(({ result }) => result.content === '<title>Gym</title>' && result.readComplete));

  await importBatch(service, worker, [
    { type: 'write', path: 'vite.config.js', content: 'export default {}', base: 'missing' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(await fs.readFile(path.join(root, 'vite.config.js'), 'utf8'), 'export default {}');

  await fs.mkdir(path.join(root, 'src/config'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/config/theme.js'), 'user change');
  await importBatch(service, worker, [
    { type: 'write', path: 'src/config/theme.js', content: 'overwrite', base: 'missing' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.match(worker.observations.join('\n'), /editRepair/);
  assert.equal(await fs.readFile(path.join(root, 'src/config/theme.js'), 'utf8'), 'user change');
});

test('listing a missing project directory returns an empty observation and the same batch can create its first file', async (context) => {
  const { service, worker, root } = await fixture(context);
  await fs.mkdir(path.join(root, 'assets'));
  await importBatch(service, worker, [
    { type: 'list', path: 'public' },
    { type: 'list', path: 'assets/icons/scalable' },
    { type: 'list', path: 'assets' },
    { type: 'write', path: 'public/robots.txt', content: 'User-agent: *\nDisallow:\n', base: 'missing' },
    { type: 'list', path: 'public' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.equal(worker.error, undefined);
  const listings = worker.observations
    .map((entry) => JSON.parse(entry))
    .filter((entry) => entry.action?.type === 'list');
  assert.deepEqual(
    listings.map(({ result }) => result),
    [
      { exists: false, files: [], limit: 300 },
      { exists: false, files: [], limit: 300 },
      { files: [], limit: 300 },
      { files: ['public/robots.txt'], limit: 300 },
    ],
  );
});

test('a missing project root, invalid directory or symlink parent still blocks reads and listings', async (context) => {
  for (const type of ['read', 'list']) {
    for (const target of ['missing project', 'file parent', 'symlink parent']) {
      await context.test(type + ' ' + target, async (subtest) => {
        const { service, worker, root } = await fixture(subtest);
        const batch = await importBatch(service, worker, [{ type, path: 'src/absent' }]);
        if (target === 'missing project') {
          await fs.rename(root, root + '-moved');
        } else if (target === 'file parent') {
          await fs.writeFile(path.join(root, 'src'), 'ordinary file');
        } else {
          await fs.symlink(path.dirname(root), path.join(root, 'src'));
        }
        await runToBoundary(service, worker);
        assert.equal(worker.state, 'blocked');
        assert.equal(worker.queue[0].id, batch.id);
        assert.doesNotMatch(worker.observations.join('\n'), /"exists":false/);
      });
    }
  }
});

test(
  'an unreadable project file cannot supply a missing base',
  {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async (context) => {
    const { service, worker, root } = await fixture(context);
    const file = path.join(root, 'unreadable.js');
    await fs.writeFile(file, 'private source', { mode: 0o000 });
    await importBatch(service, worker, [{ type: 'read', path: 'unreadable.js' }]);
    await runToBoundary(service, worker);
    assert.equal(worker.state, 'blocked');
    assert.match(worker.error, /EACCES|permission denied/i);
    assert.doesNotMatch(worker.observations.join('\n'), /"exists":false/);
  },
);

test(
  'listing an unreadable directory never reports an empty directory',
  {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async (context) => {
    const { service, worker, root } = await fixture(context);
    const folder = path.join(root, 'private');
    await fs.mkdir(folder, { mode: 0o000 });
    try {
      await importBatch(service, worker, [{ type: 'list', path: 'private' }]);
      await runToBoundary(service, worker);
      assert.equal(worker.state, 'blocked');
      assert.match(worker.error, /EACCES|permission denied/i);
      assert.doesNotMatch(worker.observations.join('\n'), /"exists":false/);
    } finally {
      await fs.chmod(folder, 0o700);
    }
  },
);

test('a directory read suggests list and lets the rest of the batch finish', async (context) => {
  const { service, worker, root } = await fixture(context);
  const folder = 'src/assets';
  await fs.mkdir(path.join(root, folder), { recursive: true });
  await fs.writeFile(path.join(root, folder, 'logo.svg'), '<svg/>');
  await fs.writeFile(path.join(root, folder, '.env'), 'hidden');
  await importBatch(service, worker, [
    { type: 'read', path: folder },
    { type: 'read', path: folder + '/logo.svg' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.deepEqual(worker.queue, []);
  const results = worker.observations.map((entry) => JSON.parse(entry).result);
  const directory = results.find((result) => result?.next?.type === 'list');
  assert.deepEqual(directory, {
    error: 'This path is a directory. Use list to inspect its files.',
    next: { type: 'list', path: folder },
  });
  assert.ok(results.some((result) => result?.content === '<svg/>' && result.base));
  assert.match(await service.handle('worker.report', { workerId: worker.id }), /Use list to inspect/);

  await importBatch(service, worker, [directory.next]);
  await runToBoundary(service, worker);
  const listed = worker.observations.map((entry) => JSON.parse(entry)).find((entry) => entry.result?.files);
  assert.deepEqual(listed.result.files, ['src/assets/logo.svg']);
  await fs.symlink(path.join(root, folder), path.join(root, 'linked-assets'));
  await importBatch(service, worker, [{ type: 'read', path: 'linked-assets' }]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'blocked');
  assert.match(worker.error, /Symbolic links are not allowed/);
});

test('timed out commands and completion checks remain quarantined instead of requesting repair', async (context) => {
  for (const kind of ['command', 'finish']) {
    await context.test(kind, async (child) => {
      const { service, worker, project, root, store } = await fixture(child);
      const profile = await registerScript(service, project, root, 'setTimeout(() => {}, 5000);');
      await service.handle('project.profile', {
        projectId: project.id,
        profile: { ...profile, timeoutMs: 1000 },
      });
      let action = { type: 'command', profileId: profile.id };
      let suffix = '_0';

      if (kind === 'finish') {
        worker.checks = [{ type: 'command', profileId: profile.id }];
        action = { type: 'finish', summary: 'Must not recover an interrupted check.' };
        suffix = '_0_check_0';
      }

      const batch = await importBatch(service, worker, [action]);
      await runToBoundary(service, worker);
      await approveCurrent(service, worker);
      assert.equal(worker.state, 'blocked');
      assert.match(worker.error, /timed out/);
      assert.equal(worker.queue[0].id, batch.id);
      assert.equal(worker.cursor, 0);
      const journal = commandJournalSchema.parse(store.get(`command:${batch.id}${suffix}`));
      assert.equal(journal.status, 'interrupted');
      assert.equal(journal.result.timedOut, true);
      assert.equal(store.get(`miter.retiredQueue.failure.${worker.runId}.${batch.id}`), undefined);
    });
  }
});

test('pause after command-result publication wins over automatic failure review', async (context) => {
  const { service, worker, project, root, store } = await fixture(context);
  const profile = await registerScript(
    service,
    project,
    root,
    "require('node:fs').appendFileSync('runs.txt', 'run\\n'); process.exit(7);",
  );
  const first = await importBatch(service, worker, [
    { type: 'command', profileId: profile.id },
    { type: 'write', path: 'stale.txt', content: 'must not run', expectedHash: 'missing' },
  ]);
  await runToBoundary(service, worker);
  const save = store.saveWorker.bind(store);
  let paused = false;
  let pausing;
  store.saveWorker = (saved) => {
    save(saved);
    if (!paused && saved.observations.some((value) => JSON.parse(value).result?.code === 7)) {
      paused = true;
      pausing = service.handle('worker.pause', { workerId: worker.id });
    }
  };
  await approveCurrent(service, worker);
  await pausing;
  assert.equal(worker.state, 'paused');
  assert.equal(worker.queue[0].id, first.id);
  assert.equal(worker.cursor, 0);
  assert.equal(store.get(`miter.retiredQueue.failure.${worker.runId}.${first.id}`), undefined);
  await service.handle('worker.resume', { workerId: worker.id });
  await service.wait(worker.id);
  assert.equal(worker.state, 'review');
  assert.equal(await fs.readFile(path.join(root, 'runs.txt'), 'utf8'), 'run\n');
  await assert.rejects(fs.access(path.join(root, 'stale.txt')), { code: 'ENOENT' });
});

test('a legacy consumed failed batch drains on Resume without replaying its command', async (context) => {
  for (const [name, workflowFactory] of [
    ['reference', referenceWorkflow],
    ['XState', await loadXStateWorkflow()],
  ]) {
    await context.test(name, async (child) => {
      const result = { code: 7, stdout: 'One test failed.', stderr: '', timedOut: false, aborted: false };
      const action = { type: 'command', profileId: 'old-test' };
      const saved = makeWorker({
        state: 'paused',
        cursor: 1,
        error: 'Command failed. Remaining actions were stopped. Export the report before importing a fix.',
        observations: [JSON.stringify({ action, result })],
      });
      const first = makeEnvelope(saved, [action]);
      saved.queue = [first];
      const finished = { status: 'finished', workerId: saved.id, result };
      const { service, worker, store } = await fixture(child, {
        workers: [saved],
        workflowFactory,
        beforeOpen: (database) => database.set(`command:${first.id}_0`, finished),
      });

      await service.handle('worker.resume', {
        workerId: worker.id,
        expectedRun: { runId: saved.runId, epoch: 0 },
      });
      await service.wait(worker.id);
      assert.equal(worker.state, 'review');
      assert.deepEqual(worker.queue, []);
      assert.equal(worker.cursor, 0);
      assert.equal(worker.error, undefined);
      assert.equal(worker.runId, saved.runId);
      assert.deepEqual(store.get(`command:${first.id}_0`), finished);
      assert.deepEqual(worker.observations, saved.observations);
      assert.match(await service.handle('worker.report', { workerId: worker.id }), /One test failed/);
    });
  }
});

test('startup recovers the already-drained transition failure to non-running review', async (context) => {
  for (const [name, workflowFactory] of [
    ['reference', referenceWorkflow],
    ['XState', await loadXStateWorkflow()],
  ]) {
    for (const state of ['paused', 'blocked']) {
      await context.test(name + ' ' + state, async (child) => {
        const saved = makeWorker({
          state,
          error: 'Invalid transition queued → review.',
          autoCommands: true,
          approvedFingerprint: 'a'.repeat(64),
          observations: [JSON.stringify({ result: { code: 7, stdout: 'One test failed.' } })],
        });
        const progress = makeProgress(saved, { stage: 'local_batch', lastImportedId: 'consumed-reply' });
        const { service, worker, store } = await fixture(child, {
          workers: [saved],
          workflowFactory,
          beforeOpen: (database) => database.set(progressKey(saved.id), progress),
        });
        await service.wait(worker.id);
        assert.equal(worker.state, 'review');
        assert.equal(worker.error, undefined);
        assert.equal(worker.runId, saved.runId);
        assert.equal(worker.autoCommands, false);
        assert.equal(worker.approvedFingerprint, undefined);
        assert.equal(worker.completion, undefined);
        assert.deepEqual(worker.queue, []);
        assert.deepEqual(worker.observations, saved.observations);
        assert.deepEqual(store.get(progressKey(worker.id)), progress);
        assert.equal(store.events().filter((event) => event.kind === 'recovery').length, 1);
        assert.match(store.events()[0].message, /no actions were rerun/);
        assert.match(await service.handle('worker.report', { workerId: worker.id }), /One test failed/);
        assert.deepEqual(await service.handle('worker.pause', { workerId: worker.id }), {
          stopping: false,
          review: true,
        });
        assert.equal(
          store.events().some((event) => event.kind === 'action'),
          false,
        );
      });
    }
  }
});

test('drained-handoff migration cannot clear unrelated errors, pending work, approval, or Stop', () => {
  const saved = makeWorker({ state: 'paused', error: 'Invalid transition queued → review.' });
  const blockedCases = [
    { mode: 'local' },
    { state: 'awaiting_approval' },
    { state: 'cancelled' },
    { error: 'Command timed out.' },
    { cursor: 1 },
    { queue: [makeEnvelope(saved, [{ type: 'list', path: '.' }])] },
    { pending: { token: 'pending' } },
    { completion: { version: 1, verification: 'passed', summary: 'Complete.', checked: 1, at: 1 } },
    { humanAcceptanceReady: true },
    { control: { version: 1, epoch: 2, mode: 'stopped', at: 1, operationId: 'stop', retiredExchanges: [] } },
  ];

  for (const change of blockedCases) {
    const worker = { ...saved, ...change };
    assert.equal(recoverDrainedHandoff(worker), worker);
  }
});
