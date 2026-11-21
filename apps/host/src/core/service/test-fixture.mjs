import '../../../../../packages/bridge/src/runner/test-source-loader.mjs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Store } = await import('../database.ts');
const { Service } = await import('../service.ts');
const { digest } = await import('../workspace.ts');
const { referenceWorkflow } = await import('../workflow.ts');
const { parseProposalEnvelope } = await import('../../../../../packages/protocol/src/proposal.ts');

export { digest };

export function makeWorker(overrides = {}) {
  return {
    id: 'worker_1',
    projectId: 'project_1',
    name: 'Task',
    goal: 'Keep the current implementation.',
    checks: [],
    mode: 'handoff',
    state: 'idle',
    queue: [],
    cursor: 0,
    runId: 'run_1',
    iteration: 0,
    maxIterations: 8,
    maxMinutes: 15,
    startedAt: 0,
    autoCommands: false,
    observations: [],
    repeatCount: 0,
    createdAt: 1,
    ...overrides,
  };
}

export function makeProgress(worker, overrides = {}) {
  return {
    version: 1,
    revision: 0,
    workerId: worker.id,
    projectId: worker.projectId,
    goalHash: digest(
      worker.goal
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .trim(),
    ),
    turns: 2,
    maxTurns: 5,
    lowerBound: false,
    activeMs: 200,
    maxMinutes: 10,
    startedAt: 10,
    updatedAt: 100,
    stage: 'report_due',
    repeats: 0,
    formatRepairs: 0,
    phase: 'stopped',
    reason: 'Ready to continue.',
    ...overrides,
  };
}

export function makeEnvelope(worker, actions, overrides = {}) {
  return {
    protocol: 'mitter/1',
    id: randomUUID(),
    workerId: worker.id,
    projectId: worker.projectId,
    summary: 'Inspect and preserve current work.',
    actions,
    ...overrides,
  };
}

export function envelopeHash(envelope) {
  return digest(JSON.stringify(parseProposalEnvelope(JSON.stringify(envelope))));
}

export async function fixture(context, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mitter-service-test-')));
  const root = path.join(directory, 'project');
  const dataDir = path.join(directory, 'data');
  await fs.mkdir(root);
  await fs.mkdir(dataDir);

  const store = new Store(new Database(':memory:'));
  const project = { id: 'project_1', name: 'Project', root, profiles: [], revision: 0 };
  store.saveProject(project);

  let savedWorkers = [makeWorker()];

  if (options.workers) {
    savedWorkers = options.workers;
  }

  for (const worker of savedWorkers) {
    store.saveWorker(worker);
  }

  const stoppedActors = [];
  const workflowFactory = (initial, onChange) => {
    let factory = referenceWorkflow;

    if (options.workflowFactory) {
      factory = options.workflowFactory;
    }

    const workflow = factory(initial, onChange);

    return {
      get: () => workflow.get(),
      move: (next) => workflow.move(next),
      stop: () => {
        stoppedActors.push(workflow.get());
        workflow.stop();
      },
    };
  };
  let models = {
    propose: async () => {
      throw new Error('Unexpected model inference.');
    },
    close: () => {},
  };

  if (options.models) {
    models = options.models;
  }

  if (options.beforeOpen) {
    options.beforeOpen(store);
  }

  const service = new Service(store, dataDir, workflowFactory, models, 'test workflow');
  const worker = service.workers.get('worker_1');
  const registeredProject = service.projects.get(project.id);

  if (!worker || !registeredProject) {
    throw new Error('The test task or project did not load.');
  }

  context.after(async () => {
    try {
      await service.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  return { service, store, root, dataDir, worker, project: registeredProject, stoppedActors };
}

export async function importBatch(service, worker, actions, overrides = {}) {
  const envelope = makeEnvelope(worker, actions, overrides);
  await service.handle('worker.import', {
    workerId: worker.id,
    text: JSON.stringify(envelope),
    epoch: worker.control?.epoch,
  });

  return envelope;
}

export async function runToBoundary(service, worker) {
  service.run(worker.id);
  await service.wait(worker.id);
}

export async function registerScript(service, project, root, content, id = 'script_1') {
  const filename = id + '.cjs';
  await fs.writeFile(path.join(root, filename), content);
  const profile = { id, label: id, program: process.execPath, args: [filename], timeoutMs: 5000 };
  await service.handle('project.profile', { projectId: project.id, profile });

  return profile;
}
