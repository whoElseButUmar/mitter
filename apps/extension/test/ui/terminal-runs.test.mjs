import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoot, createSignal } from 'solid-js';
import { createTerminalRuns, runTabId } from '../../src/ui/terminal-runs.ts';
import { flush } from './fixtures.mjs';

const expectedRun = { runId: 'run', epoch: 2 };

function row(id, state = 'running', projectId = 'project') {
  const previewId = id.repeat(32);
  return {
    projectId,
    workerId: 'worker',
    expectedRun,
    previewId,
    name: 'Cozy Desk',
    startedAt: 1,
    state,
    output: 'App output',
    ...(state === 'running' && {
      url: 'http://miter-' + 'f'.repeat(32) + '.localhost:1234/' + previewId + '/index.html',
    }),
  };
}

function setup(context, rpc) {
  return createRoot((dispose) => {
    context.after(dispose);
    const [projectId, setProject] = createSignal('project');
    const [visible, setVisible] = createSignal(true);
    const runs = createTerminalRuns({ projectId, visible, rpc });
    return { runs, setProject, setVisible };
  });
}

test('reopening lists existing project runs and late results cannot cross a project or hidden drawer', async (context) => {
  const pending = [];
  const { runs, setProject, setVisible } = setup(context, (method, params) => {
    assert.equal(method, 'project.appRuns');
    return new Promise((resolve) => pending.push({ projectId: params.projectId, resolve }));
  });
  await flush();
  setProject('other');
  await flush();
  assert.deepEqual(
    pending.map((r) => r.projectId),
    ['project', 'other'],
  );
  pending[0].resolve({ runs: [row('a')] });
  await flush();
  assert.equal(runs.tabs().size, 0);
  setVisible(false);
  pending[1].resolve({ runs: [row('b', 'running', 'other')] });
  await flush();
  assert.equal(runs.tabs().size, 0);

  setVisible(true);
  await flush();
  pending[2].resolve({ runs: [row('c', 'starting', 'other'), row('b', 'stopped', 'other')] });
  await flush();
  assert.equal(runs.tabs().size, 1);
  assert.equal(runs.tabs().get(runTabId('worker', expectedRun)).previewId, 'c'.repeat(32));
});

test('app controls bind mutations to the selected attempt and never send process output to a shell', async (context) => {
  const running = row('a');
  const stopped = row('b', 'stopped');
  let list = [running];
  const calls = [];
  const { runs } = setup(context, async (method, params) => {
    if (method === 'project.appRuns') {
      return { runs: list };
    }
    calls.push({ method, params });
    if (method === 'worker.previewStop') {
      return { stopped: true };
    }
    return {
      previewId: running.previewId,
      url: running.url,
      files: 1,
      bytes: 4,
      idleTimeoutMs: 1800000,
      detail: 'Ready',
    };
  });
  await flush();
  await runs.control(running, 'restart');
  await runs.control(running, 'stop');
  list = [stopped, row('a', 'stopped')];
  await runs.refresh();
  await runs.control(running, 'restart');
  await runs.control(stopped, 'restart');
  assert.deepEqual(calls, [
    {
      method: 'worker.previewStart',
      params: { workerId: 'worker', expectedRun, mode: 'restart', replacePreviewId: running.previewId },
    },
    {
      method: 'worker.previewStop',
      params: { workerId: 'worker', expectedRun, previewId: running.previewId },
    },
    { method: 'worker.previewStart', params: { workerId: 'worker', expectedRun, mode: 'run' } },
  ]);
});

test('the previous working server remains controllable after its replacement fails', async (context) => {
  const current = row('b', 'failed');
  const previous = row('a');
  const calls = [];
  const { runs } = setup(context, async (method, params) => {
    if (method === 'project.appRuns') {
      return { runs: [current, previous] };
    }
    calls.push(params);
    return { stopped: true };
  });
  await flush();
  assert.equal(runs.tabs().size, 2);
  await runs.control(previous, 'stop');
  assert.deepEqual(calls, [{ workerId: 'worker', expectedRun, previewId: previous.previewId }]);
});

test('Run again follows the returned live server after a failed restart without hiding later attempts', async (context) => {
  const original = row('a');
  const restarted = row('b');
  const failed = row('c', 'failed');
  const laterFailure = row('d', 'failed');
  let list = [original];
  let starts = 0;
  const calls = [];
  const { runs, setVisible } = setup(context, async (method, params) => {
    if (method === 'project.appRuns') {
      return { runs: list };
    }
    assert.equal(method, 'worker.previewStart');
    calls.push(params);
    starts++;
    if (starts === 2) {
      list = [failed, restarted];
      throw new Error('The app entry file is missing.');
    }
    if (starts === 4) {
      list = [laterFailure, restarted];
      throw new Error('The replacement failed again.');
    }
    if (starts === 1) {
      list = [restarted, row('a', 'stopped')];
    }
    return {
      previewId: restarted.previewId,
      url: restarted.url,
      files: 1,
      bytes: 4,
      idleTimeoutMs: 1800000,
      detail: 'Ready',
    };
  });
  const key = runTabId('worker', expectedRun);
  await flush();
  await runs.control(original, 'restart');
  assert.equal(runs.tabs().get(key).previewId, restarted.previewId);
  await runs.control(restarted, 'restart');
  assert.equal(runs.tabs().get(key).previewId, failed.previewId);
  assert.equal(runs.tabs().size, 2);
  assert.match(runs.error(), /entry file is missing/);

  await runs.control(failed, 'restart');
  assert.equal(runs.tabs().get(key).previewId, restarted.previewId);
  assert.equal(runs.tabs().get(key).state, 'running');
  assert.equal(runs.tabs().size, 1);
  assert.equal(runs.error(), '');
  setVisible(false);
  await flush();
  setVisible(true);
  await flush();
  assert.equal(runs.tabs().get(key).previewId, restarted.previewId);
  assert.equal(runs.tabs().size, 1);

  await runs.control(restarted, 'restart');
  assert.equal(runs.tabs().get(key).previewId, laterFailure.previewId);
  assert.equal(runs.tabs().size, 2);
  assert.deepEqual(calls, [
    { workerId: 'worker', expectedRun, mode: 'restart', replacePreviewId: original.previewId },
    { workerId: 'worker', expectedRun, mode: 'restart', replacePreviewId: restarted.previewId },
    { workerId: 'worker', expectedRun, mode: 'run' },
    { workerId: 'worker', expectedRun, mode: 'restart', replacePreviewId: restarted.previewId },
  ]);
});

