import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoot } from 'solid-js';
import { createAutomationFormRequests } from '../../src/AutomationForm.tsx';
import { createWorkerFormRequests, startCreatedTask } from '../../src/forms/WorkerForm.tsx';
import { admittedChat, control, flush, worker } from './fixtures.mjs';

const reviewed = { workerId: 'worker_a', expectedRun: { runId: 'reviewed_run', epoch: 3 } };
const startOptions = { consent: true, newChat: true, maxTurns: 15, maxMinutes: 30 };

async function formOwner(kind, rpc, target = reviewed, mode = 'handoff') {
  const events = [];
  const task = worker({
    id: target.workerId,
    runId: target.expectedRun.runId,
    control: { ...control('active'), epoch: target.expectedRun.epoch },
    mode,
  });
  const owner = createRoot((dispose) => {
    const close = () => events.push('closed');
    if (kind === 'automation') {
      const requests = createAutomationFormRequests({
        ...target,
        rpc,
        close,
        started: () => events.push('started'),
      });
      return {
        dispose,
        prepare: async () => {},
        start: () => requests.start(startOptions),
        stop: requests.stop,
        close: requests.close,
      };
    }
    const requests = createWorkerFormRequests({
      rpc,
      create: async () => task,
      start: (workerId, source, expectedRun) => startCreatedTask(rpc, workerId, source, expectedRun),
      stop: (workerId) => rpc('bridge.halt', { workerId, id: 'local_cleanup' }),
      close,
      failed: () => events.push('failed'),
    });
    return {
      dispose,
      prepare: () => requests.create({ projectId: task.projectId }),
      start: () => requests.start(task.id, mode),
      stop: () => requests.stop(task.id, mode),
      close: requests.close,
    };
  });
  await owner.prepare();
  return { ...owner, events };
}

for (const kind of ['automation', 'worker']) {
  for (const replacementRun of ['reviewed_run', 'replacement_run']) {
    test(kind + ' late cleanup retains its admission across replacement run ' + replacementRun, async () => {
      const calls = [];
      const starts = [];
      const rpc = (method, params) => {
        calls.push({ method, params });
        if (method === 'bridge.start') {
          const pending = Promise.withResolvers();
          starts.push(pending);
          return pending.promise;
        }
        assert.equal(method, 'bridge.stopStarted', 'cleanup must never fall back to worker-only Stop');
        return Promise.resolve({ stopped: false });
      };
      const owner = await formOwner(kind, rpc);
      let replacement;
      try {
        const originalStart = owner.start();
        await flush();
        owner.dispose();
        assert.deepEqual(await owner.stop(), { stopped: false });
        assert.equal(calls.length, 1, 'pre-ack disposal has no cleanup authority');

        const target = { workerId: reviewed.workerId, expectedRun: { runId: replacementRun, epoch: 3 } };
        replacement = await formOwner(kind, rpc, target);
        const replacementStart = replacement.start();
        await flush();
        starts[1].resolve(admittedChat(target.workerId, 'replacement_admission', target.expectedRun));
        await replacementStart;
        starts[0].resolve(admittedChat(reviewed.workerId, 'original_admission', reviewed.expectedRun));
        await originalStart;
        assert.deepEqual(await owner.stop(), { stopped: false });
        assert.deepEqual(calls[2], {
          method: 'bridge.stopStarted',
          params: { ...reviewed, admissionId: 'original_admission' },
        });
        assert.deepEqual(await owner.stop(), { stopped: false });
        assert.equal(calls.length, 3, 'the consumed receipt cannot be replayed');
        owner.close();
        assert.deepEqual(owner.events, []);
        assert.deepEqual(replacement.events, []);
        await replacement.stop();
        assert.deepEqual(calls[3], {
          method: 'bridge.stopStarted',
          params: { ...target, admissionId: 'replacement_admission' },
        });
      } finally {
        owner.dispose();
        replacement?.dispose();
      }
    });
  }

  for (const acknowledgement of ['lost', 'missing identity', 'invalid admission', 'invalid epoch']) {
    test(
      kind + ' disposal with ' + acknowledgement + ' acknowledgement sends no cleanup or retry',
      async () => {
        const pending = Promise.withResolvers();
        const calls = [];
        const owner = await formOwner(kind, (method, params) => {
          calls.push({ method, params });
          return pending.promise;
        });
        try {
          const starting = owner.start();
          let expectedFailure = /could not read the response to bridge.start.*not retried/;
          if (acknowledgement === 'lost') {
            expectedFailure = /Start acknowledgement lost/;
          }
          const rejected = assert.rejects(starting, expectedFailure);
          await flush();
          owner.dispose();
          assert.deepEqual(await owner.stop(), { stopped: false });
          if (acknowledgement === 'lost') {
            pending.reject(new Error('Start acknowledgement lost.'));
          } else {
            const result = admittedChat();
            if (acknowledgement === 'missing identity') {
              const { admissionId, expectedRun, ...status } = result;
              assert.ok(admissionId);
              assert.ok(expectedRun);
              pending.resolve(status);
            } else if (acknowledgement === 'invalid admission') {
              pending.resolve({ ...result, admissionId: '' });
            } else {
              pending.resolve({ ...result, expectedRun: { runId: 'reviewed_run', epoch: -1 } });
            }
          }
          await rejected;
          assert.deepEqual(await owner.stop(), { stopped: false });
          owner.close();
          assert.deepEqual(owner.events, [], 'late failure cannot close or report into another dialog');
          assert.deepEqual(
            calls.map((call) => call.method),
            ['bridge.start'],
          );
        } finally {
          owner.dispose();
        }
      },
    );
  }

  test(kind + ' cleanup acknowledgement failure consumes the receipt without retrying', async () => {
    const calls = [];
    const owner = await formOwner(kind, async (method, params) => {
      calls.push({ method, params });
      if (method === 'bridge.start') {
        return admittedChat();
      }
      assert.equal(method, 'bridge.stopStarted');
      throw new Error('Cleanup acknowledgement lost.');
    });
    try {
      await owner.start();
      owner.dispose();
      await assert.rejects(owner.stop(), /Cleanup acknowledgement lost/);
      assert.deepEqual(await owner.stop(), { stopped: false });
      assert.deepEqual(
        calls.map((call) => call.method),
        ['bridge.start', 'bridge.stopStarted'],
      );
    } finally {
      owner.dispose();
    }
  });

  test(kind + ' successful normal close does not clean up its admitted running chat', async () => {
    const calls = [];
    const owner = await formOwner(kind, async (method, params) => {
      calls.push({ method, params });
      return admittedChat();
    });
    try {
      await owner.start();
      owner.close();
      owner.dispose();
      assert.deepEqual(owner.events, ['closed']);
      assert.deepEqual(
        calls.map((call) => call.method),
        ['bridge.start'],
      );
    } finally {
      owner.dispose();
    }
  });
}

test('new-task local cleanup retains its existing halt callback instead of chat admission cleanup', async () => {
  const calls = [];
  const owner = await formOwner(
    'worker',
    async (method, params) => {
      calls.push({ method, params });
      return { started: true };
    },
    reviewed,
    'local',
  );
  try {
    await owner.start();
    owner.dispose();
    await owner.stop();
    assert.deepEqual(calls, [
      { method: 'worker.run', params: reviewed },
      { method: 'bridge.halt', params: { workerId: 'worker_a', id: 'local_cleanup' } },
    ]);
  } finally {
    owner.dispose();
  }
});
