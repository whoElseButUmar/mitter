import assert from 'node:assert/strict';
import './test-source-loader.mjs';

const { PageBridgeError } = await import('../page-transport.ts');
const { NativeRequestTimeout } = await import('../native-request.ts');
const { BridgeRunner } = await import(process.env.BRIDGE_RUNNER_MODULE || '../index.ts');

export function createHarness(configuration = {}) {
  let time = 100000;
  let outgoingText = '';
  let savedProgress = configuration.progress;
  let view = {
    url: 'https://chatgpt.com/c/task-1',
    count: 0,
    userCount: 0,
    lastRole: '',
    assistantId: '',
    assistantText: '',
    lastUserText: '',
    busy: false,
    complete: false,
    draft: false,
    draftText: '',
    stopped: false,
    ready: true,
    ...configuration.view,
  };
  const events = [];
  const publishedStatuses = [];
  const commits = [];
  const imports = [];
  const worker = {
    id: 'worker_1',
    projectId: 'project_1',
    name: 'Test task',
    goal: 'Inspect safely.',
    mode: 'handoff',
    state: 'idle',
    queue: [],
    checks: [],
    cursor: 0,
    runId: 'run_1',
    iteration: 0,
    maxIterations: 10,
    maxMinutes: 10,
    startedAt: time,
    autoCommands: false,
    observations: [],
    repeatCount: 0,
    createdAt: time,
    ...configuration.worker,
  };
  const options = {
    workerId: worker.id,
    projectId: worker.projectId,
    tabId: 12,
    url: view.url,
    maxTurns: 5,
    maxMinutes: 10,
    token: 'test-token',
    ...configuration.options,
  };
  const snapshot = () => ({
    protocol: 'mitter/1',
    projects: [],
    workers: [worker],
    events: [],
    settings: { coderModelPath: '', contextSize: 4096, maxTokens: 1024, gpu: 'cpu' },
    runtime: { node: 'ready', workflow: 'ready', models: 'ready' },
  });
  const dependencies = {
    now: () => time,
    snapshot,
    publish: (status) => {
      publishedStatuses.push(structuredClone(status));
    },
    log: () => {},
    loadProgress: async () => ({
      progress: savedProgress || null,
      importedCount: 0,
    }),
    saveProgress: async (progress) => {
      events.push('save:' + progress.stage);
      if (configuration.beforeSave) {
        await configuration.beforeSave(progress);
      }
      if (configuration.failProgressStage === progress.stage) {
        throw Error('Storage unavailable');
      }
      savedProgress = structuredClone({
        ...progress,
        revision: progress.revision + 1,
      });
      return structuredClone(savedProgress);
    },
    saveReceipt: async () => {
      events.push('receipt');
      if (configuration.failReceipt) {
        throw Error('Browser storage unavailable');
      }
    },
    rpc: async (method, params) => {
      events.push(method);
      if (method === 'worker.prompt') {
        if (params.kind === 'bootstrap') {
          return 'BOOTSTRAP';
        }
        return 'NEXT';
      }
      if (method === 'worker.report') {
        return 'No successful changes yet.';
      }
      if (method === 'worker.handoffSeen') {
        return { seen: configuration.alreadyImported === true };
      }
      if (method === 'worker.validateReply') {
        return { valid: true };
      }
      if (method === 'state') {
        return snapshot();
      }
      if (method === 'worker.import') {
        imports.push(params);
        if (configuration.importTimeout) {
          if (imports.length === 1) {
            throw new NativeRequestTimeout(method);
          }
          return { queued: true, acknowledged: true };
        }
        return { queued: true };
      }
      if (method === 'worker.run' || method === 'worker.resume') {
        worker.state = 'executing';
        return { started: true };
      }
      if (method === 'worker.pause') {
        return { stopping: false };
      }
      throw new Error('Unexpected native fixture method: ' + method);
    },
    page: async (tabId, request) => {
      assert.equal(tabId, 12);
      events.push('page:' + request.op);
      if (request.op === 'inspect' && configuration.readError) {
        throw new PageBridgeError('BRIDGE_TIMEOUT', 'Reader unavailable.', true);
      }
      if (request.op === 'prepare') {
        outgoingText = request.text;
        let composerSession;
        if (!configuration.legacyComposer) {
          composerSession = 'document_1';
        }
        return {
          ...view,
          outcome: configuration.prepareOutcome ?? 'prepared',
          renderedDraftText: outgoingText,
          composerSession,
        };
      }
      if (request.op === 'commit') {
        commits.push(request);
        if (configuration.commitError && commits.length === 1) {
          throw configuration.commitError;
        }
        view = {
          ...view,
          count: 1,
          userCount: 1,
          lastRole: 'user',
          lastUserText: outgoingText,
          lastUserId: 'sent_user',
          userIds: ['sent_user'],
        };
        return { ...view, outcome: 'clicked' };
      }
      return structuredClone(view);
    },
  };
  const runner = new BridgeRunner(options, dependencies);
  return {
    runner,
    options,
    dependencies,
    events,
    publishedStatuses,
    commits,
    imports,
    worker,
    configuration,
    advance: (milliseconds) => {
      time += milliseconds;
    },
    now: () => time,
    progress: () => savedProgress,
    setView: (changes) => {
      view = { ...view, ...changes };
    },
    showReply: (changes = {}) => {
      const envelope = {
        protocol: 'mitter/1',
        id: 'reply_1',
        replyTo: options.lastReceipt.exchangeId,
        workerId: worker.id,
        projectId: worker.projectId,
        summary: 'Inspect files',
        actions: [{ type: 'list', path: '.' }],
        ...changes,
      };
      view = {
        ...view,
        count: 2,
        lastRole: 'assistant',
        assistantId: envelope.id,
        assistantText: JSON.stringify(envelope),
        assistantFormat: 'code',
        complete: true,
      };
      return envelope;
    },
  };
}

export function replaceRpcResult(harness, method, result, kind) {
  const rpc = harness.dependencies.rpc;
  harness.dependencies.rpc = async (requestedMethod, params) => {
    if (requestedMethod === method && (kind === undefined || params.kind === kind)) {
      harness.events.push(method);
      return result;
    }
    return rpc(requestedMethod, params);
  };
}