test('a confirmed app tab follows its stopped or failed server until that record disappears', async (context) => {
  const failed = row('b', 'failed');
  const running = row('a');
  let list = [failed, running];
  const { runs } = setup(context, async (method) => {
    if (method === 'project.appRuns') {
      return { runs: list };
    }
    if (method === 'worker.previewStop') {
      list = [failed, row('a', 'stopped')];
      return { stopped: true };
    }
    return {
      previewId: running.previewId,
      url: running.url,
      files: 1,
      bytes: 4,
      idleTimeoutMs: 1800000,
      detail: 'Ready',
    };
  });
  await flush();
  await runs.control(failed, 'restart');
  assert.equal(runs.tabs().get(runTabId('worker', expectedRun)).previewId, running.previewId);
  await runs.control(running, 'stop');
  assert.equal(runs.tabs().get(runTabId('worker', expectedRun)).previewId, running.previewId);
  assert.equal(runs.tabs().get(runTabId('worker', expectedRun)).state, 'stopped');
  list = [failed, row('a', 'failed')];
  await runs.refresh();
  assert.equal(runs.tabs().get(runTabId('worker', expectedRun)).previewId, running.previewId);
  assert.equal(runs.tabs().get(runTabId('worker', expectedRun)).state, 'failed');
  list = [failed];
  await runs.refresh();
  assert.equal(runs.tabs().get(runTabId('worker', expectedRun)).previewId, failed.previewId);
  assert.equal(runs.tabs().size, 1);
});

test('late Run again completion cannot select a server after its project scope was replaced', async (context) => {
  const failed = row('b', 'failed');
  const running = row('a');
  const pending = Promise.withResolvers();
  const { runs, setProject } = setup(context, async (method, params) => {
    if (method === 'project.appRuns') {
      if (params.projectId === 'other') {
        return { runs: [] };
      }
      return { runs: [failed, running] };
    }
    return pending.promise;
  });
  await flush();
  const starting = runs.control(failed, 'restart');
  await flush();
  setProject('other');
  await flush();
  pending.resolve({
    previewId: running.previewId,
    url: running.url,
    files: 1,
    bytes: 4,
    idleTimeoutMs: 1800000,
    detail: 'Ready',
  });
  await starting;
  assert.equal(runs.tabs().size, 0);
  setProject('project');
  await flush();
  assert.equal(runs.tabs().get(runTabId('worker', expectedRun)).previewId, failed.previewId);
});

test('dock rejects another project’s run list before displaying output or opening a URL', async (context) => {
  const { runs } = setup(context, async () => ({ runs: [row('a', 'running', 'other')] }));
  await flush();
  assert.equal(runs.tabs().size, 0);
  assert.match(runs.error(), /different project/);
});

function trackOpenedTabs(context) {
  const opened = [];
  const previous = globalThis.chrome;
  globalThis.chrome = { tabs: { create: async ({ url }) => opened.push(url) } };
  context.after(() => {
    if (previous) {
      globalThis.chrome = previous;
    } else {
      delete globalThis.chrome;
    }
  });
  return opened;
}

test('Open app checks the exact server again and never opens a stopped or replaced URL', async (context) => {
  const original = row('a');
  const replacement = row('b');
  const opened = trackOpenedTabs(context);

  let runsOnHost = [original];
  const { runs } = setup(context, async (method, params) => {
    assert.equal(method, 'project.appRuns');
    assert.deepEqual(params, { projectId: 'project' });
    return { runs: runsOnHost };
  });
  await flush();
  await runs.control(original, 'open');
  assert.deepEqual(opened, [original.url]);

  // Simulate a restart in a second workspace before the terminal's next poll.
  runsOnHost = [replacement, row('a', 'stopped')];
  await runs.control(original, 'open');
  assert.deepEqual(opened, [original.url]);
  assert.match(runs.error(), /session has ended/);
  await runs.control(replacement, 'open');
  assert.deepEqual(opened, [original.url, replacement.url]);
  assert.equal(runs.error(), '');
});

test('Open app abandons a pending URL lookup after the terminal closes', async (context) => {
  const opened = trackOpenedTabs(context);
  const original = row('a');
  const pending = Promise.withResolvers();
  let confirming = false;
  const { runs, setVisible } = setup(context, async () => {
    if (confirming) {
      return pending.promise;
    }
    return { runs: [original] };
  });
  await flush();
  confirming = true;
  const request = runs.control(original, 'open');
  setVisible(false);
  await flush();
  pending.resolve({ runs: [original] });
  await request;
  assert.deepEqual(opened, []);
  assert.equal(runs.error(), '');
  assert.equal(runs.tabs().size, 0);
});
