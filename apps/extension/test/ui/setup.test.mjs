import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoot, createSignal } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { readinessSchema } from '../../../../packages/protocol/src/rpc.ts';
import { connectionHelp } from '../../src/ui/connection-help.ts';
import { createReadiness } from '../../src/ui/readiness.ts';
import { ConnectionGuide } from '../../src/views/ConnectionGuide.tsx';
import { ReadinessDetails } from '../../src/views/SetupPanel.tsx';
import { createTaskAppRun } from '../../src/ui/task-app-run.ts';
import { assetChunk, flush, worker } from './fixtures.mjs';

const available = readinessSchema.parse({
  version: 1,
  node: 'v26.5.1',
  platform: 'darwin',
  architecture: 'arm64',
  webChecks: { status: 'ready', detail: 'Required web-app checks are available.' },
  checks: {
    source: { status: 'ready', detail: 'Source checks are available.' },
    domain: { status: 'ready', detail: 'Isolated domain tests are available.' },
    browser: {
      status: 'ready',
      detail: 'Chrome is available for automatic browser journeys and Lighthouse.',
    },
  },
  notice: 'Requirements checked. Tests have not run.',
});

test('setup distinguishes missing registration, mismatched version and transient connection loss', () => {
  assert.equal(connectionHelp('Specified native messaging host not found.').action, 'install');
  assert.equal(connectionHelp('Access to the native messaging host was forbidden.').action, 'install');
  assert.equal(
    connectionHelp('Reload Miter after setup to connect the matching local host.').action,
    'reload',
  );
  assert.equal(connectionHelp('Native host has exited.').action, 'retry');
  const background = connectionHelp('Miter’s background did not answer the workspace check.');
  assert.equal(background.title, 'Reconnect the extension');
  assert.equal(background.action, 'retry');
  assert.doesNotMatch(background.detail, /install|local helper/i);
  assert.equal(connectionHelp('').title, 'Connecting to Miter');
  assert.equal(connectionHelp('').action, 'wait');
  assert.equal(connectionHelp('Specified native messaging host not found.').label, 'Check connection');
});

test('setup renders a usable repair action and keeps raw diagnostics in a disclosure', () => {
  const html = renderToString(() =>
    ConnectionGuide({
      error: 'Specified native messaging host not found.',
      reconnect() {},
      reload() {},
    }),
  );
  assert.match(html, /Install the local helper/);
  assert.match(html, /Install Miter.command/);
  assert.match(html, /Copy setup command/);
  assert.match(html, /<summary>[\s\S]*?Connection details<\/summary>/);
  assert.doesNotMatch(html, /disabled/);
  assert.ok(html.indexOf('Open Install Miter.command') < html.indexOf('Check connection'));
});

test('connecting keeps manual recovery available in setup help without a competing primary action', () => {
  const html = renderToString(() => ConnectionGuide({ error: '', reconnect() {}, reload() {} }));
  assert.match(html, /Connecting to Miter/);
  assert.doesNotMatch(html, /class="primary"/);
  assert.match(html, /<details class="setup-disclosure">[\s\S]*?Reconnect/);
});

test('ready requirements never claim that a browser test passed', () => {
  const html = renderToString(() => ReadinessDetails({ report: available }));
  assert.match(html, /Chrome is available for automatic browser journeys and Lighthouse/);
  assert.match(html, /Tests have not run/);
  assert.doesNotMatch(html, /All tests passed|Browser verified|Production ready/i);
});

test('a disconnected setup does not send readiness RPCs', async () => {
  let calls = 0;
  const owner = createRoot((dispose) => ({
    dispose,
    model: createReadiness(
      () => false,
      async () => {
        calls++;
        return available;
      },
    ),
  }));
  await flush();
  await owner.model.refresh();
  assert.equal(calls, 0);
  assert.equal(owner.model.report(), undefined);
  owner.dispose();
});

test('disconnect and replacement readiness reads retire old results and errors', async () => {
  const requests = [];
  const owner = createRoot((dispose) => {
    const [connected, setConnected] = createSignal(true);
    const model = createReadiness(connected, async (method) => {
      assert.equal(method, 'system.readiness');
      const pending = Promise.withResolvers();
      requests.push(pending);
      return pending.promise;
    });
    return { dispose, model, setConnected };
  });
  await flush();
  assert.equal(requests.length, 1);
  owner.setConnected(false);
  await flush();
  requests[0].resolve(available);
  await flush();
  assert.equal(owner.model.report(), undefined);
  owner.setConnected(true);
  await flush();
  const replacement = owner.model.refresh();
  assert.equal(requests.length, 3);
  requests[1].reject(new Error('Stale failure'));
  requests[2].resolve(available);
  await replacement;
  await flush();
  assert.deepEqual(owner.model.report(), available);
  assert.equal(owner.model.error(), '');
  owner.dispose();
});

