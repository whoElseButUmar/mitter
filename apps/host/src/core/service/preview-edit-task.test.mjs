import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './test-fixture.mjs';

const selection = {
  route: '/board',
  viewport: { width: 900, height: 720 },
  role: 'button',
  name: 'Move to Done',
  selector: '#move',
  screenshot: 'data:image/jpeg;base64,/9j/2Q==',
};

test('reviewed captures create one edit task in order and keep image bytes out of the prompt and snapshot', async (t) => {
  const { service, worker, project, store } = await fixture(t);
  worker.worktree = { root: project.root, branch: 'task/source', baseCommit: '1'.repeat(40) };
  const elements = [selection, { ...selection, name: 'Done list', selector: '#done', role: 'list' }];
  const { captureId } = service.previewEdits.capture(worker, elements);
  const request = {
    projectId: project.id,
    goal: 'Make this action easier to find.',
    mode: 'handoff',
    captureId,
  };
  await assert.rejects(
    service.handle('worker.create', { ...request, workspaceMode: 'worktree' }),
    /same folder/,
  );
  const edit = await service.handle('worker.create', request);
  assert.equal(edit.goal, request.goal);
  assert.deepEqual(edit.worktree, worker.worktree);
  assert.deepEqual(await service.handle('worker.previewSelection', { workerId: edit.id }), elements);
  assert.equal(store.workers().find((row) => row.id === edit.id).hasPreviewSelection, true);
  const prompt = await service.handle('worker.prompt', { workerId: edit.id });
  assert.match(prompt, /Move to Done/);
  assert.match(prompt, /Done list/);
  assert.doesNotMatch(prompt, /data:image/);
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /data:image/);
  await assert.rejects(service.handle('worker.create', request), /Choose the elements again/);

  store.set('miter.previewSelection.' + edit.id, selection);
  assert.deepEqual(await service.handle('worker.previewSelection', { workerId: edit.id }), [selection]);
});

test('starting a new source run retires the selection and a different project cannot consume it', async (t) => {
  const { service, worker, project } = await fixture(t);
  const { captureId } = service.previewEdits.capture(worker, [selection]);
  const other = { ...worker, id: 'other-worker', projectId: 'elsewhere' };
  assert.throws(() => service.previewEdits.create(captureId, other, service.workers), /this project/);
  worker.runId = 'new-run';
  await assert.rejects(
    service.handle('worker.create', {
      projectId: project.id,
      goal: 'Rename this button.',
      mode: 'local',
      captureId,
    }),
    /source task changed/,
  );
});
