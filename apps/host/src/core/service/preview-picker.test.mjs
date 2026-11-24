import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './test-fixture.mjs';

const element = {
  route: '/',
  viewport: { width: 800, height: 600 },
  selector: '#create',
  role: 'button',
  name: 'Create',
  screenshot: 'data:image/jpeg;base64,/9j/2Q==',
};

async function open(context) {
  const { service, root, worker } = await fixture(context);
  await writeFile(path.join(root, 'index.html'), '<!doctype html><button id="create">Create</button>');
  const boundary = { workerId: worker.id, expectedRun: { runId: worker.runId, epoch: 0 } };
  const { previewId, url } = await service.handle('worker.previewStart', boundary);
  return { service, worker, url, input: { ...boundary, previewId } };
}

test('picker opens only the owned host URL and stores the capture after current-run validation', async (context) => {
  const { service, url, input } = await open(context);
  const driver = context.mock.method(service.previews, 'picker', async (target, signal) => {
    assert.equal(target, url);
    assert.equal(signal.aborted, false);
    return [element];
  });
  for (const extra of [
    { url: 'https://example.com' },
    { previewId: 'a'.repeat(32) },
    { expectedRun: undefined },
  ]) {
    await assert.rejects(service.handle('worker.pickElement', { ...input, ...extra }));
  }
  assert.equal(driver.mock.callCount(), 0);
  const { captureId, elements } = await service.handle('worker.pickElement', input);
  assert.deepEqual(elements, [element]);
  assert.ok(captureId);
  assert.deepEqual(await service.handle('worker.cancelPick', input), { cancelled: false });
});

test('a task changing during selection cannot publish the resulting capture', async (context) => {
  const { service, worker, input } = await open(context);
  const started = Promise.withResolvers();
  const chosen = Promise.withResolvers();
  context.mock.method(service.previews, 'picker', async () => {
    started.resolve();
    return chosen.promise;
  });
  const capture = context.mock.method(service.previewEdits, 'capture');
  const result = assert.rejects(service.handle('worker.pickElement', input), /earlier task run/);
  await started.promise;
  worker.runId = 'replacement';
  chosen.resolve([element]);
  await result;
  assert.equal(capture.mock.callCount(), 0);
});

for (const action of ['worker.cancelPick', 'worker.previewStop', 'worker.stop', 'shutdown']) {
  test(
    action + ' closes the matching picker before acknowledging; late choices are discarded',
    async (context) => {
      const { service, input } = await open(context);
      const started = Promise.withResolvers();
      const chosen = Promise.withResolvers();
      const driver = context.mock.method(service.previews, 'picker', async (_target, signal) => {
        started.resolve(signal);
        return chosen.promise;
      });
      const capture = context.mock.method(service.previewEdits, 'capture');
      const result = assert.rejects(service.handle('worker.pickElement', input), /cancelled|closed|closing/i);
      const signal = await started.promise;
      await assert.rejects(service.handle('worker.pickElement', input), /already open/);
      await assert.rejects(service.handle('worker.cancelPick', { ...input, previewId: 'f'.repeat(32) }));
      assert.equal(signal.aborted, false);
      let cleanup;
      if (action === 'shutdown') {
        cleanup = service.quiesce();
      } else if (action === 'worker.stop') {
        cleanup = service.handle(action, { ...input, id: 'stop_1' });
      } else {
        cleanup = service.handle(action, input);
      }
      assert.equal(signal.aborted, true);
      chosen.resolve([element]);
      await Promise.all([result, cleanup]);
      assert.equal(driver.mock.callCount(), 1);
      assert.equal(capture.mock.callCount(), 0);
    },
  );
}

test('replacing a running app retires its picker before publishing the next preview', async (context) => {
  const { service, input } = await open(context);
  const started = Promise.withResolvers();
  context.mock.method(service.previews, 'picker', async (_target, signal) => {
    started.resolve();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return [element];
  });
  const stale = assert.rejects(service.handle('worker.pickElement', input), /cancelled/);
  await started.promise;
  const boundary = { workerId: input.workerId, expectedRun: input.expectedRun };
  const next = await service.handle('worker.previewStart', boundary);
  assert.notEqual(next.previewId, input.previewId);
  await stale;
  await assert.rejects(service.handle('worker.cancelPick', input), /stopped or changed/);
  assert.equal((await service.handle('worker.previewStatus', boundary)).preview.previewId, next.previewId);
});
