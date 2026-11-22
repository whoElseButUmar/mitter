import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixture, makeWorker } from './test-fixture.mjs';

function image(name) {
  return { id: randomUUID(), name, type: 'image/png', size: 32 };
}

test('task creation persists image metadata and rejects unsupported or duplicate attachments', async (context) => {
  const { service, store, project } = await fixture(context);
  const imageAttachments = [image('dashboard.png'), image('settings.png')];
  const params = {
    projectId: project.id,
    goal: 'Match the attached references.',
    mode: 'handoff',
    imageAttachments,
  };
  const created = await service.handle('worker.create', params);
  assert.deepEqual(created.imageAttachments, imageAttachments);
  assert.deepEqual(
    store.workers().find((worker) => worker.id === created.id)?.imageAttachments,
    imageAttachments,
  );
  assert.deepEqual(
    service.snapshot().workers.find((worker) => worker.id === created.id)?.imageAttachments,
    imageAttachments,
  );

  await assert.rejects(service.handle('worker.create', { ...params, mode: 'local' }), /Choose ChatGPT/);
  await assert.rejects(
    service.handle('worker.create', {
      ...params,
      imageAttachments: [imageAttachments[0], imageAttachments[0]],
    }),
    /only be attached once/,
  );
  await assert.rejects(
    service.handle('worker.create', {
      ...params,
      imageAttachments: [{ ...imageAttachments[0], name: '../dashboard.png' }],
    }),
    /filename/,
  );
  assert.equal(service.snapshot().workers.length, 2);
});

test('follow-up and steering preserve references and reject replays with different images', async (context) => {
  const original = [image('original.png')];
  const { service, store, worker } = await fixture(context, {
    workers: [makeWorker({ imageAttachments: original })],
  });
  const queued = {
    id: 'image_followup',
    instruction: 'Match the new screenshot.',
    imageAttachments: [image('follow-up.png')],
    autoStart: false,
  };
  const saved = await service.handle('worker.followup', { workerId: worker.id, request: queued });
  assert.deepEqual(saved.imageAttachments, queued.imageAttachments);
  assert.deepEqual(await service.handle('worker.followup', { workerId: worker.id, request: queued }), saved);
  await assert.rejects(
    service.handle('worker.followup', {
      workerId: worker.id,
      request: { ...queued, imageAttachments: [image('different.png')] },
    }),
    /different work/,
  );
  assert.equal(service.snapshot().workers[0].activeFollowupImages, undefined);
  assert.equal((await service.handle('worker.followupActivate', { workerId: worker.id })).activated, true);
  assert.deepEqual(service.snapshot().workers[0].activeFollowupImages, queued.imageAttachments);
  assert.deepEqual(store.workers()[0].activeFollowupImages, queued.imageAttachments);
  assert.deepEqual(service.snapshot().workers[0].imageAttachments, original);

  const steer = { ...queued, id: 'image_steer', imageAttachments: [image('steer.png')] };
  const result = await service.handle('worker.steer', { workerId: worker.id, request: steer });
  assert.equal(result.ready, true);
  assert.deepEqual(service.snapshot().workers[0].activeFollowupImages, steer.imageAttachments);
  await assert.rejects(
    service.handle('worker.steerValidate', {
      workerId: worker.id,
      request: { ...steer, imageAttachments: [image('different.png')] },
    }),
    /another request/,
  );

  await service.handle('worker.steer', {
    workerId: worker.id,
    request: { id: 'text_steer', instruction: 'Adjust the spacing.' },
  });
  assert.equal(service.snapshot().workers[0].activeFollowupImages, undefined);
  assert.deepEqual(service.snapshot().workers[0].imageAttachments, original);
});

test('local workers reject follow-up attachments before saving or stopping work', async (context) => {
  const { service, worker } = await fixture(context, { workers: [makeWorker({ mode: 'local' })] });
  const params = {
    workerId: worker.id,
    request: {
      id: 'local_image',
      instruction: 'Match the reference.',
      imageAttachments: [image('reference.png')],
    },
  };
  for (const method of ['worker.followup', 'worker.steerValidate', 'worker.steer']) {
    await assert.rejects(service.handle(method, params), /Image attachments require a ChatGPT task/);
  }
  assert.deepEqual(await service.handle('worker.followups', { workerId: worker.id }), []);
  assert.equal(worker.control, undefined);
});
