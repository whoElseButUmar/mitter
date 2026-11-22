import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { fixture } from './test-fixture.mjs';
import { ProjectWorkflows } from '../workflows/service.ts';

const steps = [
  { type: 'fill', selector: '#label', value: 'Studio postcard' },
  { type: 'expect', selector: '#label', value: 'Studio postcard' },
];

function recorder() {
  const closed = Promise.withResolvers();
  let armed = false;
  return {
    closed: closed.promise,
    async finish() {
      if (!armed) {
        throw Error('Choose a final result to check.');
      }
      return steps;
    },
    async close() {
      closed.resolve();
    },
    async expect() {
      armed = true;
    },
  };
}

test('workflow RPCs retain validated steps only in host storage and scope all actions to their project', async (context) => {
  const { service, project, store, root } = await fixture(context);
  const input = { projectId: project.id };
  const state = { recording: false, workflows: [] };
  assert.deepEqual(await service.handle('workflow.list', input), state);
  await assert.rejects(service.handle('workflow.list', { projectId: 'missing' }), /project not found/i);
  await assert.rejects(service.handle('workflow.record', { ...input, steps }));
  const launch = context.mock.method(service.projectWorkflows.runtime, 'beginRecording', async () =>
    recorder(),
  );
  const started = await Promise.all([1, 2].map(() => service.handle('workflow.record', input)));
  assert.equal(launch.mock.callCount(), 1);
  assert.deepEqual(
    started,
    [1, 2].map(() => ({ ...state, recording: true })),
  );
  const save = { ...input, name: 'Create a card', verifyAfterRestart: true };
  await assert.rejects(service.handle('workflow.save', save), /final result/);
  await service.handle('workflow.expect', input);
  const put = context.mock.method(store, 'set', () => {
    throw Error('disk full');
  });
  await assert.rejects(service.handle('workflow.save', save), /disk full/);
  assert.equal((await service.handle('workflow.list', input)).recording, true);
  put.mock.restore();
  const result = await service.handle('workflow.save', save);
  const [{ id }] = result.workflows;
  assert.deepEqual(result, {
    recording: false,
    workflows: [{ id, name: save.name, verifyAfterRestart: true }],
  });
  assert.deepEqual(await service.handle('workflow.save', save), result);
  assert.deepEqual(new ProjectWorkflows(store).list(project.id), result);
  assert.deepEqual(await readdir(root), []);
  const replayed = { ok: true, detail: 'Passed after restart.' };
  const replay = context.mock.method(
    service.projectWorkflows.runtime,
    'replayWorkflow',
    async (from, captured, restart) => {
      assert.equal(from, root);
      assert.deepEqual(captured, steps);
      assert.equal(restart, true);
      return replayed;
    },
  );
  const receipt = await service.handle('workflow.replay', { ...input, id });
  assert.deepEqual(receipt.workflows[0].lastResult, replayed);
  assert.equal(replay.mock.callCount(), 1);
  await assert.rejects(service.handle('workflow.replay', { ...input, id: 'other' }), /not found/);
  assert.deepEqual(await service.handle('workflow.delete', { ...input, id }), state);
  assert.deepEqual(await service.handle('workflow.delete', { ...input, id }), state);
});

test('shutdown aborts an opening recorder and closes the browser even if creation completes late', async (context) => {
  const { service, project } = await fixture(context);
  const opened = Promise.withResolvers();
  const started = Promise.withResolvers();
  const session = recorder();
  const close = context.mock.method(session, 'close');
  context.mock.method(service.projectWorkflows.runtime, 'beginRecording', async (_root, signal) => {
    started.resolve(signal);
    await opened.promise;
    return session;
  });
  const recording = assert.rejects(service.handle('workflow.record', { projectId: project.id }), /cancelled/);
  const signal = await started.promise;
  const closing = service.quiesce();
  assert.equal(signal.aborted, true);
  opened.resolve();
  await Promise.all([recording, closing]);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(service.projectWorkflows.list(project.id).recording, false);
});

test('closing a recording window releases the project for another session', async (context) => {
  const { service, project } = await fixture(context);
  const handles = [recorder(), recorder()];
  let count = 0;
  context.mock.method(service.projectWorkflows.runtime, 'beginRecording', async () => handles[count++]);
  const input = { projectId: project.id };
  await service.handle('workflow.record', input);
  await handles[0].close();
  assert.equal((await service.handle('workflow.list', input)).recording, false);
  assert.equal((await service.handle('workflow.record', input)).recording, true);
  const result = await service.handle('workflow.cancel', input);
  assert.equal(result.recording, false);
  assert.deepEqual(result.workflows, []);
});

test('overlapping replays run once and cancellation preserves the prior result while other projects stay usable', async (context) => {
  const { service, store, project } = await fixture(context);
  const id = 'journey_1';
  const lastResult = { ok: true, detail: 'Previously passed.' };
  store.set('workflows:' + project.id, [
    { id, name: 'Add a card', verifyAfterRestart: false, lastResult, steps },
  ]);
  const neighbor = { ...project, id: 'project_2' };
  service.projects.set(neighbor.id, neighbor);
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const run = context.mock.method(
    service.projectWorkflows.runtime,
    'replayWorkflow',
    async (_root, _steps, _restart, signal) => {
      started.resolve(signal);
      await finish.promise;
      return { ok: false, detail: 'Late result.' };
    },
  );
  const input = { projectId: project.id, id };
  const requests = [1, 2].map(() => assert.rejects(service.handle('workflow.replay', input), /cancelled/));
  const signal = await started.promise;
  assert.equal(run.mock.callCount(), 1);
  await assert.rejects(service.handle('workflow.delete', input), /already in progress/);
  await assert.rejects(service.handle('workflow.replay', { id, projectId: neighbor.id }), /not found/);
  assert.deepEqual(await service.handle('workflow.list', { projectId: neighbor.id }), {
    recording: false,
    workflows: [],
  });
  const cancelled = service.handle('workflow.cancel', { projectId: project.id });
  assert.equal(signal.aborted, true);
  finish.resolve();
  await Promise.all(requests);
  assert.deepEqual((await cancelled).workflows[0].lastResult, lastResult);
});
