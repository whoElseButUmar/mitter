import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openNodeSqlite } from '../src/adapters/sqlite.js';
import { Store } from '../src/core/database.js';

export async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mitter-host-test-'));
  t.after(() =>
    fs.rm(directory, {
      recursive: true,
      force: true,
    }),
  );

  return fs.realpath(directory);
}

export function memoryStore(t) {
  const store = new Store(openNodeSqlite(':memory:'));
  t.after(() => store.close());

  return store;
}

export function projectFixture(root) {
  return {
    id: 'project',
    name: 'Fixture',
    root,
    profiles: [],
    revision: 0,
  };
}

export function workerFixture() {
  return {
    id: 'worker',
    projectId: 'project',
    name: 'Fixture task',
    goal: 'Preserve safety rules',
    checks: [],
    mode: 'handoff',
    state: 'idle',
    queue: [],
    cursor: 0,
    runId: 'run',
    iteration: 0,
    maxIterations: 10,
    maxMinutes: 10,
    startedAt: 0,
    autoCommands: false,
    observations: [],
    repeatCount: 0,
    createdAt: Date.now(),
  };
}

export function envelopeFixture(actions) {
  return {
    protocol: 'mitter/1',
    id: 'batch',
    workerId: 'worker',
    projectId: 'project',
    summary: 'Fixture edits',
    actions,
  };
}

export function deferred() {
  return Promise.withResolvers();
}

export async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}
