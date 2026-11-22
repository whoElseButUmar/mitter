import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoot } from 'solid-js';
import { createProjectWorkflows } from '../../src/ui/project-workflows.ts';

const empty = { recording: false, workflows: [] };
const recording = { recording: true, workflows: [] };
const workflow = { id: 'parcel', name: 'Save parcel', verifyAfterRestart: true };

test('project actions use the selected project and surface the actual replay outcome', async (context) => {
  const calls = [];
  const results = [
    empty,
    recording,
    recording,
    { ...empty, workflows: [workflow] },
    {
      ...empty,
      workflows: [{ ...workflow, lastResult: { ok: false, detail: 'Parcel missing after restart.' } }],
    },
    empty,
    recording,
    empty,
  ];
  const draft = createRoot((dispose) => {
    context.after(dispose);
    return createProjectWorkflows('dispatch', async (method, params) => {
      calls.push({ method, params });
      return results.shift();
    });
  });
  for (const kind of ['list', 'record', 'expect']) {
    assert.ok(await draft.run({ kind }));
  }
  assert.equal(draft.state().recording, true);
  assert.ok(await draft.run({ kind: 'save', name: workflow.name, verifyAfterRestart: true }));
  assert.ok(await draft.run({ kind: 'replay', id: workflow.id }));
  assert.deepEqual(draft.state().workflows[0].lastResult, {
    ok: false,
    detail: 'Parcel missing after restart.',
  });
  assert.ok(await draft.run({ kind: 'delete', id: workflow.id }));
  assert.ok(await draft.run({ kind: 'record' }));
  assert.ok(await draft.run({ kind: 'cancel' }));
  assert.deepEqual(draft.state(), empty);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['list', 'record', 'expect', 'save', 'replay', 'delete', 'record', 'cancel'].map(
      (name) => 'workflow.' + name,
    ),
  );
  assert.deepEqual(calls[3].params, { projectId: 'dispatch', name: 'Save parcel', verifyAfterRestart: true });
  assert.deepEqual(calls[4].params, { projectId: 'dispatch', id: 'parcel' });
  assert.ok(calls.every((call) => call.params.projectId === 'dispatch'));
});

test('losing an acknowledgement requires a fresh read and never repeats a mutation', async (context) => {
  const calls = [];
  const results = [recording, { malformed: true }, { ...empty, workflows: [workflow] }];
  const draft = createRoot((dispose) => {
    context.after(dispose);
    return createProjectWorkflows('dispatch', async (method) => {
      calls.push(method);
      return results.shift();
    });
  });
  await draft.run({ kind: 'list' });
  const save = { kind: 'save', name: workflow.name, verifyAfterRestart: true };
  assert.equal(await draft.run(save), false);
  assert.match(draft.error(), /could not read/);
  assert.equal(await draft.run(save), false);
  assert.ok(await draft.run({ kind: 'list' }));
  assert.equal(draft.error(), '');
  assert.equal(draft.state().workflows[0].name, 'Save parcel');
  assert.deepEqual(calls, ['workflow.list', 'workflow.save', 'workflow.list']);
});

test('duplicate clicks and late results from a closed project cannot affect a replacement dialog', async () => {
  const pending = Promise.withResolvers();
  const first = createRoot((dispose) => ({
    dispose,
    ui: createProjectWorkflows('first', async (method) => {
      if (method === 'workflow.list') {
        return empty;
      }
      return pending.promise;
    }),
  }));
  await first.ui.run({ kind: 'list' });
  const start = first.ui.run({ kind: 'record' });
  assert.equal(await first.ui.run({ kind: 'record' }), false);
  first.dispose();
  const second = createRoot((dispose) => ({
    dispose,
    ui: createProjectWorkflows('second', async () => empty),
  }));
  try {
    await second.ui.run({ kind: 'list' });
    pending.resolve(recording);
    assert.equal(await start, false);
    assert.deepEqual(second.ui.state(), empty);
    assert.deepEqual(first.ui.state(), empty);
  } finally {
    second.dispose();
  }
});