test('malformed readiness is visible and disposal prevents a late response from publishing', async () => {
  let response = Promise.resolve({ ready: true });
  const owner = createRoot((dispose) => ({
    dispose,
    model: createReadiness(
      () => true,
      () => response,
    ),
  }));
  await flush();
  assert.ok(owner.model.error());
  assert.equal(owner.model.report(), undefined);
  const pending = Promise.withResolvers();
  response = pending.promise;
  const checking = owner.model.refresh();
  owner.dispose();
  pending.resolve(available);
  await checking;
  assert.equal(owner.model.report(), undefined);
});

const previewResult = {
  previewId: 'a'.repeat(32),
  url: 'http://miter-' + 'b'.repeat(32) + '.localhost:45678/' + 'a'.repeat(32) + '/index.html',
  files: 3,
  bytes: 1000,
  idleTimeoutMs: 1800000,
  detail: 'Temporary local preview. Browser tests have not run.',
};

test('a completed task can open an unchanged app entry while CLI-only tasks have no preview', async () => {
  const reads = [];
  const completion = {
    version: 1,
    verification: 'passed',
    summary: 'Verified',
    checked: 2,
    at: 1,
    evidence: { source: 'not-run', domain: 'passed', browser: 'not-run', detail: 'Domain tests passed.' },
  };
  const owner = createRoot((dispose) => {
    const [task, setTask] = createSignal(worker({ state: 'complete', completion }));
    const [connected, setConnected] = createSignal(false);
    const model = createTaskAppRun({
      task,
      connected,
      rpc: async (method, params) => {
        assert.equal(method, 'worker.asset');
        assert.deepEqual(params, { workerId: task().id, path: 'index.html', length: 1 });
        const pending = Promise.withResolvers();
        reads.push(pending);
        return pending.promise;
      },
      showTerminal: () => {},
    });
    return { dispose, model, setTask, setConnected };
  });
  await flush();
  assert.equal(reads.length, 0);
  owner.setConnected(true);
  await flush();
  owner.setTask(worker({ id: 'cli', state: 'complete', completion }));
  await flush();
  reads[0].resolve(assetChunk('index.html', '<', 'text/html'));
  reads[1].reject(new Error('No such file'));
  await flush();
  assert.equal(owner.model.available(), false);
  owner.setTask(worker({ id: 'legacy', state: 'complete' }));
  await flush();
  reads[2].resolve(assetChunk('index.html', '<', 'text/html'));
  await flush();
  assert.equal(owner.model.available(), true);
  owner.setTask(
    worker({
      id: 'verified',
      state: 'complete',
      completion: {
        ...completion,
        evidence: { ...completion.evidence, browser: 'passed' },
      },
    }),
  );
  await flush();
  assert.equal(owner.model.available(), true);
  assert.equal(reads.length, 3);
  owner.setTask(worker({ id: 'verified', state: 'executing' }));
  await flush();
  assert.equal(owner.model.available(), false);
  owner.dispose();
});

function completedApp(overrides = {}) {
  return worker({
    state: 'complete',
    completion: {
      version: 1,
      verification: 'passed',
      summary: 'Verified',
      checked: 1,
      at: 1,
      evidence: { source: 'passed', domain: 'passed', browser: 'passed', detail: 'Browser checks passed.' },
    },
    ...overrides,
  });
}

test('Run opens the terminal immediately and admits one managed start for the displayed task', async () => {
  const pending = Promise.withResolvers();
  const calls = [];
  const owner = createRoot((dispose) => {
    const [task, setTask] = createSignal(completedApp());
    const model = createTaskAppRun({
      task,
      connected: () => true,
      showTerminal: (current) => calls.push(['terminal', current.id]),
      rpc: async (method, params) => {
        calls.push([method, params]);
        return pending.promise;
      },
    });
    return { dispose, task, model, setTask };
  });
  await flush();
  const request = owner.model.start();
  await owner.model.start();
  assert.deepEqual(calls, [
    ['terminal', owner.task().id],
    [
      'worker.previewStart',
      {
        workerId: owner.task().id,
        expectedRun: { runId: owner.task().runId, epoch: 0 },
        mode: 'run',
      },
    ],
  ]);
  owner.setTask((task) => ({ ...task, observations: ['updated snapshot'] }));
  await flush();
  assert.equal(owner.model.busy(), true);
  pending.resolve(previewResult);
  await request;
  assert.equal(owner.model.busy(), false);
  owner.dispose();
});

