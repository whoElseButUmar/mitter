import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletedPreviews } from '../../src/background/completed-previews.ts';

const worker = { id: 'worker', runId: 'run-1', state: 'verifying' };
const completed = {
  ...worker,
  state: 'complete',
  completion: {
    verification: 'passed',
    evidence: { devServer: 'vite', devServerFingerprint: 'a'.repeat(64) },
  },
};
const mark = (task) => ({ workers: [task] });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('opens the verified framework preview only on a new completion and skips old tasks on reconnect', async () => {
  const calls = [];
  const tabs = [];
  const preview = new CompletedPreviews(
    async (method, params) => {
      calls.push({ method, params });
      return { framework: 'vite', url: 'http://local-preview' };
    },
    () => false,
    async (url) => tabs.push(url),
    () => assert.fail('Unexpected error'),
  );
  preview.update(mark(completed));
  assert.equal(calls.length, 0);
  preview.update(mark({ ...worker, runId: 'new' }));
  preview.update(mark({ ...completed, runId: 'new' }));
  preview.update(mark({ ...completed, runId: 'new' }));
  await flush();
  assert.deepEqual(calls, [
    {
      method: 'worker.previewStart',
      params: { workerId: 'worker', expectedRun: { runId: 'new', epoch: 0 }, mode: 'verified' },
    },
  ]);
  assert.deepEqual(tabs, ['http://local-preview']);
  preview.clear();
  preview.update(mark({ ...completed, runId: 'new' }));
  await flush();
  assert.equal(tabs.length, 1);
});

test('static completions do not auto-open and a superseded framework run may never open a late browser tab', async () => {
  let resolve;
  const result = new Promise((done) => {
    resolve = done;
  });
  let count = 0;
  const preview = new CompletedPreviews(
    async () => {
      count++;
      return result;
    },
    () => false,
    async () => assert.fail('Unexpected tab'),
    () => assert.fail('Unexpected error'),
  );
  preview.update(mark(worker));
  preview.update(
    mark({ ...completed, completion: { verification: 'passed', evidence: { browser: 'passed' } } }),
  );
  assert.equal(count, 0);
  preview.update(mark({ ...worker, runId: 'new' }));
  preview.update(mark({ ...completed, runId: 'new' }));
  assert.equal(count, 1);
  preview.update(mark({ ...worker, runId: 'replacement' }));
  resolve({ framework: 'vite', url: 'http://local-preview' });
  await flush();
});

test('a locally started run can complete in the first host broadcast and only its reviewed boundary gets a tab', async () => {
  const tabs = [];
  const failed = [];
  const preview = new CompletedPreviews(
    async (_method, params) => ({ framework: 'vite', url: 'http://preview/' + params.workerId }),
    () => false,
    async (url) => tabs.push(url),
    (...args) => failed.push(args),
  );
  preview.arm(worker);
  preview.arm({ ...worker, id: 'other', control: { epoch: 4 } });
  const data = {
    workers: [
      completed,
      { ...completed, id: 'other', control: { epoch: 5 } },
      { ...completed, id: 'history' },
    ],
  };
  preview.update(data);
  await flush();
  assert.deepEqual(tabs, ['http://preview/worker']);
  preview.update(data);
  preview.arm(completed);
  preview.update(data);
  await flush();
  assert.equal(tabs.length, 1);
  assert.equal(failed.length, 0);
});

test('a refused tab open retains the successful host result and reports a retry on the exact task run', async () => {
  const failures = [];
  const preview = new CompletedPreviews(
    async () => ({ framework: 'vite', url: 'http://localhost/' }),
    () => false,
    async () => {
      throw new Error('Chrome refused a new tab');
    },
    (...args) => failures.push(args),
  );
  preview.arm(worker);
  preview.update(mark(completed));
  await flush();
  assert.equal(failures.length, 1);
  assert.equal(failures[0][0], worker.id);
  assert.deepEqual(failures[0][1], { runId: worker.runId, epoch: 0 });
  assert.match(failures[0][2], /Choose Run.*Chrome refused/);
  preview.update(mark(completed));
  await flush();
  assert.equal(failures.length, 1);
});
