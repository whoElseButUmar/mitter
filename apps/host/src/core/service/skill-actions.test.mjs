import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, importBatch, makeWorker, registerScript, runToBoundary } from './test-fixture.mjs';

const { readBundledTaskSkill } = await import('../../../../../packages/protocol/src/task-skills.ts');
const { APP_FOUNDATION_CSS } = await import('../../../../../packages/protocol/src/task-skills/app-design.ts');

function assertFoundationDelivered(prompt) {
  const record = prompt
    .split('\n')
    .find((line) => line.startsWith('{"action":{"type":"skill","name":"app-design"}'));
  assert.ok(record, 'Expected a complete app-design skill observation.');
  const resource = JSON.parse(record).result;
  assert.deepEqual(resource.assets, [{ path: 'foundation.css', content: APP_FOUNDATION_CSS }]);
}

test('a bundled write has one receipt and one journal edit across shorthand and inline deliveries', async (context) => {
  const { service, worker, root, store } = await fixture(context);
  const pathInProject = 'styles/foundation.css';
  const write = { type: 'write', path: pathInProject, base: 'missing' };
  const envelope = await importBatch(service, worker, [{ ...write, asset: 'foundation.css' }]);
  const equivalent = { ...envelope, actions: [{ ...write, content: APP_FOUNDATION_CSS }] };
  const retry = await service.handle('worker.import', {
    workerId: worker.id,
    text: JSON.stringify(equivalent),
    reconcile: true,
  });
  assert.deepEqual(retry, { acknowledged: true, queued: true });
  assert.equal(worker.queue.length, 1);
  assert.deepEqual(worker.queue[0].actions, [
    { type: 'write', path: pathInProject, expectedHash: 'missing', content: APP_FOUNDATION_CSS },
  ]);
  await runToBoundary(service, worker);
  assert.equal(await fs.readFile(path.join(root, pathInProject), 'utf8'), APP_FOUNDATION_CSS);
  assert.equal(store.writes(worker.runId).length, 1);
  await fs.writeFile(path.join(root, pathInProject), 'user styles');
  await importBatch(service, worker, [{ ...write, asset: 'foundation.css' }]);
  await runToBoundary(service, worker);
  assert.equal(await fs.readFile(path.join(root, pathInProject), 'utf8'), 'user styles');
  assert.equal(store.writes(worker.runId).length, 1);
});

test('reading only the component asset does not satisfy the full implementation skill requirement', async (context) => {
  const { service, worker, store } = await fixture(context);
  await importBatch(service, worker, [{ type: 'skill', name: 'app-design', asset: 'components.mjs' }]);
  await runToBoundary(service, worker);
  assert.equal(store.get(`miter.skillRead.${worker.runId}.app-design`), undefined);
  await importBatch(service, worker, [{ type: 'skill', name: 'app-design', asset: 'foundation.css' }]);
  await runToBoundary(service, worker);
  assert.equal(store.get(`miter.skillRead.${worker.runId}.app-design`), true);
});

test('skill actions report exact packaged guidance without reading or modifying project files', async (context) => {
  const { service, worker, project, root, store } = await fixture(context);
  const sentinels = ['app-design', 'foundation.css'];
  for (const filename of sentinels) {
    await fs.writeFile(path.join(root, filename), 'Private project content: ' + filename);
  }
  const originalProject = structuredClone(project);
  const originalSettings = structuredClone(service.settings);
  const originalGoal = worker.goal;
  const originalChecks = structuredClone(worker.checks);
  const originalRun = worker.runId;
  const actions = ['caveman', 'no-ai-slop', 'ponytail', 'app-design', 'engineering-quality'].map((name) => ({
    type: 'skill',
    name,
  }));
  const batch = await importBatch(service, worker, actions);
  await runToBoundary(service, worker);

  assert.equal(worker.state, 'review');
  assert.deepEqual(worker.queue, []);
  assert.equal(worker.pending, undefined);
  assert.equal(worker.approvedFingerprint, undefined);
  assert.equal(worker.autoCommands, false);
  assert.equal(worker.completion, undefined);
  assert.deepEqual(project, originalProject);
  assert.deepEqual(service.settings, originalSettings);
  assert.equal(worker.goal, originalGoal);
  assert.deepEqual(worker.checks, originalChecks);
  assert.equal(worker.runId, originalRun);
  assert.deepEqual(store.writes(worker.runId), []);
  assert.equal(store.get('miter.readSnapshots.v1.' + worker.id), undefined);
  assert.deepEqual(
    worker.observations.map((observation) => JSON.parse(observation)),
    actions.map((action) => ({ action, result: readBundledTaskSkill(action.name) })),
  );
  for (const [index] of actions.entries()) {
    assert.equal(store.get(`command:${batch.id}_${index}`), undefined);
  }
  for (const filename of sentinels) {
    assert.equal(
      await fs.readFile(path.join(root, filename), 'utf8'),
      'Private project content: ' + filename,
    );
  }
  assert.deepEqual((await fs.readdir(root)).sort(), sentinels);

  const report = await service.handle('worker.report', { workerId: worker.id });
  assertFoundationDelivered(report);
  assert.ok(!report.includes('Private project content:'));

  const beforeRejectedEdit = structuredClone(worker);
  await assert.rejects(
    importBatch(service, worker, [
      { type: 'write', path: 'foundation.css', content: 'changed', base: 'r_0123456789abcdef' },
    ]),
    (error) => error.issue?.code === 'BASE_UNAVAILABLE',
  );
  assert.deepEqual(worker, beforeRejectedEdit);
  assert.equal(store.envelopeCount(worker.id), 1);
});