test('unready tasks, pending approval and a disconnected helper do not start an app', async () => {
  const calls = [];
  const owner = createRoot((dispose) => {
    const [task, setTask] = createSignal(completedApp({ state: 'verifying' }));
    const [connected, setConnected] = createSignal(true);
    const model = createTaskAppRun({
      task,
      connected,
      showTerminal: () => calls.push('terminal'),
      rpc: async (method) => {
        calls.push(method);
        return previewResult;
      },
    });
    return { dispose, model, setTask, setConnected };
  });
  await flush();
  assert.equal(owner.model.available(), false);
  await owner.model.start();
  owner.setTask(
    completedApp({
      pending: {
        token: 'approval',
        fingerprint: 'check',
        revision: 1,
        reason: 'Review command',
        action: { type: 'command', profileId: 'test' },
      },
    }),
  );
  await flush();
  assert.equal(owner.model.available(), false);
  await owner.model.start();
  owner.setConnected(false);
  owner.setTask(completedApp());
  await flush();
  await owner.model.start();
  assert.deepEqual(calls, []);
  owner.dispose();
});

for (const change of ['task', 'run', 'dispose']) {
  test(
    'navigating to another ' + change + ' during startup leaves the managed server in its terminal',
    async () => {
      const pending = Promise.withResolvers();
      const calls = [];
      const owner = createRoot((dispose) => {
        const [task, setTask] = createSignal(completedApp());
        const model = createTaskAppRun({
          task,
          connected: () => true,
          showTerminal: (current) => calls.push(current.id),
          rpc: async (method) => {
            calls.push(method);
            return pending.promise;
          },
        });
        return { dispose, model, setTask, task };
      });
      await flush();
      const id = owner.task().id;
      const start = owner.model.start();
      if (change === 'dispose') {
        owner.dispose();
      } else if (change === 'task') {
        owner.setTask(completedApp({ id: 'new-task' }));
      } else {
        owner.setTask(completedApp({ runId: 'new-run' }));
      }
      await flush();
      pending.resolve(previewResult);
      await start;
      assert.deepEqual(calls, [id, 'worker.previewStart']);
      if (change !== 'dispose') {
        owner.dispose();
      }
    },
  );
}

test('a rejected startup reports the failure to the pending terminal tab and the task', async () => {
  const terminalErrors = [];
  const owner = createRoot((dispose) => ({
    dispose,
    model: createTaskAppRun({
      task: () => completedApp(),
      connected: () => true,
      showTerminal: () => (message) => terminalErrors.push(message),
      rpc: async () => ({ ...previewResult, url: 'https://example.com/' }),
    }),
  }));
  await flush();
  await owner.model.start();
  assert.ok(owner.model.error());
  assert.deepEqual(terminalErrors, [owner.model.error()]);
  assert.equal(owner.model.busy(), false);
  owner.dispose();
});

test('automatic tab errors belong to one task and clear after Run attaches', async () => {
  const task = completedApp();
  task.completion.evidence.devServer = 'vite';
  let update;
  let cleared = false;
  const owner = createRoot((dispose) => ({
    dispose,
    model: createTaskAppRun({
      task: () => task,
      connected: () => true,
      showTerminal: () => {},
      rpc: async () => previewResult,
      failures: {
        async read() {
          return 'Could not open the app automatically.';
        },
        subscribe(id, boundary, fn) {
          assert.equal(id, task.id);
          assert.equal(boundary.runId, task.runId);
          update = fn;
          return () => {
            update = undefined;
          };
        },
        async clear() {
          cleared = true;
        },
      },
    }),
  }));
  await flush();
  assert.equal(owner.model.error(), 'Could not open the app automatically.');
  update('Choose Run to retry in Terminal.');
  assert.equal(owner.model.error(), 'Choose Run to retry in Terminal.');
  await owner.model.start();
  assert.equal(cleared, true);
  assert.equal(owner.model.error(), '');
  owner.dispose();
  assert.equal(update, undefined);
});
