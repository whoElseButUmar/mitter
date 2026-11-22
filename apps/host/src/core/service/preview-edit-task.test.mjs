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

test('a reviewed element creates one edit task in its source folder and keeps image bytes out of the prompt and snapshot', async (t) => {
  const { service, worker, project, store } = await fixture(t);
  worker.worktree = { root: project.root, branch: 'task/source', baseCommit: '1'.repeat(40) };
  const { captureId } = service.previewEdits.capture(worker, selection);
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
  assert.deepEqual(await service.handle('worker.previewSelection', { workerId: edit.id }), selection);
  assert.equal(store.workers().find((row) => row.id === edit.id).hasPreviewSelection, true);
  const prompt = await service.handle('worker.prompt', { workerId: edit.id });
  assert.match(prompt, /Move to Done/);
  assert.doesNotMatch(prompt, /data:image/);
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /data:image/);
  await assert.rejects(service.handle('worker.create', request), /Choose the element again/);
});

test('starting a new source run retires the selection and a different project cannot consume it', async (t) => {
  const { service, worker, project } = await fixture(t);
  const { captureId } = service.previewEdits.capture(worker, selection);
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