test('invalid skill imports are rejected before admission or task changes', async (context) => {
  const { service, worker, project, root, store } = await fixture(context);
  const before = structuredClone({ worker, project });
  const invalid = [
    { type: 'skill', name: '../private' },
    { type: 'skill', name: 'https://example.com/skill' },
    { type: 'skill', name: 'uninstalled' },
    { type: 'skill', name: 'app-design', path: '../private' },
    { type: 'skill', name: 'app-design', install: true },
    { type: 'skill', name: 'app-design', base: 'missing' },
  ];

  for (const action of invalid) {
    await assert.rejects(importBatch(service, worker, [action]));
    assert.deepEqual({ worker, project }, before);
  }
  assert.equal(store.envelopeCount(worker.id), 0);
  assert.deepEqual(store.events(), []);
  assert.deepEqual(await fs.readdir(root), []);
});

test('reading a skill grants no command approval and Stop still owns the remaining batch', async (context) => {
  const { service, worker, project, root, store } = await fixture(context);
  const profile = await registerScript(
    service,
    project,
    root,
    "require('node:fs').writeFileSync('executed.txt', 'must be approved');",
  );
  const batch = await importBatch(service, worker, [
    { type: 'skill', name: 'engineering-quality' },
    { type: 'command', profileId: profile.id },
    { type: 'skill', name: 'app-design' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'awaiting_approval');
  assert.ok(worker.pending);
  assert.equal(worker.cursor, 1);
  assert.equal(worker.observations.length, 1);
  assert.equal(store.get(`command:${batch.id}_1`), undefined);
  await assert.rejects(fs.access(path.join(root, 'executed.txt')), { code: 'ENOENT' });

  await service.handle('worker.stop', { workerId: worker.id, id: 'stop_skills' });
  assert.equal(worker.control.mode, 'stopped');
  const stopped = structuredClone(worker);
  assert.throws(() => service.run(worker.id), /Task stopped/);
  assert.deepEqual(worker, stopped);
  assert.equal(worker.observations.length, 1);
  assert.equal(store.get(`command:${batch.id}_1`), undefined);
});

test('local inference receives requested skill evidence on its next turn', async (context) => {
  const prompts = [];
  const { service, worker, project, store } = await fixture(context, {
    workers: [makeWorker({ mode: 'local' })],
    models: {
      propose: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return JSON.stringify({
            summary: 'Read the UI guidance.',
            actions: [{ type: 'skill', name: 'app-design' }],
          });
        }
        assertFoundationDelivered(prompt);
        return JSON.stringify({
          summary: 'Guidance inspected.',
          actions: [{ type: 'finish', summary: 'Done.' }],
        });
      },
      close: () => {},
    },
  });
  service.settings.coderModelPath = '/configured/test-model.gguf';
  await runToBoundary(service, worker);
  assert.equal(prompts.length, 2);
  assert.equal(worker.state, 'complete');
  assert.equal(project.revision, 0);
  assert.deepEqual(store.writes(worker.runId), []);
  assert.equal(store.get('miter.readSnapshots.v1.' + worker.id), undefined);
});
