import assert from 'node:assert/strict';
import test from 'node:test';
import { openRuntime } from '../src/runtime.js';
import { projectSchema, workerSchema } from '../../../packages/protocol/src/index.js';
import { temporaryDirectory } from './fixtures.mjs';

for (const phase of ['quiesce', 'close']) {
  test('public run refuses admission after ' + phase + ' without altering the saved task', async (t) => {
    const directory = await temporaryDirectory(t);
    const projectRoot = await temporaryDirectory(t);
    const runtime = await openRuntime({ portable: true, dataDir: directory });
    t.after(() => runtime.close());
    const service = runtime.service;
    const project = projectSchema.parse(
      await service.handle('project.add', {
        root: projectRoot,
        name: 'Admission regression',
      }),
    );
    const worker = workerSchema.parse(
      await service.handle('worker.create', {
        projectId: project.id,
        name: 'Must remain idle',
        goal: 'No local work may start after shutdown.',
        mode: 'local',
      }),
    );

    if (phase === 'quiesce') {
      await service.quiesce();
    } else {
      await runtime.close();
    }
    const before = structuredClone([...service.workers.values()]);

    try {
      assert.throws(() => service.run(worker.id), /Host is shutting down/);
      assert.deepEqual([...service.workers.values()], before);

      if (phase === 'quiesce') {
        assert.deepEqual(service.store.workers(), before);
      }
    } finally {
      await service.wait(worker.id);
    }
  });
}
